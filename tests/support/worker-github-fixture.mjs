import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export function githubEmulator(directory) {
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@local",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@local",
  };
  const git = (args, { input, index } = {}) =>
    execFileSync("git", ["-C", directory, ...args], {
      input,
      env: { ...environment, ...(index ? { GIT_INDEX_FILE: index } : {}) },
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  const text = (args, options) => git(args, options).toString().trim(),
    head = (ref) => {
      try {
        return text(["rev-parse", "--verify", ref]);
      } catch {
        return null;
      }
    };
  let loseNextPublish = false;
  const calls = [],
    unexpectedCalls = [];
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.github.com");
    assert.equal(init.headers.Authorization, "Bearer fixture-secret");
    const path = decodeURIComponent(
        parsed.pathname.replace("/repos/fixture/team", ""),
      ),
      method = init.method || "GET",
      body = init.body && JSON.parse(init.body);
    calls.push({ path, method });
    if (!path)
      return Response.json({ private: true, id: 1, default_branch: "main" });
    if (path.startsWith("/compare/")) {
      const [base, target] = path.slice(9).split("...");
      let merge;
      try {
        merge = text(["merge-base", base, target]);
      } catch {
        return Response.json({}, { status: 404 });
      }
      const hashes = text(["rev-list", "--reverse", `${base}..${target}`])
          .split("\n")
          .filter(Boolean),
        size = Number(parsed.searchParams.get("per_page") || 30),
        page = Number(parsed.searchParams.get("page") || 1);
      return Response.json({
        status:
          base === target
            ? "identical"
            : merge === base
              ? "ahead"
              : merge === target
                ? "behind"
                : "diverged",
        merge_base_commit: { sha: merge },
        total_commits: hashes.length,
        commits: hashes.slice((page - 1) * size, page * size).map((sha) => ({
          sha,
          parents: text(["show", "-s", "--format=%P", sha])
            .split(" ")
            .filter(Boolean)
            .map((sha) => ({ sha })),
        })),
      });
    }
    if (path === "/commits") {
      const args = [
        "log",
        "--format=%H",
        `--max-count=${Number(parsed.searchParams.get("per_page") || 30)}`,
        parsed.searchParams.get("sha") || "main",
      ];
      if (parsed.searchParams.has("path"))
        args.push("--", parsed.searchParams.get("path"));
      return Response.json(
        text(args)
          .split("\n")
          .filter(Boolean)
          .map((sha) => ({ sha })),
      );
    }
    if (path.startsWith("/git/ref/")) {
      const oid = head("refs/" + path.slice(9));
      return oid
        ? Response.json({ object: { sha: oid } })
        : Response.json({}, { status: 404 });
    }
    if (path === "/git/blobs" && method === "POST")
      return Response.json({
        sha: text(["hash-object", "-w", "--stdin"], {
          input: Buffer.from(body.content, "base64"),
        }),
      });
    if (path.startsWith("/git/blobs/"))
      return new Response(git(["cat-file", "blob", path.slice(11)]));
    if (path === "/git/trees" && method === "POST") {
      const index = join(directory, "index-" + randomUUID());
      try {
        text(
          body.base_tree
            ? ["read-tree", body.base_tree]
            : ["read-tree", "--empty"],
          { index },
        );
        for (const entry of body.tree)
          text(
            [
              "update-index",
              "--add",
              "--cacheinfo",
              `${entry.mode},${entry.sha},${entry.path}`,
            ],
            { index },
          );
        return Response.json({ sha: text(["write-tree"], { index }) });
      } finally {
        rmSync(index, { force: true });
      }
    }
    if (path.startsWith("/git/trees/"))
      return Response.json({
        truncated: false,
        tree: text([
          "ls-tree",
          ...(parsed.searchParams.get("recursive") ? ["-r"] : []),
          path.slice(11),
        ])
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [info, path] = line.split("\t"),
              [mode, type, sha] = info.split(" ");
            return { mode, type, sha, path };
          }),
      });
    if (path === "/git/commits" && method === "POST")
      return Response.json({
        sha: text([
          "commit-tree",
          body.tree,
          ...body.parents.flatMap((id) => ["-p", id]),
          "-m",
          body.message,
        ]),
      });
    if (path.startsWith("/git/commits/")) {
      const [tree, parents] = text([
        "show",
        "-s",
        "--format=%T%n%P",
        path.slice(13),
      ]).split("\n");
      return Response.json({
        tree: { sha: tree },
        parents: (parents || "")
          .split(" ")
          .filter(Boolean)
          .map((sha) => ({ sha })),
      });
    }
    if (path === "/git/refs" && method === "POST") {
      if (head(body.ref)) return Response.json({}, { status: 422 });
      text(["update-ref", body.ref, body.sha, "0".repeat(40)]);
      return Response.json({ object: { sha: body.sha } });
    }
    if (path.startsWith("/git/refs/")) {
      const ref = "refs/" + path.slice(10),
        old = head(ref);
      if (method === "DELETE") {
        text(["update-ref", "-d", ref]);
        return new Response(null, { status: 204 });
      }
      assert.equal(body.force, false);
      if (!old) return Response.json({}, { status: 404 });
      try {
        git(["merge-base", "--is-ancestor", old, body.sha]);
        text(["update-ref", ref, body.sha, old]);
      } catch {
        return Response.json({}, { status: 422 });
      }
      if (loseNextPublish && ref === "refs/heads/sync-v1") {
        loseNextPublish = false;
        throw new TypeError("fixture lost response after accepted ref");
      }
      return Response.json({ object: { sha: body.sha } });
    }
    unexpectedCalls.push({ method, path });
    throw new Error("Unexpected GitHub API " + method + " " + path);
  };
  return {
    fetch: fetcher,
    calls,
    unexpectedCalls,
    loseNext() {
      loseNextPublish = true;
    },
    git,
    text,
  };
}
export const bucket = () => {
  const objects = new Map();
  return {
    objects,
    head: async (key) => (objects.has(key) ? {} : null),
    list: async () => ({
      objects: [...objects].map(([key, data]) => ({
        key,
        size: data.length,
        uploaded: new Date(Date.now() - 2 * 86400000),
      })),
      truncated: false,
    }),
    get: async (key) =>
      objects.has(key)
        ? {
            body: objects.get(key),
            arrayBuffer: async () => Uint8Array.from(objects.get(key)).buffer,
          }
        : null,
    put: async (key, bytes) => objects.set(key, Buffer.from(bytes)),
    delete: async (key) => objects.delete(key),
  };
};
