import { fileEntries } from "../server/sync/file-entries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SyncService } from "../server/sync/service.mjs";
import { GitHubApiTransport } from "../server/sync/github-api.mjs";
import {
  canonical,
  digest,
  emptyState,
  stateHash,
} from "../server/sync/protocol.mjs";
import { reduceMany } from "../server/sync/reducer.mjs";
import { encodeSnapshot } from "../server/sync/snapshot.mjs";
import { ProtocolError } from "../server/sync/errors.mjs";
import { boundedTransport, assertStateCapacity } from "../worker/capacity.mjs";
import { SYNC_FILE_MAX_BYTES } from "../shared/sync-limits.js";
const identity = { teamId: "team", repoId: "repo" };
const sha = (value) => createHash("sha1").update(value).digest("hex");
class Repository {
  commits = new Map();
  blobs = new Map();
  head = null;
  calls = [];
  refs = new Map();
  async createCandidate(parent, files) {
    const tree = new Map(
      parent ? this.commits.get(parent).files.map((f) => [f.path, f]) : [],
    );
    for await (const [path, value] of fileEntries(files)) {
      const bytes = typeof value === "string" ? Buffer.from(value) : value,
        oid = sha(bytes);
      this.blobs.set(oid, bytes);
      tree.set(path, { path, oid, type: "blob", mode: "100644" });
    }
    const entries = [...tree.values()],
      treeId = sha(canonical(entries)),
      oid = sha(canonical([parent, treeId]));
    this.commits.set(oid, {
      oid,
      parents: parent ? [parent] : [],
      files: entries,
      tree: treeId,
    });
    return oid;
  }
  async publish(oid, parent, branch = "sync-v1") {
    if ((await this.readHead(branch)) !== parent) return false;
    if (branch === "sync-v1") this.head = oid;
    else this.refs.set(branch, oid);
    return true;
  }
  async readHead(branch = "sync-v1") {
    return branch === "sync-v1" ? this.head : this.refs.get(branch) || null;
  }
  async readCommit(oid) {
    return this.commits.get(oid);
  }
  async readFile(oid, path) {
    const f = this.commits.get(oid).files.find((f) => f.path === path);
    return f ? this.blobs.get(f.oid) : null;
  }
  lineage(head = this.head) {
    const result = [];
    while (head) {
      result.push(head);
      head = this.commits.get(head)?.parents[0];
    }
    return result.reverse();
  }
  async verifyReachable(ancestor, head) {
    return !ancestor || this.lineage(head).includes(ancestor);
  }
  async readRange(head, after, limit) {
    const ids = this.lineage(head),
      index = after ? ids.indexOf(after) : -1;
    if (after && index < 0)
      throw new ProtocolError("SYNC_HISTORY", "rewritten");
    return ids
      .slice(index + 1, index + 1 + limit)
      .map((oid) => this.commits.get(oid));
  }
  async latestSnapshot(head) {
    return this.lineage(head)
      .reverse()
      .find((oid) => {
        const c = this.commits.get(oid),
          p = c.parents[0] && this.commits.get(c.parents[0]);
        return c.files.some(
          (f) =>
            f.path.startsWith("snapshots/") &&
            !p?.files.some((old) => old.path === f.path),
        );
      });
  }
  fetch = async (url) => {
    const u = new URL(url),
      p = u.pathname.replace("/repos/fixture/team", "");
    this.calls.push(p + u.search);
    if (p === "/git/ref/heads/sync-v1")
      return Response.json({ object: { sha: this.head } });
    if (p.startsWith("/compare/")) {
      const [base, head] = p.slice(9).split("..."),
        ids = this.lineage(head),
        i = ids.indexOf(base),
        limit = Number(u.searchParams.get("per_page"));
      return Response.json({
        status: i < 0 ? "diverged" : base === head ? "identical" : "ahead",
        merge_base_commit: { sha: i < 0 ? ids[0] : base },
        commits: ids.slice(i + 1, i + 1 + limit).map((sha) => ({ sha })),
      });
    }
    if (p === "/commits") {
      const head = u.searchParams.get("sha"),
        path = u.searchParams.get("path");
      const id =
        path === "snapshots"
          ? await this.latestSnapshot(head)
          : this.lineage(head)[0];
      return Response.json([{ sha: id }]);
    }
    if (p.startsWith("/git/commits/")) {
      const c = this.commits.get(p.slice(13));
      return Response.json({
        tree: { sha: c.tree },
        parents: c.parents.map((sha) => ({ sha })),
      });
    }
    if (p.startsWith("/git/trees/")) {
      const c = [...this.commits.values()].find((c) => c.tree === p.slice(11));
      return Response.json({
        truncated: false,
        tree: c.files.map((f) => ({ ...f, sha: f.oid })),
      });
    }
    if (p.startsWith("/git/blobs/"))
      return new Response(this.blobs.get(p.slice(11)));
    throw new Error("Unexpected route " + p);
  };
}
function store(
  state = emptyState(),
  head = null,
  mode = "active",
  pending = [],
) {
  return {
    state,
    pending,
    exclusions: [{ kind: "document", key: "local-hidden" }],
    commits: [],
    link: {
      canonical_head: head,
      mode,
      bootstrap_id: "boot",
      installation_id: "site",
      writer_epoch: "epoch",
    },
    async acquire() {
      return true;
    },
    async release() {},
    async readLink() {
      return { ...this.link };
    },
    async readState() {
      return this.state;
    },
    async readPending() {
      return this.pending;
    },
    async setError(e) {
      this.error = e;
    },
    async commitCanonical(expected, head, state, ack) {
      assert.equal(this.link.canonical_head, expected);
      this.state = state;
      this.pending = this.pending.filter((op) => !ack.includes(op.opId));
      this.link.canonical_head = head;
      this.commits.push(head);
    },
    async finishImport(head) {
      assert.equal(head, this.link.canonical_head);
      this.link.mode = "active";
    },
  };
}
async function fixture(count = 5) {
  const repo = new Repository();
  let state = emptyState();
  const bytes = encodeSnapshot({ state, hash: stateHash(state) });
  repo.head = await repo.createCandidate(null, {
    "manifest.json": canonical({
      protocol: 1,
      reducer: 1,
      ...identity,
      bootstrapId: "boot",
      genesis: "snapshots/genesis.json.gz",
      genesisHash: digest(bytes),
    }),
    "snapshots/genesis.json.gz": bytes,
  });
  const genesis = repo.head,
    states = new Map([[genesis, state]]);
  for (let i = 0; i < count; i++) {
    const op = {
      protocol: 1,
      reducer: 1,
      ...identity,
      opId: "op-" + i,
      writerEpoch: "epoch",
      actorRef: "person",
      createdAt: "2026-01-01T00:00:00.000Z",
      dependsOn: [],
      objects: [],
      changes: [
        {
          entity: "person",
          key: ["p" + i],
          generation: "g" + i,
          baseVersion: null,
          base: null,
          desired: { name: "Person " + i },
          action: "create",
          fields: ["name"],
        },
      ],
    };
    state = reduceMany(state, [op], identity);
    const parent = repo.head;
    repo.head = await repo.createCandidate(parent, {
      ["events/op-" + i + ".json"]: canonical({
        protocol: 1,
        kind: "operations",
        parent,
        operations: [op],
        resultHash: stateHash(state),
      }),
    });
    states.set(repo.head, state);
  }
  return { repo, state, genesis, states };
}
test("checkpoint CAS rejection returns 409, keeps C/P intact and releases the lease for a successful retry", async () => {
  const { repo, state } = await fixture(2),
    head = repo.head;
  const local = store(state, head, "active", [{ opId: "preserved-pending" }]);
  let released = 0;
  local.release = async () => {
    released++;
  };
  const publish = repo.publish.bind(repo);
  repo.publish = async () => false;
  const service = new SyncService({ transport: repo, store: local, identity });
  await assert.rejects(
    service.checkpoint(),
    (error) =>
      error.status === 409 && error.code === "SYNC_PUBLICATION_CONFLICT",
  );
  assert.equal(released, 1);
  assert.equal(repo.head, head);
  assert.equal(local.link.canonical_head, head);
  assert.equal(stateHash(local.state), stateHash(state));
  assert.deepEqual(local.pending, [{ opId: "preserved-pending" }]);
  repo.publish = publish;
  await service.checkpoint();
  assert.notEqual(repo.head, head);
  assert.equal(local.link.canonical_head, repo.head);
  assert.deepEqual(local.pending, [{ opId: "preserved-pending" }]);
});
test("malformed peer Git revisions never reach ancestry verification or mark status verified", async () => {
  const { repo, state } = await fixture(1),
    local = store(state, repo.head);
  const service = new SyncService({
    transport: repo,
    store: local,
    identity: { ...identity, peerInstallationId: "peer" },
  });
  let verified = 0,
    saved;
  repo.verifyReachable = async () => {
    verified++;
    return true;
  };
  local.saveRemoteStatus = async (value) => {
    saved = value;
  };
  for (const revision of [":/operations", "--all", "short", 1, null]) {
    const branch = "sync-status/peer",
      parent = await repo.readHead(branch);
    const oid = await repo.createCandidate(parent, {
      "status.json": canonical({
        ...identity,
        installationId: "peer",
        writerEpoch: "epoch",
        mode: "active",
        appliedCanonicalHead: revision,
        observedAt: new Date().toISOString(),
      }),
    });
    await repo.publish(oid, parent, branch);
    await service.status(local.link);
    assert.equal(saved.verified, false);
  }
  assert.equal(verified, 0);
});
test("multi-megabyte pending commands split into receiver-safe events and converge through the external bounded transport", async () => {
  const { repo, genesis } = await fixture(0);
  const ops = [];
  for (let i = 0; i < 3; i++) {
    const payload = {
      title: "Large memo",
      position: 0,
      markdown: String(i).repeat(200 * 1024),
    };
    const base = i
      ? { ...payload, markdown: String(i - 1).repeat(200 * 1024) }
      : null;
    ops.push({
      protocol: 1,
      reducer: 1,
      ...identity,
      opId: "large-" + i,
      writerEpoch: "epoch",
      actorRef: "person",
      createdAt: "2026-01-01T00:00:00.000Z",
      dependsOn: i ? ["large-" + (i - 1)] : [],
      objects: [],
      changes: Array.from({ length: 7 }, (_, n) => ({
        entity: "document",
        key: ["annual", "2026", "doc-" + n],
        generation: "g-" + n,
        baseVersion: i ? `large-${i - 1}:${n}` : null,
        base,
        desired: payload,
        action: i ? "edit" : "create",
        fields: ["title", "position", "markdown"],
      })),
    });
  }
  const local = store(emptyState(), genesis, "active", ops);
  const publisher = new SyncService({
    transport: repo,
    store: local,
    identity,
  });
  for (let cycle = 0; local.pending.length && cycle < 3; cycle++)
    await publisher.run({ updateStatus: false });
  const events = [...repo.commits.values()].flatMap((commit) =>
    commit.files.filter((file) => file.path.startsWith("events/")),
  );
  assert.ok(
    new Set(events.map((file) => file.oid)).size >= 2,
    "the old 64 MiB publisher would send one oversize event",
  );
  for (const event of events)
    assert.ok(repo.blobs.get(event.oid).byteLength <= SYNC_FILE_MAX_BYTES);
  const external = store(emptyState(), genesis);
  await new SyncService({
    transport: boundedTransport(repo),
    store: external,
    identity,
  }).run({ receiveOnly: true, updateStatus: false });
  assert.equal(external.link.canonical_head, repo.head);
  assert.equal(stateHash(external.state), stateHash(local.state));
  assertStateCapacity(external.state);
  assert.equal(local.pending.length, 0);
});
test("350 missed commits advance in bounded REST cycles and old peer ancestry costs one comparison", async () => {
  const { repo, state, genesis } = await fixture(350),
    local = store(emptyState(), genesis);
  let cycles = 0,
    maxRequests = 0;
  while (local.link.canonical_head !== repo.head) {
    const before = repo.calls.length,
      transport = new GitHubApiTransport({
        repository: "fixture/team",
        token: "test",
        fetch: repo.fetch,
        maxRequests: 40,
      });
    await new SyncService({
      transport,
      store: local,
      identity,
      maxCommits: 4,
    }).run({ receiveOnly: true, updateStatus: false });
    const requests = repo.calls.length - before;
    maxRequests = Math.max(maxRequests, requests);
    assert.ok(requests <= 24, `cycle used ${requests} requests`);
    assert.ok(++cycles <= 88);
  }
  assert.equal(cycles, 88);
  assert.equal(stateHash(local.state), stateHash(state));
  assert.ok(maxRequests < 40);
  const transport = new GitHubApiTransport({
    repository: "fixture/team",
    token: "test",
    fetch: repo.fetch,
  });
  const n = repo.calls.length;
  assert.equal(await transport.verifyReachable(repo.head, genesis), false);
  assert.equal(repo.calls.length - n, 1);
});
test("verified checkpoint loads new site and explicit recovery, preserving unacknowledged P and L, then replays tail", async () => {
  const { repo, state, genesis } = await fixture(30),
    publisher = store(state, repo.head),
    svc = new SyncService({ transport: repo, store: publisher, identity });
  await svc.checkpoint();
  const checkpoint = repo.head;
  const tail = {
    protocol: 1,
    reducer: 1,
    ...identity,
    opId: "tail",
    writerEpoch: "epoch",
    actorRef: "person",
    createdAt: "2026-01-01T00:00:00.000Z",
    dependsOn: [],
    objects: [],
    changes: [
      {
        entity: "person",
        key: ["tail"],
        generation: "g-tail",
        baseVersion: null,
        base: null,
        desired: { name: "After snapshot" },
        action: "create",
        fields: ["name"],
      },
    ],
  };
  const finalState = reduceMany(state, [tail], identity);
  repo.head = await repo.createCandidate(checkpoint, {
    "events/tail.json": canonical({
      protocol: 1,
      kind: "operations",
      parent: checkpoint,
      operations: [tail],
      resultHash: stateHash(finalState),
    }),
  });
  const localPending = {
    protocol: 1,
    reducer: 1,
    ...identity,
    opId: "local",
    writerEpoch: "local-epoch",
    actorRef: "person",
    createdAt: "2026-01-01T00:00:00.000Z",
    dependsOn: [],
    objects: [],
    changes: [
      {
        entity: "person",
        key: ["local"],
        generation: "g-local",
        baseVersion: null,
        base: null,
        desired: { name: "Local" },
        action: "create",
        fields: ["name"],
      },
    ],
  };
  for (const [head, mode, explicit] of [
    [null, "importing", false],
    [genesis, "recovery", true],
  ]) {
    const local = store(emptyState(), head, mode, [localPending]),
      L = canonical(local.exclusions);
    const transport = new GitHubApiTransport({
      repository: "fixture/team",
      token: "test",
      fetch: repo.fetch,
      maxRequests: 40,
    });
    const service = new SyncService({
      transport,
      store: local,
      identity,
      maxCommits: 4,
    });
    await service.run({
      receiveOnly: true,
      updateStatus: false,
      loadCheckpoint: explicit,
    });
    assert.deepEqual(local.commits, [checkpoint, repo.head]);
    assert.equal(stateHash(local.state), stateHash(finalState));
    assert.deepEqual(local.pending, [localPending]);
    assert.equal(canonical(local.exclusions), L);
    assert.equal(local.link.mode, mode === "importing" ? "active" : "recovery");
  }
  const active = store(emptyState(), genesis);
  await new SyncService({
    transport: repo,
    store: active,
    identity,
    maxCommits: 4,
  }).run({ receiveOnly: true, updateStatus: false });
  assert.equal(active.commits.length, 4);
  assert.notEqual(
    active.link.canonical_head,
    checkpoint,
    "healthy site never skips the prefix",
  );
});
test("tampered checkpoint metadata/state, incompatible history, pending hash and missing image preserve last C/P/L", async () => {
  for (const fault of [
    "hash",
    "state",
    "counts",
    "identity",
    "parent",
    "receipt",
    "moved",
    "foreign",
    "image",
  ]) {
    const { repo, state, genesis } = await fixture(4),
      publisher = store(state, repo.head);
    await new SyncService({
      transport: repo,
      store: publisher,
      identity,
    }).checkpoint();
    const pinned = repo.head;
    const checkpoint = repo.commits.get(pinned),
      event = checkpoint.files.find(
        (f) =>
          f.path.startsWith("events/") &&
          !repo.commits
            .get(checkpoint.parents[0])
            .files.some((p) => p.path === f.path),
      );
    const env = JSON.parse(Buffer.from(repo.blobs.get(event.oid)));
    if (fault === "state") {
      const file = checkpoint.files.find((f) => f.path === env.path),
        changed = structuredClone(state);
      Object.values(changed.entities)[0].payload.name = "tampered";
      const bytes = encodeSnapshot({ atCommit: env.parent, state: changed });
      repo.blobs.set(file.oid, bytes);
      env.snapshotHash = digest(bytes);
    }
    if (fault === "hash") env.snapshotHash = "0".repeat(64);
    if (fault === "counts") env.counts.entities++;
    if (fault === "identity") env.teamId = "foreign";
    if (fault === "parent") env.atCommit = genesis;
    if (["hash", "state", "counts", "identity", "parent"].includes(fault))
      repo.blobs.set(event.oid, Buffer.from(canonical(env)));
    const foreign =
      fault === "foreign"
        ? await repo.createCandidate(null, { "manifest.json": "{}" })
        : genesis;
    const local = store(
        emptyState(),
        foreign,
        "recovery",
        fault === "receipt" ? [{ opId: "op-0", changed: true }] : [],
      ),
      before = canonical([
        local.state,
        local.pending,
        local.exclusions,
        local.link.canonical_head,
      ]);
    if (fault === "moved") repo.readHead = async () => null;
    const images =
      fault === "image"
        ? {
            receive() {
              throw new ProtocolError(
                "SYNC_INTEGRITY",
                "Missing required image",
              );
            },
          }
        : undefined;
    const service = new SyncService({
      transport: repo,
      store: local,
      identity,
      images,
    });
    await assert.rejects(
      service.run({
        receiveOnly: true,
        updateStatus: false,
        loadCheckpoint: true,
        observedHead: pinned,
      }),
      (e) => e.code?.startsWith("SYNC_"),
    );
    assert.equal(
      canonical([
        local.state,
        local.pending,
        local.exclusions,
        local.link.canonical_head,
      ]),
      before,
      fault,
    );
    assert.equal(local.commits.length, 0);
  }
});
