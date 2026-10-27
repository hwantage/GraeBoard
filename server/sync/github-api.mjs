import { fileEntries } from "./file-entries.mjs";
import { ProtocolError } from "./errors.mjs";
import { requireThat } from "../validation.mjs";
const assert = (condition, status, message) => {
  if (!condition) throw Object.assign(new Error(message), { status });
};
const enc = new TextEncoder();
export class GitHubApiTransport {
  constructor({
    repository,
    token,
    fetch: fetcher = globalThis.fetch.bind(globalThis),
    maxRequests = 600,
    maxBlobBytes = 64 * 1024 * 1024,
  }) {
    assert(
      /^[\w.-]+\/[\w.-]+$/.test(repository) && !repository.includes(".."),
      400,
      "GitHub 저장소 주소를 확인하세요.",
    );
    this.maxBlobBytes = maxBlobBytes;
    this.repository = repository;
    this.token = token;
    this.fetch = fetcher;
    this.remaining = maxRequests;
    this.commits = new Map();
    this.blobs = new Map();
  }
  async request(
    path,
    { method = "GET", body, missing = false, raw = false } = {},
  ) {
    if (--this.remaining < 0)
      throw new Error("GitHub request budget reached; resume next cycle");
    const response = await this.fetch(
      `https://api.github.com/repos/${this.repository}${path}`,
      {
        method,
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: raw
            ? "application/vnd.github.raw+json"
            : "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "GraeBoard",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      },
    );
    assert(
      response.status < 300 || response.status >= 400,
      502,
      "GitHub redirects are not allowed",
    );
    if (missing && response.status === 404) return null;
    if (
      missing &&
      method === "GET" &&
      path.startsWith("/git/ref/heads/") &&
      response.status === 409
    ) {
      // GitHub returns 409 instead of 404 before the repository's first commit.
      const failure = await response.json().catch(() => null);
      if (failure?.message === "Git Repository is empty.") return null;
    }
    if (!response.ok) {
      const error = new Error(`GitHub request failed (${response.status})`);
      error.status = response.status;
      error.retryAfter = response.headers.get("retry-after");
      error.rateLimitReset = response.headers.get("x-ratelimit-reset");
      throw error;
    }
    if (response.status === 204) return null;
    if (raw) {
      const declared = Number(response.headers.get("content-length") || 0);
      assert(
        declared <= this.maxBlobBytes,
        413,
        "Git object exceeds configured byte capacity",
      );
      const chunks = [],
        reader = response.body.getReader();
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxBlobBytes) {
          await reader.cancel();
          assert(false, 413, "Git object exceeds configured byte capacity");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }
    return response.json();
  }
  async readHead(branch = "sync-v1") {
    const ref = await this.request(
      "/git/ref/" +
        branch
          .split("/")
          .map(encodeURIComponent)
          .join("/")
          .replace(/^/, "heads/"),
      { missing: true },
    );
    return ref?.object?.sha || null;
  }
  async readCommit(oid) {
    if (this.commits.has(oid)) return this.commits.get(oid);
    assert(/^[a-f0-9]{40}$/.test(oid), 502, "잘못된 Git commit입니다.");
    const commit = await this.request("/git/commits/" + oid),
      tree = await this.request(
        "/git/trees/" + commit.tree.sha + "?recursive=1",
      );
    const files = [];
    if (tree.truncated) {
      const walk = async (sha, prefix = "") => {
        const subtree = await this.request("/git/trees/" + sha);
        for (const item of subtree.tree) {
          const path = prefix + item.path;
          if (item.type === "tree") await walk(item.sha, path + "/");
          else
            files.push({
              path,
              oid: item.sha,
              mode: item.mode,
              type: item.type,
            });
        }
      };
      await walk(commit.tree.sha);
    } else
      for (const item of tree.tree)
        if (item.type !== "tree")
          files.push({
            path: item.path,
            oid: item.sha,
            mode: item.mode,
            type: item.type,
          });
    const result = {
      oid,
      parents: commit.parents.map((p) => p.sha),
      tree: commit.tree.sha,
      files,
    };
    this.commits.set(oid, result);
    return result;
  }
  async readFile(oid, path) {
    const commit = await this.readCommit(oid),
      entry = commit.files.find((f) => f.path === path);
    if (!entry) return null;
    assert(
      entry.type === "blob" && entry.mode === "100644",
      502,
      "지원하지 않는 Git 파일입니다.",
    );
    if (this.blobs.has(entry.oid)) return this.blobs.get(entry.oid);
    const bytes = await this.request("/git/blobs/" + entry.oid, { raw: true });
    if (bytes.byteLength <= 1024 * 1024) {
      while (this.blobs.size >= 8)
        this.blobs.delete(this.blobs.keys().next().value);
      this.blobs.set(entry.oid, bytes);
    }
    return bytes;
  }
  async createCandidate(parent, files, message = "GraeBoard sync") {
    const entries = [];
    for await (const [path, value] of fileEntries(files)) {
      assert(
        !path.startsWith("/") &&
          !path.split("/").includes("..") &&
          !path.includes("\0"),
        400,
        "잘못된 Git 경로입니다.",
      );
      const bytes = typeof value === "string" ? enc.encode(value) : value;
      const blob = await this.request("/git/blobs", {
        method: "POST",
        body: {
          content: Buffer.from(bytes).toString("base64"),
          encoding: "base64",
        },
      });
      entries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const tree = await this.request("/git/trees", {
      method: "POST",
      body: {
        ...(parent ? { base_tree: (await this.readCommit(parent)).tree } : {}),
        tree: entries,
      },
    });
    const commit = await this.request("/git/commits", {
      method: "POST",
      body: { message, tree: tree.sha, parents: parent ? [parent] : [] },
    });
    return commit.sha;
  }
  async publish(candidate, parent = null, branch = "sync-v1") {
    const ref = "heads/" + branch.split("/").map(encodeURIComponent).join("/");
    try {
      if (parent)
        await this.request("/git/refs/" + ref, {
          method: "PATCH",
          body: { sha: candidate, force: false },
        });
      else
        await this.request("/git/refs", {
          method: "POST",
          body: { ref: "refs/heads/" + branch, sha: candidate },
        });
      return true;
    } catch (error) {
      if ([409, 422].includes(error.status)) {
        const head = await this.readHead(branch);
        if (head === candidate) return true;
        if (head && head !== parent) return false;
      }
      throw error;
    }
  }
  async compare(ancestor, head, limit = 1) {
    if (![ancestor, head].every((oid) => /^[a-f0-9]{40}$/.test(oid)))
      throw new ProtocolError("SYNC_FORMAT", "Invalid Git ancestry identity");
    return this.request(
      `/compare/${ancestor}...${head}?per_page=${limit}&page=1`,
    );
  }
  async verifyReachable(ancestor, head) {
    if (!ancestor || ancestor === head) return true;
    if (!head) return false;
    const result = await this.compare(ancestor, head);
    return (
      ["ahead", "identical"].includes(result.status) &&
      result.merge_base_commit?.sha === ancestor
    );
  }
  async latestSnapshot(head) {
    const commits = await this.request(
      `/commits?sha=${head}&path=snapshots&per_page=1`,
    );
    return commits[0]?.sha || null;
  }
  async readRange(head, after, limit) {
    if (head === after) return [];
    if (!after) {
      // The immutable genesis path identifies the root in one bounded request,
      // without walking a long history backwards before making progress.
      const roots = await this.request(
        `/commits?sha=${head}&path=snapshots%2Fgenesis.json.gz&per_page=1`,
      );
      if (!roots.length)
        throw new ProtocolError(
          "SYNC_HISTORY",
          "Missing synchronization genesis",
        );
      const root = await this.readCommit(roots[0].sha);
      if (root.parents.length)
        throw new ProtocolError(
          "SYNC_HISTORY",
          "Genesis was modified after publication",
        );
      return [root];
    }
    const range = await this.compare(after, head, Math.min(limit, 100));
    if (
      !["ahead", "identical"].includes(range.status) ||
      range.merge_base_commit?.sha !== after
    )
      throw new ProtocolError(
        "SYNC_HISTORY",
        "Remote history rewritten; recovery required",
      );
    const result = [];
    for (const commit of range.commits.slice(0, limit))
      result.push(await this.readCommit(commit.sha));
    return result;
  }
  async check() {
    const repo = await this.request("");
    requireThat(
      repo.private === true,
      400,
      "팀 데이터 저장소는 비공개여야 합니다.",
    );
    const branch = "graeboard-probe/" + crypto.randomUUID(),
      head = await this.readHead(repo.default_branch);
    requireThat(head, 400, "GitHub에서 README를 만들어 저장소를 초기화하세요.");
    await this.request("/git/refs", {
      method: "POST",
      body: { ref: "refs/heads/" + branch, sha: head },
    });
    try {
      await this.request("/git/refs/heads/" + branch, { method: "DELETE" });
    } catch {
      throw new Error(
        `Git 쓰기 검사는 성공했지만 probe 정리에 실패했습니다: ${branch}`,
      );
    }
    return {
      private: true,
      repositoryId: repo.id,
      repository: this.repository,
      head: await this.readHead(),
    };
  }
}
