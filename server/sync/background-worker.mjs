import { applicationEntities } from "./versions.mjs";
import { syncImageReferences } from "../../shared/sync-image-references.js";
import { encodeStoredSnapshot, decodeStoredSnapshot } from "./snapshot.mjs";
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { allEntities, readEntity } from "./entities.mjs";
import {
  canonical,
  digest,
  entityId,
  equal,
  payloadEqual,
  stateHash,
  validateOperation,
  protocolVersion,
} from "./protocol.mjs";
import { makeOperation } from "./operations.mjs";
import { HttpError, requireThat } from "../../shared/validation.js";
import { reduceMany, project, validateSnapshot } from "./reducer.mjs";
import { sqliteTeamStore } from "../storage/sqlite.mjs";
import { prepareStatePatch } from "../../shared/sync-team-store.mjs";
import { snapshotGuard, interferenceKeys } from "./node-background.mjs";
import { GitCliTransport } from "./git-cli.mjs";
import {
  normalizeSyncError,
  protocolValidation,
  ProtocolError,
  SyncInterruption,
} from "./errors.mjs";
import { pendingEntityKeys, canRetireProjection } from "./projection.mjs";
import { SyncService } from "./service.mjs";
import { publishDirectory } from "./directory.mjs";
import { existsSync } from "node:fs";
import {
  documentImagePath,
  readDocumentImage,
  writeDocumentImage,
} from "../document-images.mjs";
import {
  activeImageReferences,
  installImageReferences,
  isExcluded,
} from "./retention.mjs";

const db = new DatabaseSync(workerData.databasePath, { readOnly: true });
db.exec(
  "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA query_only=ON",
);

const canonicalCache = new Map();
const projectionCache = new Map();
function canonicalCacheKey(link) {
  return JSON.stringify([
    link.team_id,
    link.repo_id,
    link.bootstrap_id,
    link.installation_id,
    link.writer_epoch,
    link.generation,
    link.canonical_head,
    link.canonical_hash,
  ]);
}
function cacheCanonical(teamId, link, state) {
  if (link.canonical_head)
    canonicalCache.set(teamId, { key: canonicalCacheKey(link), state });
}
function readCanonical(teamId, store, guard, link) {
  const key = canonicalCacheKey(link),
    cached = canonicalCache.get(teamId);
  if (guard.head && cached?.key === key) return cached.state;
  const state = store.readState();
  if (guard.head && link.canonical_hash) {
    validateSnapshot(state, { teamId, repoId: link.repo_id });
    if (stateHash(state) !== link.canonical_hash)
      throw new ProtocolError(
        "SYNC_INTEGRITY",
        "Stored canonical state does not match its verified hash",
      );
  }
  cacheCanonical(teamId, link, state);
  return state;
}
function projectedState(teamId, state, pending) {
  const cached = projectionCache.get(teamId);
  const ids = pending.map((op) => op.opId);
  const extend =
    cached?.base === state &&
    cached.ids.length <= ids.length &&
    cached.ids.every((id, index) => ids[index] === id);
  const result = extend
    ? ids.length === cached.ids.length
      ? cached.result
      : reduceMany(cached.result, pending.slice(cached.ids.length))
    : pending.length
      ? reduceMany(state, pending)
      : state;
  projectionCache.set(teamId, { base: state, ids, result });
  return {
    entities: result.entities,
    held: pending
      .filter(
        (op) => !["applied", "noop"].includes(result.receipts[op.opId].result),
      )
      .map((op) => op.opId),
  };
}
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
    canonicalCache.delete(teamId);
    projectionCache.delete(teamId);
    throw error;
  }
}

function compute(request) {
  if (request.kind === "reconnect")
    return snapshot(request.teamId, ({ store, guard, link }) => {
      requireThat(
        link.mode === "disconnected",
        409,
        "연결 상태가 변경되었습니다.",
      );
      const pending = store.readPending(),
        canonicalState = store.readState(),
        before = project(canonicalState, pending).entities,
        after = allEntities(db, link),
        exclusions = store.readExclusions(link.installation_id);
      for (const [key, previous] of Object.entries(before)) {
        // Local retention and unused person references are not shared deletions.
        // Keep already deleted records as tombstones when their rows are absent.
        if (isExcluded(previous, before, exclusions)) delete after[key];
        else if (!after[key])
          after[key] =
            previous.deleted || previous.entity === "person" ? previous : null;
      }
      const operation = makeOperation({
        link: { ...link, protocol: protocolVersion({ entities: before }) },
        actorRef: request.actorRef,
        before,
        after,
        prior: Object.fromEntries(
          pending.flatMap((op) =>
            op.changes.map((change) => [
              entityId(change.entity, change.key),
              op.opId,
            ]),
          ),
        ),
      });
      if (operation)
        validateOperation(operation, {
          teamId: link.team_id,
          repoId: link.repo_id,
        });
      return { operation, guard, link };
    });
  if (request.kind === "resolve")
    return snapshot(request.teamId, ({ store, guard, link }) => {
      const started = performance.now(),
        state = store.readState();
      const conflict = state.conflicts[request.conflictId];
      requireThat(
        conflict && !conflict.resolution,
        404,
        "충돌을 찾을 수 없습니다.",
      );
      requireThat(
        request.expectedHead === link.canonical_head,
        409,
        "최신 공유본을 다시 확인하세요.",
      );
      requireThat(
        ["current", "submitted", "edited"].includes(request.choice),
        400,
        "해결 방법을 선택하세요.",
      );
      const frontier = request.frontier || [conflict.opId];
      requireThat(
        Array.isArray(frontier) &&
          frontier.includes(conflict.opId) &&
          frontier.every(
            (id) =>
              typeof id === "string" &&
              Object.hasOwn(state.conflicts, id) &&
              !state.conflicts[id].resolution,
          ),
        400,
        "해결 범위를 확인하세요.",
      );
      const before = {},
        after = {},
        candidates = new Set(),
        touched = new Set();
      const touch = (change) => {
        candidates.add(entityId(change.entity, change.key));
        for (const payload of [change.base, change.desired])
          for (const key of interferenceKeys(
            change.entity,
            change.key,
            payload,
          ))
            touched.add(key);
      };
      for (const id of frontier)
        for (const change of state.conflicts[id].operation.changes)
          touch(change);
      for (const [i, change] of conflict.operation.changes.entries()) {
        const key = entityId(change.entity, change.key);
        before[key] = state.entities[key] || null;
        after[key] =
          request.choice === "current"
            ? before[key]
            : {
                ...(before[key] || change),
                entity: change.entity,
                key: change.key,
                payload:
                  request.choice === "edited"
                    ? Array.isArray(request.desired)
                      ? request.desired[i]
                      : request.desired
                    : change.desired,
                deleted: change.action === "delete",
              };
      }
      const operation = makeOperation({
        link: { ...link, protocol: protocolVersion(state) },
        actorRef: request.actorRef,
        before,
        after,
        resolves: frontier,
      });
      try {
        validateOperation(operation, {
          teamId: request.teamId,
          repoId: link.repo_id,
        });
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      const pending = store.readPending();
      for (const op of pending)
        for (const change of op.changes)
          candidates.add(entityId(change.entity, change.key));
      for (const change of operation.changes) touch(change);
      const projected = project(state, [...pending, operation]);
      const exclusions = store.readExclusions(link.installation_id);
      const prepared = projectionPatch(
        request.teamId,
        projected.entities,
        candidates,
        exclusions,
        { touched, measureReads: true, pending: [...pending, operation] },
      );
      return {
        ...prepared,
        operation,
        guard,
        link,
        metrics: {
          candidateCount: candidates.size,
          readEntityCount: prepared.readEntityCount,
          domainSelectCount: prepared.domainSelectCount,
          changedEntityCount: Object.keys(prepared.changedEntities).length,
          prepareMs: performance.now() - started,
        },
      };
    });
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
      const previousState =
        request.previousState ||
        readCanonical(request.teamId, store, guard, link);
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
      const projected = projectedState(request.teamId, state, pending);
      const prepared = projectionPatch(
        request.teamId,
        projected.entities,
        candidates,
        exclusions,
        { pending },
      );
      const outboxHashes = pendingRows
        .filter((row) => acknowledged.has(row.op_id))
        .map((row) => {
          const hash = digest(row.operation);
          if (state.receipts[row.op_id]?.payloadHash !== hash)
            throw new ProtocolError(
              "SYNC_INTEGRITY",
              "Canonical ACK payload differs from local operation",
            );
          return { opId: row.op_id, hash };
        });
      return {
        ...prepared,
        held: projected.held,
        exclusions,
        guard,
        link,
        patch,
        hash: stateHash(state),
        outboxHashes,
      };
    });
  throw new Error("Unsupported background calculation kind");
}

// Both remote replay and local resolutions prepare only potentially affected
// domain rows in the readonly worker snapshot. C and all P remain available to
// the reducer for dependency, conflict and uniqueness validation.
function projectionPatch(
  teamId,
  entities,
  candidates,
  exclusions,
  { touched = new Set(), measureReads = false, pending = [] } = {},
) {
  const canonicalEntities = entities;
  entities = applicationEntities(entities);
  if (entities !== canonicalEntities)
    candidates = new Set(
      [...candidates].flatMap((id) => {
        const [entity, key] = JSON.parse(id);
        return entity === "protocol"
          ? []
          : [
              entityId(
                ["reportTask", "reportCell"].includes(entity)
                  ? "report"
                  : entity,
                ["reportTask", "reportCell"].includes(entity) ? [key[0]] : key,
              ),
            ];
      }),
    );
  const reports = new Map(),
    styles = new Map();
  const changedEntities = {},
    previous = {},
    protectedKeys = pendingEntityKeys(pending),
    retiredKeys = [];
  let readEntityCount = 0,
    domainSelectCount = 0;
  const reader = measureReads
    ? {
        prepare(sql) {
          const statement = db.prepare(sql);
          return Object.fromEntries(
            ["get", "all"].map((method) => [
              method,
              (...args) => {
                domainSelectCount++;
                return statement[method](...args);
              },
            ]),
          );
        },
      }
    : db;
  // A rejected local creation may still be referenced by P/held. Keep that
  // local row until ACK, while allowing C to advance so its own operation can
  // be published. SQLite's unique names otherwise deadlock receive -> publish.
  const uniqueTypes = new Set(
    [...candidates]
      .map((key) => JSON.parse(key)[0])
      .filter((entity) => ["tag", "filter"].includes(entity)),
  );
  const deferred = new Set();
  if (uniqueTypes.size) {
    candidates = new Set(candidates);
    for (const [key, record] of Object.entries(entities)) {
      if (!uniqueTypes.has(record.entity) || record.deleted) continue;
      candidates.add(key);
      const collision =
        record.entity === "tag"
          ? reader
              .prepare(
                "SELECT id FROM calendar_tags WHERE team_id=? AND user_id IS ? AND name=? AND id<>?",
              )
              .get(
                teamId,
                record.payload.userId,
                record.payload.name,
                record.key[0],
              )
          : reader
              .prepare(
                "SELECT id FROM saved_filters WHERE team_id=? AND scope='team' AND name=? AND id<>?",
              )
              .get(teamId, record.payload.name, record.key[0]);
      if (
        collision &&
        protectedKeys.has(entityId(record.entity, [collision.id]))
      )
        deferred.add(key);
    }
    if (uniqueTypes.has("tag")) {
      for (const [key, record] of Object.entries(entities)) {
        if (record.entity !== "calendar" || record.deleted) continue;
        const references = (record.payload.tags || []).map((tag) =>
          entityId("tag", [tag.id]),
        );
        if (references.some((key) => candidates.has(key))) candidates.add(key);
        if (references.some((key) => deferred.has(key))) deferred.add(key);
      }
      for (const [key, record] of Object.entries(entities)) {
        if (record.entity !== "document" || record.key[0] !== "calendar")
          continue;
        const parent = entityId("calendar", [record.key[1]]);
        if (candidates.has(parent)) candidates.add(key);
        if (deferred.has(parent)) deferred.add(key);
      }
    }
  }
  for (const key of candidates) {
    if (deferred.has(key)) continue;
    let record = entities[key];
    if (record && isExcluded(record, entities, exclusions)) continue;
    if (!record && !canRetireProjection(key, entities, protectedKeys)) continue;
    const [entity, entityKey] = record
      ? [record.entity, record.key]
      : JSON.parse(key);
    readEntityCount++;
    const current = readEntity(reader, teamId, entity, entityKey, {
      reports,
      styles,
    });
    if (!record) {
      if (!current || current.deleted) continue;
      // This is a local projection retirement, never a canonical tombstone or
      // a new outbox operation. The rejected input remains in its receipt/conflict.
      record = { ...current, deleted: true };
      retiredKeys.push(key);
    }
    if (record.deleted && (!current || current.payload?.deletedAt)) continue;
    if (
      !payloadEqual(record.entity, record.payload, current?.payload) ||
      !!record.deleted !== !!current?.deleted
    ) {
      changedEntities[key] = record;
      if (current) previous[key] = current;
      for (const payload of [record.payload, current?.payload])
        for (const dependency of interferenceKeys(
          record.entity,
          record.key,
          payload,
        ))
          touched.add(dependency);
    }
  }
  return {
    changedEntities,
    previous,
    retiredKeys,
    touched: [...touched],
    readEntityCount,
    domainSelectCount,
  };
}

let activeRequest;
function progress() {
  activeRequest?.controller.signal.throwIfAborted();
  if (activeRequest) parentPort.postMessage({ progress: activeRequest.id });
}
let mutationSequence = 0;
const mutations = new Map(),
  services = new Map();
function mutate(action, teamId, owner, data) {
  progress();
  const id = ++mutationSequence;
  return new Promise((resolve, reject) => {
    mutations.set(id, { resolve, reject });
    parentPort.postMessage({ mutation: { id, action, teamId, owner, data } });
  });
}
function serviceFor(config) {
  if (services.has(config.serviceKey)) {
    const service = services.get(config.serviceKey);
    service.transport.signal = activeRequest?.controller.signal;
    return service;
  }
  const { teamId, documentImagesDir } = config;
  // A replacement configuration supersedes the old service for this team.
  // Requests in this worker run serially, so no old run can still be using it.
  for (const [key, service] of services)
    if (service.identity.teamId === teamId) {
      services.delete(key);
      canonicalCache.delete(teamId);
      projectionCache.delete(teamId);
    }
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
      return snapshot(teamId, ({ store, guard, link }) =>
        readCanonical(teamId, store, guard, link),
      );
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
    async commitCanonical(
      expectedHead,
      newHead,
      state,
      ackOpIds,
      options = {},
    ) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const prepared = compute({ kind: "project", teamId, state, ackOpIds });
        if (prepared.guard.head !== expectedHead)
          throw new ProtocolError(
            "SYNC_INTEGRITY",
            "Canonical head changed during background preparation",
          );
        try {
          const result = await mutate("commit", teamId, owner, {
            expectedHead,
            newHead,
            ackOpIds,
            transition: options.transition === true,
            prepared,
          });
          const link = raw.readLink();
          if (link.canonical_head === newHead)
            cacheCanonical(teamId, link, state);
          return result;
        } catch (error) {
          canonicalCache.delete(teamId);
          projectionCache.delete(teamId);
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
  const transport = new GitCliTransport({
    ...config.transport,
    signal: activeRequest?.controller.signal,
  });
  const git = transport.git.bind(transport);
  transport.git = async (...args) => {
    progress();
    const result = await git(...args);
    progress();
    return result;
  };
  const skippedImage = (path, reason) =>
    console.warn("GraeBoard image skipped", JSON.stringify({ path, reason }));
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
      for (const url of syncImageReferences(state)) {
        const path = url.replace("/api/document-images/", "images/");
        if (inherited.has(path)) continue;
        if (!url.startsWith(`/api/document-images/${teamId}/`))
          throw new ProtocolError("SYNC_INTEGRITY", "Foreign image reference");
        // A document may point at an image this site does not hold: it is
        // shown as missing, and the commit goes on without it.
        if (!existsSync(documentImagePath(documentImagesDir, url))) {
          if (active.has(url)) skippedImage(path, "missing locally");
          continue;
        }
        let bytes;
        try {
          bytes = readDocumentImage(documentImagesDir, url);
        } catch {
          skippedImage(path, "damaged locally");
          continue;
        }
        yield [path, bytes];
      }
    },
    async receive(state, oid, remote, { verifiedImages = new Map() } = {}) {
      const pending = raw.readPending(),
        link = raw.readLink();
      const active = installImageReferences(
        state,
        pending,
        raw.readExclusions(link.installation_id),
        project(state, pending).entities,
        teamId,
      );
      // An image Git lacks or holds damaged is left out: the document shows
      // it as missing, and the commit is still received.
      let files;
      const install = async (url) => {
        const path = url.replace("/api/document-images/", "images/");
        files ||= new Set(
          (await remote.readCommit(oid)).files.map((file) => file.path),
        );
        const bytes =
          verifiedImages.get(path) ||
          (files.has(path) ? await remote.readFile(oid, path) : null);
        if (
          !bytes ||
          digest(bytes) !== path.split("/").at(-1).replace(".webp", "") ||
          bytes.length > 10 * 1024 * 1024
        ) {
          skippedImage(path, bytes ? "damaged in Git" : "missing from Git");
          return;
        }
        writeDocumentImage(documentImagesDir, url, bytes);
      };
      for (const url of active)
        if (!existsSync(documentImagePath(documentImagesDir, url)))
          await install(url);
    },
  };
  const service = new SyncService({
    transport,
    store,
    identity: config.identity,
    images,
  });
  service.publishDirectory = async () => {
    const link = raw.readLink();
    if (!link?.canonical_head || !["active", "paused"].includes(link.mode))
      return;
    const members = db
      .prepare(
        "SELECT u.id,u.name,u.username AS email,u.active,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.team_id=? ORDER BY u.id",
      )
      .all(teamId)
      .map((row) => ({ ...row, active: !!row.active }));
    await publishDirectory(transport, {
      format: "graeboard-team-directory",
      version: 1,
      teamId,
      installationId: link.installation_id,
      repoId: link.repo_id,
      members,
    });
  };
  services.set(config.serviceKey, service);
  return service;
}
parentPort.on(
  "message",
  async ({ id, request, mutationId, result, error, cancelId }) => {
    if (cancelId) {
      if (activeRequest?.id === cancelId) {
        const reason = new SyncInterruption();
        activeRequest.controller.abort(reason);
        for (const waiting of mutations.values()) waiting.reject(reason);
        mutations.clear();
      }
      return;
    }
    if (mutationId) {
      const waiting = mutations.get(mutationId);
      if (!waiting) return;
      mutations.delete(mutationId);
      if (error)
        waiting.reject(
          Object.assign(new Error(error.message), {
            code: error.code,
            status: error.status,
          }),
        );
      else waiting.resolve(result);
      return;
    }
    activeRequest = { id, controller: new AbortController() };
    try {
      progress();
      let result;
      if (request.kind === "service") {
        const service = serviceFor(request.config);
        result = await service[
          ["checkpoint", "upgrade"].includes(request.action)
            ? request.action
            : "run"
        ](request.options || {});
        progress();
        if (request.action === "run") await service.publishDirectory();
      } else result = compute(request);
      progress();
      parentPort.postMessage({ id, result });
    } catch (error) {
      parentPort.postMessage({
        id,
        error: {
          message: error.message,
          code: error.code,
          status: error.status,
          retryAt: error.retryAt,
        },
      });
    } finally {
      activeRequest = null;
    }
  },
);
