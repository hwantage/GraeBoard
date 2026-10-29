import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { GitHubApiTransport } from "../server/sync/github-api.mjs";

test("an empty GitHub repository has no head, while other conflicts remain errors", async () => {
  let response = () =>
    Response.json({ message: "Git Repository is empty." }, { status: 409 });
  const transport = new GitHubApiTransport({
    repository: "fixture/team",
    token: "fixture",
    fetch: async () => response(),
  });
  assert.equal(await transport.readHead("main"), null);
  assert.equal(await transport.readHead(), null);
  await assert.rejects(
    transport.readCommit("a".repeat(40)),
    (error) => error.status === 409,
  );
  for (const body of [
    JSON.stringify({ message: "Another conflict" }),
    "invalid JSON",
  ]) {
    response = () => new Response(body, { status: 409 });
    await assert.rejects(transport.readHead(), (error) => error.status === 409);
  }
});

test("GitHub 429/403 abort the cycle with retry metadata and a bounded next attempt", async () => {
  for (const status of [429, 403]) {
    let calls = 0,
      now = 1700000000000;
    const transport = new GitHubApiTransport({
      repository: "fixture/team",
      token: "private-fixture-token",
      now: () => now,
      fetch: async () => {
        calls++;
        return calls === 1
          ? new Response("upstream details must not escape", {
              status,
              headers: {
                "retry-after": "120",
                "x-ratelimit-reset": "1800000000",
              },
            })
          : Response.json({ object: { sha: "a".repeat(40) } });
      },
    });
    await assert.rejects(transport.readHead(), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.retryAfter, "120");
      assert.equal(error.rateLimitReset, "1800000000");
      assert.doesNotMatch(error.message, /private-fixture|upstream/);
      return true;
    });
    assert.equal(calls, 1, "No immediate retry storm inside the transport");
    await assert.rejects(
      transport.readHead(),
      (error) => error.retryAt === now + 120000,
    );
    assert.equal(
      calls,
      1,
      "The retry deadline blocks another cycle before network I/O",
    );
    now += 120000;
    assert.equal(await transport.readHead(), "a".repeat(40));
  }
});

test("a partial blob upload never moves the ref; retry reuses immutable content and publishes only a complete tree", async () => {
  const objects = new Map(),
    trees = [],
    commits = [];
  let head = null,
    uploads = 0,
    failed = false;
  const oid = (bytes) => createHash("sha1").update(bytes).digest("hex");
  const transport = new GitHubApiTransport({
    repository: "fixture/team",
    token: "fixture",
    maxRetries: 0,
    fetch: async (url, request) => {
      const path = new URL(url).pathname.split("/repos/fixture/team")[1],
        body = request.body ? JSON.parse(request.body) : null;
      if (path === "/git/blobs") {
        uploads++;
        if (uploads === 2 && !failed) {
          failed = true;
          return new Response("", { status: 503 });
        }
        const bytes = Buffer.from(body.content, "base64"),
          sha = oid(bytes);
        objects.set(sha, bytes);
        return Response.json({ sha });
      }
      if (path === "/git/trees") {
        assert.ok(body.tree.every((entry) => objects.has(entry.sha)));
        trees.push(body);
        return Response.json({ sha: "b".repeat(40) });
      }
      if (path === "/git/commits") {
        assert.equal(trees.length, 1);
        commits.push(body);
        return Response.json({ sha: "c".repeat(40) });
      }
      if (path === "/git/refs") {
        assert.equal(commits.length, 1);
        assert.equal(body.ref, "refs/heads/sync-v1");
        head = body.sha;
        return Response.json({ object: { sha: head } });
      }
      if (path === "/git/ref/heads/sync-v1")
        return head
          ? Response.json({ object: { sha: head } })
          : new Response("", { status: 404 });
      throw new Error("Unexpected Git route " + path);
    },
  });
  const files = {
    "manifest.json": "immutable identity",
    "snapshots/genesis.json.gz": new Uint8Array([31, 139, 0]),
  };
  await assert.rejects(transport.createCandidate(null, files), /503/);
  assert.equal(await transport.readHead(), null);
  assert.equal(trees.length, 0);
  assert.equal(commits.length, 0);
  assert.equal(objects.size, 1);
  const candidate = await transport.createCandidate(null, files);
  assert.equal(await transport.readHead(), null);
  assert.equal(objects.size, 2);
  assert.deepEqual(commits[0].parents, []);
  assert.equal(await transport.publish(candidate, null), true);
  assert.equal(await transport.readHead(), candidate);
});
test("safe GitHub reads and immutable uploads retry with bounded backoff and consume request budgets; ref writes never retry blindly", async () => {
  for (const [path, method] of [
    ["/git/ref/heads/sync-v1", "GET"],
    ["/git/blobs", "POST"],
    ["/git/trees", "POST"],
    ["/git/commits", "POST"],
  ]) {
    let calls = 0;
    const waits = [];
    const transport = new GitHubApiTransport({
      repository: "fixture/team",
      token: "fixture",
      wait: async (ms) => waits.push(ms),
      fetch: async () => {
        calls++;
        if (calls === 1) throw new TypeError("offline");
        return calls === 2
          ? new Response("", { status: 503 })
          : Response.json({ sha: "a".repeat(40) });
      },
    });
    assert.deepEqual(await transport.request(path, { method }), {
      sha: "a".repeat(40),
    });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [250, 500]);
    assert.equal(transport.remaining, 597);
  }
  for (const [path, method] of [
    ["/git/refs", "POST"],
    ["/git/refs/heads/sync-v1", "PATCH"],
  ]) {
    let calls = 0;
    const transport = new GitHubApiTransport({
      repository: "fixture/team",
      token: "fixture",
      wait: async () => assert.fail("ref retry"),
      fetch: async () => {
        calls++;
        return new Response("", { status: 503 });
      },
    });
    await assert.rejects(
      transport.request(path, { method }),
      (error) => error.status === 503,
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  const transport = new GitHubApiTransport({
    repository: "fixture/team",
    token: "fixture",
    maxRequests: 2,
    wait: async () => {},
    fetch: async () => {
      calls++;
      return new Response("", { status: 503 });
    },
  });
  await assert.rejects(transport.readHead(), /budget/);
  assert.equal(calls, 2);
});
test("rate-limit resets are shared by newly created transports and isolated by credentials", async () => {
  let now = 1700000000000,
    calls = 0;
  const fetch = async () => {
    calls++;
    return calls === 1
      ? new Response("", {
          status: 429,
          headers: {
            "x-ratelimit-reset": "1700000120",
            "x-ratelimit-remaining": "0",
          },
        })
      : Response.json({ object: { sha: "a".repeat(40) } });
  };
  const make = (token = "limited") =>
    new GitHubApiTransport({
      repository: "fixture/team",
      token,
      fetch,
      now: () => now,
    });
  await assert.rejects(
    make().readHead(),
    (error) => error.retryAt === 1700000120000,
  );
  await assert.rejects(
    make().readHead(),
    (error) => error.retryAt === 1700000120000,
  );
  assert.equal(calls, 1);
  assert.equal(await make("different").readHead(), "a".repeat(40));
  now += 120000;
  assert.equal(await make().readHead(), "a".repeat(40));
  assert.equal(calls, 3);
});

test("request and streamed blob budgets fail before accepting oversized external input", async () => {
  let calls = 0;
  const budgeted = new GitHubApiTransport({
    repository: "fixture/team",
    token: "fixture",
    maxRequests: 1,
    fetch: async () => {
      calls++;
      return new Response("", { status: 404 });
    },
  });
  assert.equal(await budgeted.readHead(), null);
  await assert.rejects(budgeted.readHead(), /budget/);
  assert.equal(calls, 1);
  const bounded = new GitHubApiTransport({
    repository: "fixture/team",
    token: "fixture",
    maxBlobBytes: 4,
    fetch: async () => new Response(new Uint8Array(5)),
  });
  await assert.rejects(
    bounded.request("/git/blobs/a", { raw: true }),
    (error) => error.status === 413,
  );
});
