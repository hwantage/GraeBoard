import { transaction } from "../db.mjs";
import { materialize } from "./entities.mjs";
import { assertSnapshotGuard } from "./node-background.mjs";
import { SyncInterruption } from "./errors.mjs";

export function createNodeMutationBridge({
  db,
  store,
  capture,
  notify,
  installationId,
  isStopped,
  recordError,
}) {
  const handlers = {
    acquire: ({ raw, owner }) => raw.acquire(owner),
    release: ({ raw, owner }) => raw.release(owner),
    error: ({ teamId, data }) => recordError(teamId, data),
    "finish-import": ({ teamId, data }) => {
      db.prepare(
        "UPDATE team_sync_links SET mode='active' WHERE team_id=? AND mode='importing' AND canonical_head=?",
      ).run(teamId, data.head);
      capture.refresh();
    },
    status: ({ teamId, data }) => {
      db.prepare(
        "UPDATE team_sync_links SET remote_status=? WHERE team_id=?",
      ).run(data.serialized, teamId);
    },
    bootstrap: ({ teamId, data, link }) => {
      if (link.bootstrap_id !== data.guard.bootstrapId)
        throw new Error("Bootstrap identity changed");
      if (!link.bootstrap_bundle && !link.canonical_head)
        db.prepare(
          "UPDATE team_sync_links SET bootstrap_bundle=? WHERE team_id=? AND bootstrap_bundle IS NULL",
        ).run(data.bundleJson, teamId);
    },
    "bootstrap-candidate": ({ teamId, data, link }) => {
      if (!link.canonical_head)
        db.prepare(
          "UPDATE team_sync_links SET bootstrap_bundle=? WHERE team_id=?",
        ).run(data.bundleJson, teamId);
    },
    commit,
  };
  async function commit({ raw, teamId, owner, data, link, upgrading }) {
    if (
      upgrading &&
      db
        .prepare(
          "SELECT 1 FROM site_maintenance_jobs WHERE team_id=? AND phase NOT IN ('complete','cancelled')",
        )
        .get(teamId)
    )
      throw new SyncInterruption(
        "정리·백업 작업이 시작되어 형식 전환의 로컬 반영을 중단했습니다.",
      );
    const { prepared, newHead, expectedHead, ackOpIds } = data;
    let changed = [];
    // A new connection has no published C cursor yet. Stage its immutable
    // genesis rows in short transactions; interrupted staging is harmless and
    // revalidated against the same frozen B0 on the next attempt. Domain rows,
    // receipts, ACK and the visible head still change in one final transaction.
    if (expectedHead === null && prepared.patch.entities.length > 1000) {
      for (
        let offset = 0;
        offset < prepared.patch.entities.length;
        offset += 1000
      ) {
        if (isStopped()) throw new SyncInterruption();
        capture.without(() =>
          transaction(db, () => {
            assertSnapshotGuard(db, teamId, prepared.guard, { touched: [] });
            const current = raw.readLink();
            if (
              current.lease_owner !== owner ||
              !["initializing", "importing"].includes(current.mode)
            )
              throw new SyncInterruption();
            raw.writeState(null, null, null, {
              entities: prepared.patch.entities.slice(offset, offset + 1000),
              receipts: [],
              conflicts: [],
            });
          }),
        );
        await new Promise((resolve) => setImmediate(resolve));
      }
      prepared.patch.entities = [];
    }
    capture.without(() =>
      transaction(db, () => {
        // Revalidate all local inputs immediately before this short writer. C,
        // payload hashing and V reconstruction were prepared in the worker.
        if (
          upgrading &&
          db
            .prepare(
              "SELECT 1 FROM sync_outbox WHERE team_id=? AND status<>'acknowledged' LIMIT 1",
            )
            .get(teamId)
        )
          throw new SyncInterruption(
            "새 미전송 자료가 있어 형식 전환을 중단했습니다. 입력을 보존하고 관리자에게 확인하세요.",
          );
        assertSnapshotGuard(
          db,
          teamId,
          prepared.guard,
          upgrading ? {} : { touched: prepared.touched },
        );
        raw.writeState(null, newHead, null, prepared.patch);
        for (const row of prepared.outboxHashes)
          db.prepare(
            "UPDATE sync_outbox SET payload_hash=? WHERE team_id=? AND op_id=?",
          ).run(row.hash, teamId, row.opId);
        raw.acknowledge(ackOpIds);
        changed = materialize(
          db,
          teamId,
          prepared.changedEntities,
          prepared.previous,
          { retiredKeys: prepared.retiredKeys },
        );
        raw.advanceHead(expectedHead, newHead, prepared.hash);
        db.prepare(
          "UPDATE team_sync_links SET mode=CASE WHEN mode='initializing' THEN 'active' ELSE mode END,last_published_at=CASE WHEN ? THEN ? ELSE last_published_at END,lease_until=? WHERE team_id=?",
        ).run(
          Number(
            prepared.outboxHashes.length > 0 || link.mode === "initializing",
          ),
          new Date().toISOString(),
          Date.now() + 600000,
          teamId,
        );
      }),
    );
    capture.acknowledged(teamId, ackOpIds);
    notify(teamId, changed, {
      previous: prepared.previous,
      entities: prepared.changedEntities,
    });
    return { head: newHead, changed: changed.length };
  }
  return async function mutation(request, { upgrading = false } = {}) {
    const { action, teamId, owner, data } = request;
    if (isStopped()) throw new SyncInterruption();
    const handler = handlers[action];
    if (!Object.hasOwn(handlers, action))
      throw new Error("Unsupported synchronization mutation");
    const raw = store(teamId);
    if (["acquire", "release"].includes(action))
      return handler({ ...request, raw });
    const link = raw.readLink();
    if (
      !link ||
      link.lease_owner !== owner ||
      link.lease_until <= Date.now() ||
      link.installation_id !== installationId
    )
      throw new SyncInterruption();
    if (["bootstrap", "bootstrap-candidate", "commit"].includes(action)) {
      const transition =
        upgrading &&
        data?.transition === true &&
        action === "commit" &&
        link.mode === "paused";
      if (
        !["active", "initializing", "importing"].includes(link.mode) &&
        !transition
      )
        throw new SyncInterruption();
      if (
        db
          .prepare(
            "SELECT 1 FROM site_maintenance_jobs WHERE team_id=? AND kind<>'backup' AND phase NOT IN ('complete','cancelled')",
          )
          .get(teamId)
      )
        throw new SyncInterruption();
    }
    return handler({ ...request, raw, link, upgrading });
  };
}
