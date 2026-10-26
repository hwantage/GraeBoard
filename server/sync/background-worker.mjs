import { encodeStoredSnapshot, decodeStoredSnapshot } from "./snapshot.mjs";
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { allEntities, readEntity } from "./entities.mjs";
import { canonical, digest, entityId, equal, stateHash } from "./protocol.mjs";
import { reduceMany, project, validateSnapshot } from "./reducer.mjs";
import { sqliteTeamStore } from "../storage/sqlite.mjs";
import { prepareStatePatch } from "../storage/team-store.mjs";
import { snapshotGuard, interferenceKeys } from "./node-background.mjs";
import { GitCliTransport } from "./git-cli.mjs";
import { normalizeSyncError, protocolValidation } from "./errors.mjs";
import { SyncService } from "./service.mjs";
import { existsSync } from "node:fs";
import {
  documentImagePath,
  documentImageUrls,
  readDocumentImage,
  writeDocumentImage,
} from "../document-images.mjs";
import { activeImageReferences, isExcluded } from "./retention.mjs";

const db = new DatabaseSync(workerData.databasePath, { readOnly: true });
db.exec(
  "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA query_only=ON",
);

function snapshot(teamId, work) {
  db.exec("BEGIN");
  try {
    const store = sqliteTeamStore(db, teamId);
    // The first read fixes the SQLite WAL snapshot for both the domain and P.
    const guard = snapshotGuard(db, teamId),
      link = store.readLink();
    if (!link) throw new Error("Team synchronization connection is missing");
    const result = work({ store, guard, link });
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function compute(request) {
  if (request.kind === "reduce") {
    const previous = request.state;
    const state = reduceMany(
      previous,
      request.operations || [],
      request.identity,
    );
    const receipts = (request.operations || []).map(
      (op) => state.receipts[op.opId],
    );
    return {
      state,
      hash: stateHash(state),
      patch: prepareStatePatch(previous, state),
      receipts,
    };
  }
  if (request.kind === "state")
    return snapshot(request.teamId, ({ store, guard, link }) => {
      const pendingRows = store.readPendingRows();
      return {
        state: store.readState(),
        pending: pendingRows.map((r) => r.operation),
        pendingRows,
        exclusions: store.readExclusions(),
        link,
        guard,
      };
    });
  if (request.kind === "bootstrap")
    return snapshot(request.teamId, ({ store, guard, link }) => {
      const bootstrap = store.readBootstrap();
      if (bootstrap) {
        const saved = decodeStoredSnapshot(bootstrap);
        if (saved.state) {
          validateSnapshot(saved.state, {
            teamId: link.team_id,
            repoId: link.repo_id,
          });
          return {
            bundle: saved,
            bundleJson: bootstrap,
            guard,
            cutoff: saved.cutoff ?? null,
          };
        }
      }
      const state = {
        entities: allEntities(db, link),
        receipts: {},
        conflicts: {},
      };
      const pending = store.readPendingRows();
      const missing = new Set();
      for (const { operation: op } of pending) {
        const outputTokens = {};
        for (const change of op.changes) {
          const key = entityId(change.entity, change.key);
          if (!state.entities[key] || missing.has(key)) {
            missing.add(key);
            state.entities[key] = {
              entity: change.entity,
              key: change.key,
              generation: change.generation,
              version: op.opId,
              payload:
                change.desired || change.base || state.entities[key]?.payload,
              deleted: true,
            };
          }
          outputTokens[key] = state.entities[key].version;
        }
        state.receipts[op.opId] = {
          opId: op.opId,
          payloadHash: digest(op),
          result: "applied",
          conflictId: null,
          outputTokens,
        };
      }
      validateSnapshot(state, { teamId: link.team_id, repoId: link.repo_id });
      const cutoff = pending.at(-1)?.local_seq || 0;
      const bundle = { state, hash: stateHash(state), cutoff };
      return {
        bundle,
        bundleJson: encodeStoredSnapshot(bundle),
        cutoff,
        guard,
      };
    });
  if (request.kind === "project")
    return snapshot(request.teamId, ({ store, guard, link }) => {
      const previousState = request.previousState || store.readState();
      const state = request.state || previousState;
      const acknowledged = new Set(request.ackOpIds || []);
      const pendingRows = store.readPendingRows();
      const pending = pendingRows
        .map((row) => row.operation)
        .filter((op) => !acknowledged.has(op.opId));
      const exclusions = store.readExclusions(link.installation_id);
      const patch = prepareStatePatch(previousState, state);
      const candidates = new Set(
        patch.entities.map((row) => entityId(row[0], JSON.parse(row[1]))),
      );
      for (const row of pendingRows)
        for (const change of row.operation.changes)
          candidates.add(entityId(change.entity, change.key));
      const projected = project(state, pending),
        changedEntities = {},
        previous = {},
        touched = new Set();
      for (const key of candidates) {
        const record = projected.entities[key];
        if (!record) continue;
        if (isExcluded(record, projected.entities, exclusions)) continue;
        const current = readEntity(
          db,
          request.teamId,
          record.entity,
          record.key,
        );
        if (record.deleted && (!current || current.payload?.deletedAt))
          continue;
        if (
          !equal(record.payload, current?.payload) ||
          !!record.deleted !== !!current?.deleted
        ) {
          changedEntities[key] = record;
          if (current) previous[key] = current;
          for (const dependency of [
            ...interferenceKeys(record.entity, record.key, record.payload),
            ...interferenceKeys(record.entity, record.key, current?.payload),
          ])
            touched.add(dependency);
        }
      }
      const outboxHashes = pendingRows
        .filter((row) => acknowledged.has(row.op_id))
        .map((row) => {
          const hash = digest(row.operation);
          if (state.receipts[row.op_id]?.payloadHash !== hash)
            throw new Error(
              "Canonical ACK payload differs from local operation",
            );
          return { opId: row.op_id, hash };
        });
      return {
        changedEntities,
        previous,
        held: projected.held,
        exclusions,
        guard,
        link,
        patch,
        hash: stateHash(state),
        outboxHashes,
        touched: [...touched],
      };
    });
  throw new Error("Unsupported background calculation kind");
}

let mutationSequence = 0;
const mutations = new Map(),
  services = new Map();
function mutate(action, teamId, owner, data) {
  const id = ++mutationSequence;
  return new Promise((resolve, reject) => {
    mutations.set(id, { resolve, reject });
    parentPort.postMessage({ mutation: { id, action, teamId, owner, data } });
  });
}
function references(state) {
  const markdowns = [];
  for (const e of Object.values(state.entities))
    if (e.entity === "document") markdowns.push(e.payload.markdown);
  for (const c of Object.values(state.conflicts))
    if (!c.resolution)
      for (const change of c.operation.changes)
        if (change.entity === "document") {
          if (change.base?.markdown) markdowns.push(change.base.markdown);
          if (change.desired?.markdown) markdowns.push(change.desired.markdown);
        }
  return [...new Set(markdowns.flatMap(documentImageUrls))];
}
function serviceFor(config) {
  if (services.has(config.serviceKey)) return services.get(config.serviceKey);
  const { teamId, documentImagesDir } = config;
  const raw = sqliteTeamStore(db, teamId);
  let owner;
  const store = {
    ...raw,
    acquire(value) {
      owner = value;
      return mutate("acquire", teamId, owner);
    },
    release(value) {
      return mutate("release", teamId, value);
    },
    readState() {
      return snapshot(teamId, ({ store }) => store.readState());
    },
    async bootstrap() {
      const prepared = compute({ kind: "bootstrap", teamId });
      await mutate("bootstrap", teamId, owner, {
        bundleJson: prepared.bundleJson,
        bootstrapId: prepared.guard.bootstrapId,
        guard: prepared.guard,
      });
      const saved = decodeStoredSnapshot(raw.readBootstrap());
      return {
        state: saved.state,
        hash: saved.hash,
        cutoff: saved.cutoff || 0,
      };
    },
    async saveBootstrap(data) {
      const saved = decodeStoredSnapshot(raw.readBootstrap());
      await mutate("bootstrap-candidate", teamId, owner, {
        bundleJson: encodeStoredSnapshot({ ...saved, publication: data }),
      });
    },
    async commitCanonical(expectedHead, newHead, state, ackOpIds) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const prepared = compute({ kind: "project", teamId, state, ackOpIds });
        if (prepared.guard.head !== expectedHead)
          throw new Error(
            "Canonical head changed during background preparation",
          );
        try {
          return await mutate("commit", teamId, owner, {
            expectedHead,
            newHead,
            ackOpIds,
            prepared,
          });
        } catch (error) {
          if (error.code !== "SYNC_SNAPSHOT_CHANGED" || attempt === 7)
            throw error;
          // HTTP edits win the short write boundary; reconstruct P from their
          // newly committed outbox instead of applying an outdated projection.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    },
    setError(error) {
      return mutate(
        "error",
        teamId,
        owner,
        normalizeSyncError(error) || { message: null },
      );
    },
    finishImport(head) {
      return mutate("finish-import", teamId, owner, { head });
    },
    saveRemoteStatus(value) {
      return mutate("status", teamId, owner, { serialized: canonical(value) });
    },
  };
  const transport = new GitCliTransport(config.transport);
  const images = {
    async *publish(state, { parent, transport } = {}) {
      const inherited = new Set(
        parent
          ? (await transport.readCommit(parent)).files.map((f) => f.path)
          : [],
      );
      const pending = raw.readPending(),
        link = raw.readLink();
      const active = activeImageReferences(
        state,
        pending,
        raw.readExclusions(link.installation_id),
        project(state, pending).entities,
        teamId,
      );
      for (const url of references(state)) {
        const path = url.replace("/api/document-images/", "images/");
        if (inherited.has(path)) continue;
        if (!url.startsWith(`/api/document-images/${teamId}/`))
          throw new Error("Foreign image reference");
        if (
          !existsSync(documentImagePath(documentImagesDir, url)) &&
          !active.has(url)
        )
          continue;
        yield [path, readDocumentImage(documentImagesDir, url)];
      }
    },
    async receive(state, oid, remote, { verifiedImages = new Map() } = {}) {
      const pending = raw.readPending(),
        link = raw.readLink();
      const active = activeImageReferences(
        state,
        pending,
        raw.readExclusions(link.installation_id),
        project(state, pending).entities,
        teamId,
      );
      const install = async (url, required) => {
        const path = url.replace("/api/document-images/", "images/");
        const bytes =
          verifiedImages.get(path) || (await remote.readFile(oid, path));
        if (
          !bytes ||
          digest(bytes) !== path.split("/").at(-1).replace(".webp", "") ||
          bytes.length > 10 * 1024 * 1024
        )
          throw new Error("Invalid image content hash or size");
        if (required) writeDocumentImage(documentImagesDir, url, bytes);
      };
      for (const url of active)
        if (!existsSync(documentImagePath(documentImagesDir, url)))
          await install(url, true);
    },
  };
  const service = new SyncService({
    transport,
    store,
    identity: config.identity,
    images,
  });
  services.set(config.serviceKey, service);
  return service;
}
parentPort.on("message", async ({ id, request, mutationId, result, error }) => {
  if (mutationId) {
    const waiting = mutations.get(mutationId);
    if (!waiting) return;
    mutations.delete(mutationId);
    if (error)
      waiting.reject(
        Object.assign(new Error(error.message), { code: error.code }),
      );
    else waiting.resolve(result);
    return;
  }
  try {
    const result =
      request.kind === "service"
        ? await serviceFor(request.config)[
            request.action === "checkpoint" ? "checkpoint" : "run"
          ](request.options || {})
        : compute(request);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: { message: error.message, code: error.code },
    });
  }
});
