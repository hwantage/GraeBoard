import { Worker } from "node:worker_threads";

export function snapshotGuard(db, teamId) {
  const link = db
    .prepare(
      "SELECT canonical_head,generation,bootstrap_id FROM team_sync_links WHERE team_id=?",
    )
    .get(teamId);
  const pending = db
    .prepare(
      "SELECT COALESCE(MAX(local_seq),0) AS maximum,COUNT(*) AS count FROM sync_outbox WHERE team_id=? AND status<>'acknowledged'",
    )
    .get(teamId);
  const retention = db
    .prepare(
      "SELECT COUNT(*) AS count,COALESCE(SUM(revision),0) AS revision FROM site_retention WHERE team_id=?",
    )
    .get(teamId);
  const job = db
    .prepare(
      "SELECT job_id,phase FROM site_maintenance_jobs WHERE team_id=? AND phase NOT IN ('complete','cancelled')",
    )
    .get(teamId);
  return {
    head: link?.canonical_head || null,
    bootstrapId: link?.bootstrap_id || null,
    generation: link?.generation ?? 0,
    pendingMaxSeq: pending.maximum,
    pendingCount: pending.count,
    teamRevision:
      db
        .prepare("SELECT version FROM team_revisions WHERE team_id=?")
        .get(teamId)?.version || 0,
    retentionCount: retention.count,
    retentionRevision: retention.revision,
    maintenance: job ? `${job.job_id}:${job.phase}` : null,
  };
}

export function interferenceKeys(entity, key, payload) {
  const keys = new Set([JSON.stringify([entity, key])]);
  const add = (type, parts) => keys.add(JSON.stringify([type, parts]));
  if (entity === "cell") add("task", [key[0]]);
  if (entity === "document") {
    if (key[0] === "task") add("task", [key[1]]);
    if (key[0] === "calendar") add("calendar", [key[1]]);
    if (key[0].startsWith("report")) add("report", [key[1]]);
  }
  if (entity === "calendar")
    for (const tag of payload?.tags || []) add("tag", [tag.id]);
  if (entity === "weekly") add("task", [key[2]]);
  if (["tag", "filter", "report"].includes(entity))
    keys.add("unique:" + entity);
  return [...keys];
}

export function assertSnapshotGuard(db, teamId, expected, { touched } = {}) {
  const current = snapshotGuard(db, teamId);
  const snapshotKeys = Object.keys(current).filter(
    (key) =>
      !touched ||
      !["teamRevision", "pendingMaxSeq", "pendingCount"].includes(key),
  );
  if (snapshotKeys.some((key) => current[key] !== expected[key]))
    throw Object.assign(
      new Error("Synchronization snapshot changed; recompute before commit"),
      { code: "SYNC_SNAPSHOT_CHANGED" },
    );
  if (touched && current.pendingMaxSeq !== expected.pendingMaxSeq) {
    const relevant = new Set(touched);
    for (const row of db
      .prepare(
        "SELECT payload FROM sync_outbox WHERE team_id=? AND local_seq>? AND status<>'acknowledged' ORDER BY local_seq",
      )
      .all(teamId, expected.pendingMaxSeq)) {
      const operation = JSON.parse(row.payload);
      for (const change of operation.changes)
        if (
          [
            ...interferenceKeys(change.entity, change.key, change.base),
            ...interferenceKeys(change.entity, change.key, change.desired),
          ].some((key) => relevant.has(key))
        )
          throw Object.assign(
            new Error(
              "Synchronization snapshot changed; recompute before commit",
            ),
            { code: "SYNC_SNAPSHOT_CHANGED" },
          );
    }
  }
}

export function createNodeBackground({
  db,
  databasePath,
  timeoutMs = 600000,
  onMutation,
} = {}) {
  databasePath ||= db
    ?.prepare("PRAGMA database_list")
    .all()
    .find((r) => r.name === "main")?.file;
  if (!databasePath)
    throw new Error(
      "Background SQLite snapshots require a file-backed database",
    );
  const worker = new Worker(
    new URL("./background-worker.mjs", import.meta.url),
    { workerData: { databasePath } },
  );
  const pending = new Map();
  let sequence = 0,
    closed = false;
  const failAll = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  worker.on("message", ({ id, result, error, mutation }) => {
    if (mutation) {
      Promise.resolve()
        .then(() => {
          if (!onMutation)
            throw new Error("Background mutation bridge is not installed");
          return onMutation(mutation);
        })
        .then(
          (value) =>
            worker.postMessage({ mutationId: mutation.id, result: value }),
          (failure) =>
            worker.postMessage({
              mutationId: mutation.id,
              error: { message: failure.message, code: failure.code },
            }),
        );
      return;
    }
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (error)
      entry.reject(
        Object.assign(new Error(error.message), { code: error.code }),
      );
    else entry.resolve(result);
    if (!pending.size) worker.unref();
  });
  worker.on("error", (error) => {
    closed = true;
    failAll(error);
  });
  worker.on("exit", (code) => {
    closed = true;
    if (pending.size)
      failAll(new Error(`Synchronization worker exited (${code})`));
  });
  worker.unref();
  return {
    compute(request) {
      if (closed)
        return Promise.reject(new Error("Synchronization worker is closed"));
      const id = ++sequence;
      worker.ref();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          // A timed-out calculation has no writes. Terminating prevents its
          // expensive work from delaying every subsequent requested snapshot.
          closed = true;
          failAll(new Error("Synchronization calculation timed out"));
          void worker.terminate();
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          worker.postMessage({ id, request });
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    async close() {
      closed = true;
      failAll(new Error("Synchronization worker closed"));
      await worker.terminate();
    },
  };
}
