import { fileEntries } from "./file-entries.mjs";
import { ProtocolError } from "./errors.mjs";
import { GitHubApiTransport } from "./github-api.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, delimiter, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
export function repositoryUrl(value) {
  const match =
    /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      value || "",
    );
  if (!match || match.slice(1).some((x) => x === "." || x === ".."))
    throw new Error("Use a GitHub owner/private-repository");
  return `https://github.com/${match[1]}/${match[2]}`;
}
export class GitCliTransport {
  constructor({
    directory,
    repository,
    token,
    allowLocal = false,
    localTimeoutMs = 30000,
    networkTimeoutMs = 300000,
  }) {
    this.directory = resolve(directory);
    this.repository = allowLocal
      ? resolve(repository)
      : repositoryUrl(repository);
    this.token = token;
    this.ready = null;
    this.localTimeoutMs = localTimeoutMs;
    this.networkTimeoutMs = networkTimeoutMs;
  }
  async init() {
    if (!this.ready)
      this.ready = (async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await exec("git", ["init", "--bare", this.directory]);
        await this.git(["config", "remote.origin.url", this.repository]);
        await this.git(["config", "core.hooksPath", "/dev/null"]);
        const helper = join(this.directory, "graeboard-askpass.cjs");
        await writeFile(
          helper,
          '#!/usr/bin/env node\nprocess.stdout.write(process.argv[2]?.toLowerCase().includes("username")?"x-access-token":process.env.GRAEBOARD_GIT_TOKEN||"")\n',
          { mode: 0o700 },
        );
      })();
    return this.ready;
  }
  async git(args, { input, index } = {}) {
    const network = ["fetch", "push", "ls-remote"].includes(args[0]);
    const timeout = network ? this.networkTimeoutMs : this.localTimeoutMs;
    const env = {
      PATH: dirname(process.execPath) + delimiter + (process.env.PATH || ""),
      LANG: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ASKPASS: join(this.directory, "graeboard-askpass.cjs"),
      GRAEBOARD_GIT_TOKEN: this.token || "",
      GIT_AUTHOR_NAME: "GraeBoard",
      GIT_AUTHOR_EMAIL: "sync@invalid.local",
      GIT_COMMITTER_NAME: "GraeBoard",
      GIT_COMMITTER_EMAIL: "sync@invalid.local",
      ...(index ? { GIT_INDEX_FILE: index } : {}),
    };
    try {
      if (input !== undefined)
        return await new Promise((resolve, reject) => {
          const child = execFile(
            "git",
            [
              "-C",
              this.directory,
              "-c",
              "http.followRedirects=false",
              "-c",
              "http.lowSpeedLimit=1",
              "-c",
              "http.lowSpeedTime=120",
              ...args,
            ],
            {
              env,
              timeout,
              maxBuffer: 128 * 1024 * 1024,
              encoding: "buffer",
            },
            (error, stdout) =>
              error
                ? reject(new Error("Git operation failed (" + error.code + ")"))
                : resolve(stdout),
          );
          child.stdin.end(input);
        });
      return (
        await exec(
          "git",
          [
            "-C",
            this.directory,
            "-c",
            "http.followRedirects=false",
            "-c",
            "http.lowSpeedLimit=1",
            "-c",
            "http.lowSpeedTime=120",
            ...args,
          ],
          {
            env,
            timeout,
            maxBuffer: 128 * 1024 * 1024,
            encoding: "buffer",
          },
        )
      ).stdout;
    } catch (error) {
      throw Object.assign(
        new Error("Git operation failed (" + (error.code || "network") + ")"),
        { code: error.code },
      );
    }
  }
  async readHead(branch = "sync-v1") {
    await this.init();
    if (
      !/^(sync-v1|sync-(?:status|directory|setup|setup-status)\/[a-zA-Z0-9-]+)$/.test(
        branch,
      )
    )
      throw new Error("Invalid sync branch");
    const refs = (
      await this.git(["ls-remote", "--heads", "origin", "refs/heads/" + branch])
    )
      .toString()
      .trim();
    if (!refs) return null;
    await this.git([
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    return refs.split(/\s/)[0];
  }
  async readCommit(oid) {
    await this.init();
    const parts = (await this.git(["show", "-s", "--format=%T%n%P", oid]))
      .toString()
      .trim()
      .split("\n");
    const files = (await this.git(["ls-tree", "-r", "-z", oid]))
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [info, path] = line.split("\t");
        const [mode, type, oid] = info.split(" ");
        return { path, oid, mode, type };
      });
    return {
      oid,
      tree: parts[0],
      parents: parts[1]?.split(" ").filter(Boolean) || [],
      files,
    };
  }
  async readFile(oid, path) {
    if (
      !/^(manifest\.json|events\/[a-zA-Z0-9-]+\.json|snapshots\/[a-zA-Z0-9-]+\.json(?:\.gz)?|objects\/[a-f0-9]{64}|images\/[a-zA-Z0-9-]+\/[a-f0-9]{64}\.webp|status\.json|directory\.json|keys\.json)$/.test(
        path,
      )
    )
      throw new Error("Invalid sync object path");
    return this.git(["show", `${oid}:${path}`]);
  }
  async createCandidate(parent, files, message = "GraeBoard sync") {
    await this.init();
    const index = join(this.directory, "index-" + randomUUID());
    try {
      if (parent) await this.git(["read-tree", parent], { index });
      else await this.git(["read-tree", "--empty"], { index });
      for await (const [path, data] of fileEntries(files)) {
        if (!/^[a-zA-Z0-9/_.-]+$/.test(path) || path.split("/").includes(".."))
          throw new Error("Invalid candidate path");
        const oid = (
          await this.git(["hash-object", "-w", "--stdin"], { input: data })
        )
          .toString()
          .trim();
        await this.git(
          ["update-index", "--add", "--cacheinfo", `100644,${oid},${path}`],
          { index },
        );
      }
      const tree = (await this.git(["write-tree"], { index }))
        .toString()
        .trim();
      return (
        await this.git([
          "commit-tree",
          tree,
          ...(parent ? ["-p", parent] : []),
          "-m",
          message,
        ])
      )
        .toString()
        .trim();
    } finally {
      await rm(index, { force: true });
    }
  }
  async publish(candidate, parent = null, branch = "sync-v1") {
    await this.init();
    try {
      await this.git([
        "push",
        "--porcelain",
        "origin",
        `${candidate}:refs/heads/${branch}`,
      ]);
      return true;
    } catch (error) {
      const current = await this.readHead(branch);
      if (current && current !== parent) return false;
      throw error;
    }
  }
  async check() {
    if (this.repository.startsWith("/"))
      return { head: await this.readHead(), fixture: true };
    const repository = this.repository.replace("https://github.com/", "");
    return new GitHubApiTransport({ repository, token: this.token }).check();
  }
  async latestSnapshot(head) {
    return (
      (await this.git(["log", "-1", "--format=%H", head, "--", "snapshots"]))
        .toString()
        .trim() || null
    );
  }
  async readRange(head, after, limit) {
    if (head === after) return [];
    if (after && !(await this.verifyReachable(after, head)))
      throw new ProtocolError(
        "SYNC_HISTORY",
        "Remote history rewritten; recovery required",
      );
    // rev-list is one local subprocess. --max-count before --reverse would
    // select the newest commits, so select the earliest lines after reversal.
    const ids = (
      await this.git([
        "rev-list",
        "--reverse",
        after ? `${after}..${head}` : head,
      ])
    )
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(0, limit);
    const commits = [];
    for (const oid of ids) commits.push(await this.readCommit(oid));
    return commits;
  }
  async verifyReachable(ancestor, head) {
    if (!ancestor) return true;
    try {
      await this.git(["merge-base", "--is-ancestor", ancestor, head]);
      return true;
    } catch (error) {
      if (error.code === 1) return false;
      throw error;
    }
  }
}
