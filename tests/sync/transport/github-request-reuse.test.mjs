import test from "node:test";
import assert from "node:assert/strict";
import { GitHubApiTransport } from "../../../server/sync/core/github-api.mjs";

// GitHub's hourly request budget is shared with the person whose token a site
// uses, and a hosted site checks its branches every minute with a new
// transport. Later transports revalidate a branch ref with its ETag (a 304 is
// not counted) and reuse small commits and root metadata files by SHA.
const sha = (n) => String(n).padStart(40, "0");
function fakeGitHub() {
  const refs = new Map(),
    commits = new Map(),
    blobs = new Map(),
    calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace("/repos/fixture/team", ""),
      conditional = init.headers["If-None-Match"];
    calls.push({ path, conditional, token: init.headers.Authorization });
    let match;
    if ((match = /^\/git\/ref\/heads\/(.+)$/.exec(path))) {
      const head = refs.get(decodeURIComponent(match[1]));
      if (!head)
        return Response.json({ message: "Not Found" }, { status: 404 });
      const etag = `W/"${head}"`;
      if (conditional === etag) return new Response(null, { status: 304 });
      return Response.json(
        { object: { sha: head } },
        { headers: { ETag: etag } },
      );
    }
    if ((match = /^\/git\/commits\/(\w+)$/.exec(path)))
      return Response.json({
        tree: { sha: "t" + match[1] },
        parents: [],
      });
    if ((match = /^\/git\/trees\/t(\w+)$/.exec(path)))
      return Response.json({
        truncated: false,
        tree: commits.get(match[1]).map((file) => ({
          path: file.path,
          sha: file.oid,
          mode: "100644",
          type: "blob",
        })),
      });
    if ((match = /^\/git\/blobs\/(\w+)$/.exec(path)))
      return new Response(blobs.get(match[1]));
    throw new Error("Unexpected route " + path);
  };
  return { refs, commits, blobs, calls, fetch };
}
const transport = (github, options = {}) =>
  new GitHubApiTransport({
    repository: "fixture/team",
    token: "fixture-secret",
    fetch: github.fetch,
    ...options,
  });

test("a later transport revalidates a branch ref with its ETag and reuses the answer on 304", async () => {
  const github = fakeGitHub();
  github.refs.set("sync-status/site", sha(1));
  assert.equal(await transport(github).readHead("sync-status/site"), sha(1));
  assert.equal(github.calls.at(-1).conditional, undefined);
  assert.equal(await transport(github).readHead("sync-status/site"), sha(1));
  assert.equal(github.calls.at(-1).conditional, `W/"${sha(1)}"`);
  // A moved branch answers 200 with the new head, never the remembered one.
  github.refs.set("sync-status/site", sha(2));
  assert.equal(await transport(github).readHead("sync-status/site"), sha(2));
  assert.equal(await transport(github).readHead("sync-status/site"), sha(2));
  assert.equal(github.calls.at(-1).conditional, `W/"${sha(2)}"`);
  // A deleted branch is missing and forgets its ETag.
  github.refs.delete("sync-status/site");
  assert.equal(await transport(github).readHead("sync-status/site"), null);
  github.refs.set("sync-status/site", sha(3));
  assert.equal(await transport(github).readHead("sync-status/site"), sha(3));
  assert.equal(github.calls.at(-1).conditional, undefined);
  // Another token or another fetch function shares nothing.
  await transport(github, { token: "other" }).readHead("sync-status/site");
  assert.equal(github.calls.at(-1).conditional, undefined);
  const other = fakeGitHub();
  other.refs.set("sync-status/site", sha(3));
  await transport(other).readHead("sync-status/site");
  assert.equal(other.calls.at(-1).conditional, undefined);
});

test("small commits and root metadata files are reused by SHA; data commits, images and smaller limits are not", async () => {
  const github = fakeGitHub(),
    status = sha(10),
    data = sha(11);
  github.blobs.set("b1", '{"mode":"active"}');
  github.commits.set(status, [{ path: "status.json", oid: "b1" }]);
  github.blobs.set("b2", '{"protocol":1}');
  github.blobs.set("b3", "image");
  github.commits.set(data, [
    { path: "manifest.json", oid: "b2" },
    { path: "images/team/" + "a".repeat(64) + ".webp", oid: "b3" },
    ...Array.from({ length: 20 }, (_, i) => ({
      path: `events/e${i}.json`,
      oid: "b2",
    })),
  ]);
  const read = async (oid, path, options) => {
    const before = github.calls.length,
      bytes = await transport(github, options).readFile(oid, path);
    return {
      text: new TextDecoder().decode(bytes),
      bytes,
      requests: github.calls.slice(before).map((call) => call.path),
    };
  };
  const first = await read(status, "status.json");
  assert.equal(first.requests.length, 3);
  first.bytes.fill(0);
  const second = await read(status, "status.json");
  assert.deepEqual(second.requests, []);
  assert.equal(second.text, '{"mode":"active"}', "each caller gets a copy");
  // A commit listing every event and image stays with its transport, while
  // its manifest blob, fixed by SHA, is reused.
  await read(data, "manifest.json");
  const manifest = await read(data, "manifest.json");
  assert.deepEqual(manifest.requests, [
    "/git/commits/" + data,
    "/git/trees/t" + data,
  ]);
  const image = "images/team/" + "a".repeat(64) + ".webp";
  await read(data, image);
  assert.ok((await read(data, image)).requests.includes("/git/blobs/b3"));
  // A transport with a smaller byte limit still enforces it.
  await assert.rejects(
    transport(github, { maxBlobBytes: 4 }).readFile(status, "status.json"),
    (error) => error.status === 413,
  );
});
