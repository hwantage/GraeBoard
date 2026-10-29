import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { sqliteFixture, postgresFixture } from "./business-storage-fixture.mjs";
import { GitCliTransport } from "../server/sync/git-cli.mjs";
import { SyncService } from "../server/sync/service.mjs";
import {
  canonical,
  digest,
  emptyState,
  stateHash,
  entityId,
} from "../server/sync/protocol.mjs";
import { encodeSnapshot, decodeSnapshot } from "../server/sync/snapshot.mjs";
import { makeOperation } from "../server/sync/operations.mjs";
import { boundStore } from "../worker/sync-store.mjs";
import { ReportBusinessService } from "../server/storage/report-service.mjs";
import { PostgresReportRepository } from "../worker/storage/postgres-reports.mjs";
import { applicationEntities } from "../server/sync/versions.mjs";

function store(f, head, state = f.state) {
  return {
    state,
    pending: [],
    commits: [],
    link: { ...f.link, canonical_head: head, mode: "paused" },
    acquire() {
      return true;
    },
    release() {},
    readLink() {
      return this.link;
    },
    readState() {
      return this.state;
    },
    readPending() {
      return this.pending;
    },
    commitCanonical(expected, next, state, ack) {
      assert.equal(this.link.canonical_head, expected);
      this.state = state;
      this.link.canonical_head = next;
      this.pending = this.pending.filter((op) => !ack.includes(op.opId));
      this.commits.push(next);
    },
    finishImport() {
      this.link.mode = "active";
    },
    setError(error) {
      this.error = error;
    },
  };
}
async function repository(t, f) {
  const dir = mkdtempSync(join(tmpdir(), "gb-v2-transition-")),
    remote = join(dir, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transport = new GitCliTransport({
    directory: join(dir, "cache.git"),
    repository: remote,
    allowLocal: true,
  });
  const path = `snapshots/${randomUUID()}.json.gz`,
    bytes = encodeSnapshot({ state: f.state, hash: stateHash(f.state) });
  const head = await transport.createCandidate(null, {
    [path]: bytes,
    "manifest.json": canonical({
      protocol: 1,
      reducer: 1,
      teamId: f.teamId,
      repoId: f.link.repo_id,
      bootstrapId: f.link.bootstrap_id,
      genesis: path,
      genesisHash: digest(bytes),
    }),
  });
  assert.equal(await transport.publish(head, null), true);
  return { transport, head };
}

test("A3/A6 two paused peers perform one immutable v2 transition, preserve v1 backup and reject unsupported readers without advancing cursors", async (t) => {
  const f = sqliteFixture(t),
    { transport, head } = await repository(t, f),
    identity = { teamId: f.teamId, repoId: f.link.repo_id };
  const a = store(f, head),
    b = store(f, head),
    legacy = store(f, head),
    service = new SyncService({ transport, store: a, identity }),
    peer = new SyncService({ transport, store: b, identity }),
    old = new SyncService({
      transport,
      store: legacy,
      identity,
      maxProtocol: 1,
    }),
    options = {
      expectedHead: head,
      expectedHash: stateHash(f.state),
      peersStopped: true,
    };
  await assert.rejects(
    service.upgrade({ ...options, peersStopped: false }),
    (error) => error.status === 400,
  );
  const published = await service.upgrade(options);
  assert.equal(published.protocol, 2);
  assert.notEqual(published.head, head);
  assert.equal(a.link.mode, "paused");
  await assert.rejects(old.receive(legacy.link, published.head), /protocol/i);
  assert.equal(legacy.link.canonical_head, head);
  assert.equal(stateHash(legacy.state), options.expectedHash);
  const id = entityId("cell", [f.taskId, "title"]),
    previous = f.state.entities[id];
  b.pending.push(
    makeOperation({
      link: f.link,
      actorRef: f.user.id,
      before: { [id]: previous },
      after: {
        [id]: {
          ...previous,
          payload: { ...previous.payload, value: "held input" },
        },
      },
    }),
  );
  const held = canonical(b.pending);
  await assert.rejects(peer.upgrade(options), /pending\/held/);
  assert.equal(canonical(b.pending), held);
  assert.equal(b.link.canonical_head, head);
  b.pending = [];
  const received = await peer.upgrade(options);
  assert.equal(received.received, true);
  assert.equal(received.head, published.head);
  assert.equal(stateHash(a.state), stateHash(b.state));
  assert.equal(b.link.mode, "paused");
  const added = await service.verifyFiles(
      await transport.readCommit(published.head),
      head,
    ),
    event = added.find((file) => file.path.startsWith("events/")),
    envelope = JSON.parse(await transport.readFile(published.head, event.path));
  assert.equal(
    stateHash(
      decodeSnapshot(
        await transport.readFile(published.head, envelope.previousPath),
      ).state,
    ),
    options.expectedHash,
  );
  const again = await service.upgrade({
    ...options,
    expectedHead: published.head,
    expectedHash: published.stateHash,
  });
  assert.equal(again.upgraded, false);
  assert.equal(await transport.readHead(), published.head);
  a.link.mode = "active";
  await service.checkpoint();
  const fresh = store(f, null, emptyState());
  fresh.link.mode = "importing";
  const imported = new SyncService({ transport, store: fresh, identity });
  await imported.run({
    receiveOnly: true,
    updateStatus: false,
    loadCheckpoint: true,
  });
  assert.equal(stateHash(fresh.state), stateHash(a.state));
  assert.equal(fresh.link.canonical_head, await transport.readHead());
  const oldFresh = store(f, null, emptyState());
  oldFresh.link.mode = "importing";
  const oldImporter = new SyncService({
    transport,
    store: oldFresh,
    identity,
    maxProtocol: 1,
  });
  await assert.rejects(
    oldImporter.run({
      receiveOnly: true,
      updateStatus: false,
      loadCheckpoint: true,
    }),
    /protocol/i,
  );
  assert.equal(oldFresh.link.canonical_head, null);
  assert.equal(stateHash(oldFresh.state), stateHash(emptyState()));
});

test("A3/A6 actual PostgreSQL receiver validates paused transition then publishes ordinary v2 report edits", async (t) => {
  const f = await postgresFixture(t);
  if (!f) return;
  const { transport, head } = await repository(t, f),
    identity = { teamId: f.teamId, repoId: f.link.repo_id };
  await f.adapter.withTeamTransaction(f.teamId, (tx) =>
    tx.query("UPDATE team_sync_links SET canonical_head=$2 WHERE team_id=$1", [
      f.teamId,
      head,
    ]),
  );
  const node = store(f, head),
    publisher = new SyncService({ transport, store: node, identity });
  const peer = new SyncService({
    transport,
    store: boundStore(f.adapter, f.teamId),
    identity,
  });
  const options = {
    expectedHead: head,
    expectedHash: stateHash(f.state),
    peersStopped: true,
  };
  await publisher.upgrade(options);
  await peer.upgrade(options);
  assert.equal((await f.adapter.readLink(f.teamId)).mode, "paused");
  assert.equal(
    stateHash(await f.adapter.readState(f.teamId)),
    stateHash(node.state),
  );
  const reports = new ReportBusinessService(
      new PostgresReportRepository({ context: f.makeContext() }),
      f.user,
    ),
    before = await reports.read(f.reportId);
  await reports.edit(f.reportId, {
    operationId: randomUUID(),
    revision: before.revision,
    operations: [
      {
        kind: "cells",
        at: new Date().toISOString(),
        changes: [
          {
            taskId: f.taskId,
            key: "title",
            value: "PG v2 edit",
            expectedVersion: before.tasks[0].cells.title.version,
          },
        ],
      },
    ],
  });
  await f.adapter.withTeamTransaction(f.teamId, (tx) =>
    tx.query("UPDATE team_sync_links SET mode='active' WHERE team_id=$1", [
      f.teamId,
    ]),
  );
  await peer.run({ updateStatus: false });
  node.link.mode = "active";
  await publisher.run({ receiveOnly: true, updateStatus: false });
  assert.equal((await f.adapter.readPending(f.teamId)).length, 0);
  assert.equal(
    stateHash(await f.adapter.readState(f.teamId)),
    stateHash(node.state),
  );
  assert.equal(
    applicationEntities(node.state.entities)[entityId("report", [f.reportId])]
      .payload.data.tasks[0].cells.title.value,
    "PG v2 edit",
  );
  assert.equal(
    node.state.entities[entityId("cell", [f.taskId, "title"])].payload.value,
    "initial",
  );
});
