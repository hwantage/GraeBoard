import { SyncService } from "../server/sync/service.mjs";
import {
  canonical,
  digest,
  emptyState,
  stateHash,
  entityId,
} from "../server/sync/protocol.mjs";
import { reduce } from "../server/sync/reducer.mjs";
import {
  assertStateCapacity,
  boundedTransport,
  capacityLimits,
  decodeBoundedSnapshot,
} from "../worker/capacity.mjs";
import { boundStore } from "../worker/sync-store.mjs";
import { imageSync } from "../worker/sync-images.mjs";
import { R2ImageStore } from "../worker/images.mjs";
let retained;
// This models PostgreSQL row allocations inside workerd, intentionally keeping
// serialized server rows resident too. SQL branching is explicit: unexpected
// production queries fail the fixture rather than silently succeeding.
function databaseFixture(teamId, initial, probe) {
  const data = {
    link: initial,
    entities: new Map(),
    receipts: new Map(),
    conflicts: new Map(),
    site: new Map(),
    revisions: new Map(),
    pending: [],
    events: 0,
    commits: 0,
    metadataReads: 0,
    usedPreparedPrevious: false,
  };
  const key = (e, k) => e + ":" + k;
  const query = async (sql, args = []) => {
    const rows = (values) => ({ rows: values, rowCount: values.length });
    if (sql.includes("FROM site_maintenance_jobs")) return rows([]);
    if (sql.includes("AS entities") && sql.includes("AS bytes"))
      return rows([
        {
          entities: data.entities.size,
          bytes:
            64 +
            [data.entities, data.receipts, data.conflicts].reduce(
              (total, records) => {
                for (const [key, serialized] of records)
                  total +=
                    Buffer.byteLength(JSON.stringify(key)) +
                    Buffer.byteLength(serialized) +
                    2;
                return total;
              },
              0,
            ) +
            data.pending.reduce(
              (total, operation) =>
                total + Buffer.byteLength(canonical(operation)),
              0,
            ),
        },
      ]);
    if (sql.startsWith("UPDATE team_sync_links")) {
      if (sql.includes("mode='active'")) data.link.mode = "active";
      else if (sql.includes("remote_status="))
        data.link.remote_status = args[1];
      else if (sql.includes("last_error=")) data.link.last_error = args[1];
      else if (sql.includes("SET lease_owner=NULL")) {
        if (data.link.lease_owner === args[1]) data.link.lease_owner = null;
      } else {
        if (data.link.lease_owner) return rows([]);
        data.link.lease_owner = args[1];
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT s.* FROM site_entities"))
      return rows(
        JSON.parse(args[1])
          .map((r) => data.site.get(key(r.entity, r.entity_key)))
          .filter(Boolean)
          .map((r) => ({ ...r })),
      );
    if (sql.startsWith("INSERT INTO site_entity_revisions"))
      return rows(
        JSON.parse(args[1]).map((r) => {
          const id = key(r.entity, r.entity_key),
            revision = Math.max((data.revisions.get(id) || 0) + 1, args[2]);
          data.revisions.set(id, revision);
          return { ...r, revision: String(revision) };
        }),
      );
    if (sql.startsWith("INSERT INTO site_entities")) {
      for (const row of JSON.parse(args[1]))
        data.site.set(key(row.entity, row.entity_key), {
          ...row,
          team_id: teamId,
        });
      await probe("materialize-batch");
      return rows([]);
    }
    if (sql.startsWith("SELECT entity,entity_key FROM site_entities"))
      return rows(
        [...data.site.values()]
          .filter(
            (r) =>
              !r.deleted &&
              args[1].includes(r.entity) &&
              (r.entity > args[2] ||
                (r.entity === args[2] && r.entity_key > args[3])),
          )
          .sort((a, b) =>
            a.entity < b.entity
              ? -1
              : a.entity > b.entity
                ? 1
                : a.entity_key < b.entity_key
                  ? -1
                  : 1,
          )
          .slice(0, 500)
          .map(({ entity, entity_key }) => ({ entity, entity_key })),
      );
    if (sql.startsWith("UPDATE site_entity_revisions")) {
      for (const k of args[1]) {
        const id = key("task", k);
        if (data.revisions.has(id))
          data.revisions.set(id, Math.max(data.revisions.get(id) + 1, args[2]));
      }
      return rows([]);
    }
    if (sql.startsWith("UPDATE site_entities s SET revision=")) {
      for (const k of args[1]) {
        const id = key("task", k),
          r = data.site.get(id);
        if (r) r.revision = data.revisions.get(id);
      }
      return rows([]);
    }
    if (sql.startsWith("UPDATE site_entities s SET deleted=")) {
      for (const r of JSON.parse(args[1]))
        Object.assign(data.site.get(key(r.entity, r.entity_key)), {
          deleted: 1,
          revision: r.revision,
        });
      return rows([]);
    }
    if (sql.startsWith("UPDATE teams SET")) return rows([]);
    throw new Error("Unmodeled production query: " + sql);
  };
  const readState = async () => ({
    entities: Object.fromEntries(
      [...data.entities].map(([id, value]) => [id, JSON.parse(value)]),
    ),
    receipts: Object.fromEntries(
      [...data.receipts].map(([id, value]) => [id, JSON.parse(value)]),
    ),
    conflicts: Object.fromEntries(
      [...data.conflicts].map(([id, value]) => [id, JSON.parse(value)]),
    ),
  });
  const tx = {
    query,
    sync: {
      readLink: async () => ({ ...data.link }),
      readPending: async () => {
        data.metadataReads++;
        return structuredClone(data.pending);
      },
      readExclusions: async () => [],
      appendEvent: async () => ++data.events,
    },
  };
  const db = {
    withTeamTransaction: async (_id, fn) => fn(tx),
    readLink: async () => ({ ...data.link }),
    readState,
    readPending: async () => structuredClone(data.pending),
    commitCanonical: async (
      _id,
      expected,
      head,
      state,
      acks,
      materialize,
      options = {},
    ) => {
      if (data.link.canonical_head !== expected)
        throw new Error("Stale canonical head");
      await probe("before-canonical-write");
      data.usedPreparedPrevious ||= !!options.previousState;
      for (const section of ["entities", "receipts", "conflicts"])
        for (const [id, value] of Object.entries(state[section]))
          if (options.previousState?.[section][id] !== value)
            data[section].set(id, canonical(value));
      data.pending = data.pending.filter((p) => !acks.includes(p.opId));
      await probe("before-materialize");
      await materialize(tx, {
        state,
        pending: structuredClone(data.pending),
        exclusions: [],
      });
      await probe("after-materialize");
      data.link.canonical_head = head;
      data.commits++;
      return { head };
    },
  };
  return { db, data };
}
export default {
  async fetch(request) {
    const input = await request.json(),
      limits = capacityLimits(input.limits || {}),
      bytes = Uint8Array.from(atob(input.snapshot), (c) => c.charCodeAt(0)),
      imageBytes = Uint8Array.from(atob(input.image), (c) => c.charCodeAt(0)),
      genesis = "a".repeat(40),
      tail = "b".repeat(40),
      manifest = {
        protocol: 1,
        reducer: 1,
        teamId: input.teamId,
        repoId: input.repoId,
        bootstrapId: input.bootstrapId,
        genesis: "snapshots/genesis.json.gz",
        genesisHash: digest(bytes),
      },
      imagePath = `images/${input.teamId}/${digest(imageBytes)}.webp`;
    const probe = (phase) =>
      fetch("https://capacity-probe.local/" + phase).then((r) => r.text());
    const { db, data } = databaseFixture(
      input.teamId,
      {
        team_id: input.teamId,
        repo_id: input.repoId,
        bootstrap_id: input.bootstrapId,
        installation_id: "runtime",
        writer_epoch: "epoch",
        mode: "importing",
        canonical_head: null,
      },
      probe,
    );
    let head = genesis,
      event;
    const files = [
        {
          path: "manifest.json",
          oid: "c".repeat(40),
          mode: "100644",
          type: "blob",
        },
        {
          path: manifest.genesis,
          oid: "d".repeat(40),
          mode: "100644",
          type: "blob",
        },
        { path: imagePath, oid: "f".repeat(40), mode: "100644", type: "blob" },
      ],
      transport = boundedTransport(
        {
          readHead: async (branch) =>
            branch && branch !== "sync-v1" ? null : head,
          readCommit: async (oid) => ({
            oid,
            parents: oid === genesis ? [] : [genesis],
            files:
              oid === genesis
                ? files
                : [
                    ...files,
                    {
                      path: "events/tail.json",
                      oid: "e".repeat(40),
                      mode: "100644",
                      type: "blob",
                    },
                  ],
          }),
          readFile: async (_oid, path) =>
            path === "manifest.json"
              ? new TextEncoder().encode(canonical(manifest))
              : path === manifest.genesis
                ? bytes
                : path === imagePath
                  ? imageBytes
                  : new TextEncoder().encode(canonical(event)),
          createCandidate: async () => tail,
          publish: async () => true,
        },
        limits,
      ),
      objects = new Map(),
      r2 = new R2ImageStore(
        {
          head: async (key) => {
            await probe("image-projection");
            return objects.has(key) ? {} : null;
          },
          get: async (key) =>
            objects.has(key)
              ? { arrayBuffer: async () => objects.get(key).buffer }
              : null,
          put: async (key, bytes) => objects.set(key, Uint8Array.from(bytes)),
        },
        input.teamId,
      ),
      images = imageSync(db, { teamId: input.teamId }, r2),
      store = boundStore(db, input.teamId, { limits });
    try {
      const service = new SyncService({
        snapshotDecoder: (bytes) => decodeBoundedSnapshot(bytes, limits),
        transport,
        store,
        images,
        identity: { teamId: input.teamId, repoId: input.repoId },
      });
      await service.run({ receiveOnly: true });
      const state = await db.readState(),
        before = stateHash(state),
        record = Object.values(state.entities).find(
          (e) => e.entity === "cell" && e.key[1] === "description",
        );
      data.pending = input.pending;
      const operation = {
        protocol: 1,
        reducer: 1,
        teamId: input.teamId,
        repoId: input.repoId,
        opId: "tail-operation",
        writerEpoch: "other",
        actorRef: "actor",
        createdAt: "2026-10-26T00:00:00.000Z",
        dependsOn: [],
        objects: [],
        changes: [
          {
            entity: record.entity,
            key: record.key,
            generation: record.generation,
            baseVersion: record.version,
            action: "edit",
            base: record.payload,
            desired: { ...record.payload, value: "Inbound changed" },
            fields: ["value"],
          },
        ],
      };
      event = {
        protocol: 1,
        kind: "operations",
        parent: genesis,
        operations: [operation],
        resultHash: stateHash(reduce(state, operation).state),
      };
      head = tail;
      await service.run({ receiveOnly: true });
      const final = await db.readState();
      retained = { data, objects };
      return Response.json({
        ok: true,
        commits: data.commits,
        cursor: data.link.canonical_head,
        changed: stateHash(final) !== before,
        ...assertStateCapacity(final, limits),
        materialized: data.site.size,
        pending: data.pending.length,
        images: objects.size,
        metadataReads: data.metadataReads,
        usedPreparedPrevious: data.usedPreparedPrevious,
      });
    } catch (error) {
      await probe("capacity-refused");
      retained = { data, objects };
      return Response.json(
        {
          ok: false,
          code: error.code,
          message: error.message,
          commits: data.commits,
          cursor: data.link.canonical_head,
          entities: data.entities.size,
        },
        { status: error.status || 500 },
      );
    }
  },
};
