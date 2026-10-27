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
    let calls = 0;
    const transport = new GitHubApiTransport({
      repository: "fixture/team",
      token: "private-fixture-token",
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
