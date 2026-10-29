import { Worker } from "node:worker_threads";
import { HttpError } from "../../shared/validation.js";

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
  if (["reportTask", "reportCell"].includes(entity)) add("report", [key[0]]);
  if (entity === "reportCell") add("reportTask", key.slice(0, 2));
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
  timeoutMs = 300000,
  maxWorkers = 2,
  onMutation,
  onProgress = () => {},
  onExit = () => {},
  workerUrl = new URL("./background-worker.mjs", import.meta.url),
} = {}) {
  databasePath ||= db
    ?.prepare("PRAGMA database_list")
    .all()
    .find((r) => r.name === "main")?.file;
  if (!databasePath)
    throw new Error(
      "Background SQLite snapshots require a file-backed database",
    );
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 2)
    throw new Error("Synchronization workers must be between one and two");
  const lanes = Array.from({ length: maxWorkers }, () => ({
    worker: null,
    queue: [],
    active: null,
    retiring: false,
    workerId: null,
  }));
  const teams = new Map();
  let sequence = 0,
    workerSequence = 0,
    closed = false;
  const failure = (error) =>
    Object.assign(
      [400, 404, 409].includes(error.status)
        ? new HttpError(error.status, error.message)
        : new Error(error.message),
      { code: error.code, retryAt: error.retryAt },
    );
  const finish = (entry, error, result) => {
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(result);
  };
  const arm = (lane) => {
    const entry = lane.active;
    if (!entry || entry.settled) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const error = Object.assign(
        new Error("Synchronization calculation timed out"),
        { code: "SYNC_TIMEOUT" },
      );
      finish(entry, error);
      lane.retiring = true;
      // Abort the active request's I/O first. A stuck CPU task is then terminated;
      // other teams' workers and queued requests remain intact.
      lane.worker.postMessage({ cancelId: entry.id });
      entry.termination = setTimeout(() => void lane.worker?.terminate(), 100);
    }, timeoutMs);
  };
  const startWorker = (lane) => {
    const worker = new Worker(workerUrl, { workerData: { databasePath } });
    const workerId = ++workerSequence;
    lane.worker = worker;
    lane.workerId = workerId;
    worker.on("message", ({ id, result, error, mutation, progress }) => {
      if (lane.worker !== worker) return;
      const entry = lane.active;
      if (progress) {
        if (progress === entry?.id && !entry.settled) {
          onProgress({
            workerId,
            teamId: entry.request.teamId || entry.request.config?.teamId,
          });
          arm(lane);
        }
        return;
      }
      if (mutation) {
        Promise.resolve()
          .then(() => {
            if (closed || !entry || entry.settled)
              throw Object.assign(
                new Error("Synchronization request is no longer active"),
                { code: "SYNC_INTERRUPTED" },
              );
            if (!onMutation)
              throw new Error("Background mutation bridge is not installed");
            arm(lane);
            return onMutation(mutation, { workerId, request: entry.request });
          })
          .then(
            (value) => {
              if (lane.worker === worker) {
                arm(lane);
                worker.postMessage({ mutationId: mutation.id, result: value });
              }
            },
            (failed) => {
              if (lane.worker === worker)
                worker.postMessage({
                  mutationId: mutation.id,
                  error: {
                    message: failed.message,
                    code: failed.code,
                    status: failed.status,
                  },
                });
            },
          );
        return;
      }
      if (entry?.id !== id) return;
      finish(entry, error ? failure(error) : null, result);
      if (!lane.retiring) {
        lane.active = null;
        worker.unref();
        pump(lane);
      }
    });
    worker.on("error", (error) => {
      lane.retiring = true;
      finish(lane.active, error);
    });
    worker.on("exit", (code) => {
      if (lane.worker !== worker) return;
      if (lane.active) clearTimeout(lane.active.termination);
      finish(lane.active, new Error(`Synchronization worker exited (${code})`));
      lane.active = null;
      lane.worker = null;
      lane.retiring = false;
      // The host releases only this worker's leases after termination is known.
      onExit(code, { workerId });
      pump(lane);
    });
    worker.unref();
  };
  const pump = (lane) => {
    if (closed || lane.retiring || lane.active || !lane.queue.length) return;
    if (!lane.worker) startWorker(lane);
    const entry = lane.queue.shift();
    lane.active = entry;
    lane.worker.ref();
    arm(lane);
    try {
      lane.worker.postMessage({ id: entry.id, request: entry.request });
    } catch (error) {
      finish(entry, error);
      lane.active = null;
      pump(lane);
    }
  };
  return {
    get closed() {
      return closed;
    },
    compute(request) {
      if (closed)
        return Promise.reject(new Error("Synchronization worker is closed"));
      const teamId = request.teamId || request.config?.teamId;
      let lane = teams.get(teamId);
      if (!lane) {
        lane = lanes.reduce((best, candidate) =>
          candidate.queue.length + Number(!!candidate.active) <
          best.queue.length + Number(!!best.active)
            ? candidate
            : best,
        );
        if (teamId) teams.set(teamId, lane);
      }
      return new Promise((resolve, reject) => {
        lane.queue.push({
          id: ++sequence,
          request,
          resolve,
          reject,
          settled: false,
        });
        pump(lane);
      });
    },
    async close() {
      closed = true;
      const error = new Error("Synchronization worker closed");
      for (const lane of lanes) {
        finish(lane.active, error);
        for (const entry of lane.queue) finish(entry, error);
        lane.queue.length = 0;
      }
      await Promise.all(lanes.map((lane) => lane.worker?.terminate()));
      teams.clear();
    },
  };
}
