import { applicationEntities } from "../server/sync/versions.mjs";
import {
  canonical,
  entityId,
  equal,
  ENTITIES,
} from "../server/sync/protocol.mjs";
import { project } from "../server/sync/reducer.mjs";
import { isExcluded as excluded } from "../server/sync/retention.mjs";
import {
  pendingEntityKeys,
  canRetireProjection,
} from "../server/sync/projection.mjs";
import { CanonicalSlice, reduceSlice } from "./sync-partial.mjs";

// Writes projected records to the site rows that differ from them, retires
// rows, then bumps the owning tasks and announces the change once.
function siteWriter(tx, teamId, visible, exclusions) {
  const touched = new Set(),
    now = Date.now();
  let changedCount = 0;
  const revisions = async (batch) =>
    (
      await tx.query(
        `INSERT INTO site_entity_revisions(team_id,entity,entity_key,revision) SELECT $1,r.entity,r.entity_key,$3 FROM jsonb_to_recordset($2::jsonb) AS r(entity text,entity_key text) ON CONFLICT(team_id,entity,entity_key) DO UPDATE SET revision=GREATEST(site_entity_revisions.revision+1,EXCLUDED.revision) RETURNING entity,entity_key,revision`,
        [
          teamId,
          canonical(
            batch.map(({ entity, entity_key }) => ({ entity, entity_key })),
          ),
          now,
        ],
      )
    ).rows;
  const write = async (batch) => {
    if (!batch.length) return;
    const byId = new Map(
      (await revisions(batch)).map((r) => [
        r.entity + ":" + r.entity_key,
        r.revision,
      ]),
    );
    for (const row of batch)
      row.revision = Number(byId.get(row.entity + ":" + row.entity_key));
    await tx.query(
      `INSERT INTO site_entities(team_id,entity,entity_key,payload,revision,deleted) SELECT $1,r.entity,r.entity_key,r.payload,r.revision,r.deleted FROM jsonb_to_recordset($2::jsonb) AS r(entity text,entity_key text,payload text,revision bigint,deleted integer) ON CONFLICT(team_id,entity,entity_key) DO UPDATE SET payload=EXCLUDED.payload,revision=EXCLUDED.revision,deleted=EXCLUDED.deleted`,
      [teamId, canonical(batch)],
    );
    changedCount += batch.length;
  };
  const apply = async (records) => {
    const keys = records.map((e) => ({
        entity: e.entity,
        entity_key: canonical(e.key),
      })),
      rows = (
        await tx.query(
          `SELECT s.* FROM site_entities s JOIN jsonb_to_recordset($2::jsonb) AS wanted(entity text,entity_key text) ON s.entity=wanted.entity AND s.entity_key=wanted.entity_key WHERE s.team_id=$1`,
          [teamId, canonical(keys)],
        )
      ).rows,
      previous = new Map(
        rows.map((row) => [row.entity + ":" + row.entity_key, row]),
      ),
      changes = [];
    for (const e of records) {
      const hidden = excluded(e, visible, exclusions),
        old = previous.get(e.entity + ":" + canonical(e.key)),
        oldPayload = old ? JSON.parse(old.payload) : null,
        soft = ["task", "calendar"].includes(e.entity),
        payload = soft
          ? {
              ...e.payload,
              deletedAt: e.deleted
                ? oldPayload?.deletedAt ||
                  e.payload.deletedAt ||
                  new Date(now).toISOString()
                : null,
            }
          : e.payload,
        deleted = hidden || (e.deleted && !soft);
      if (!old || !!old.deleted !== deleted || !equal(oldPayload, payload)) {
        changes.push({
          entity: e.entity,
          entity_key: canonical(e.key),
          payload: canonical(payload),
          deleted: deleted ? 1 : 0,
        });
        if (
          e.entity === "cell" ||
          (e.entity === "document" && e.key[0] === "task")
        )
          touched.add(e.entity === "cell" ? e.key[0] : e.key[1]);
      }
    }
    await write(changes);
  };
  const retire = async (rows) => {
    if (!rows.length) return;
    const revs = await revisions(rows);
    await tx.query(
      `UPDATE site_entities s SET deleted=1,revision=r.revision FROM jsonb_to_recordset($2::jsonb) AS r(entity text,entity_key text,revision bigint) WHERE s.team_id=$1 AND s.entity=r.entity AND s.entity_key=r.entity_key`,
      [
        teamId,
        canonical(revs.map((r) => ({ ...r, revision: Number(r.revision) }))),
      ],
    );
    changedCount += rows.length;
  };
  const finish = async () => {
    if (touched.size) {
      const ids = [...touched].map((id) => canonical([id]));
      await tx.query(
        `UPDATE site_entity_revisions SET revision=GREATEST(revision+1,$3) WHERE team_id=$1 AND entity='task' AND entity_key=ANY($2::text[])`,
        [teamId, ids, now],
      );
      await tx.query(
        `UPDATE site_entities s SET revision=r.revision FROM site_entity_revisions r WHERE s.team_id=$1 AND s.entity='task' AND s.entity_key=ANY($2::text[]) AND r.team_id=s.team_id AND r.entity=s.entity AND r.entity_key=s.entity_key`,
        [teamId, ids],
      );
    }
    const team = visible[entityId("team", [])];
    if (team && !team.deleted)
      await tx.query("UPDATE teams SET name=$2,settings=$3 WHERE id=$1", [
        teamId,
        team.payload.name,
        canonical(team.payload.settings),
      ]);
    if (changedCount)
      await tx.sync.appendEvent("changed", { teamId, source: "sync" });
  };
  return { apply, retire, finish };
}
async function siteExclusions(tx, exclusions) {
  const link = await tx.sync.readLink();
  return exclusions.filter(
    (row) => (row.site_id || row.siteId) === link?.installation_id,
  );
}
export async function materialize(
  tx,
  teamId,
  { state, pending, exclusions, previousState = null },
) {
  exclusions = await siteExclusions(tx, exclusions);
  const visible = applicationEntities(project(state, pending).entities),
    protectedKeys = pendingEntityKeys(pending),
    site = siteWriter(tx, teamId, visible, exclusions);
  // With the previous canonical state known, only entities whose projection
  // changed need a row comparison; rows that vanished are retired below.
  const previousVisible = previousState
    ? applicationEntities(project(previousState, pending).entities)
    : null;
  let batch = [];
  for (const id in visible) {
    if (previousVisible && equal(previousVisible[id], visible[id])) continue;
    batch.push(visible[id]);
    if (batch.length === 500) {
      await site.apply(batch);
      batch = [];
    }
  }
  if (batch.length) await site.apply(batch);
  // Retire removed canonical rows in bounded pages without loading their bodies.
  let after = ["", ""];
  for (;;) {
    const rows = (
      await tx.query(
        "SELECT entity,entity_key FROM site_entities WHERE team_id=$1 AND entity=ANY($2::text[]) AND deleted=0 AND (entity,entity_key)>($3,$4) ORDER BY entity,entity_key LIMIT 500",
        [teamId, [...ENTITIES], ...after],
      )
    ).rows;
    if (!rows.length) break;
    const missing = rows.filter((row) =>
      canRetireProjection(
        entityId(row.entity, JSON.parse(row.entity_key)),
        visible,
        protectedKeys,
      ),
    );
    await site.retire(missing);
    after = [rows.at(-1).entity, rows.at(-1).entity_key];
    if (rows.length < 500) break;
  }
  await site.finish();
}
// After a slice commit (see reduceSlice) only records that commit changed, or
// that remaining pending operations touch, can project differently. They are
// projected over the same slice and compared with their site rows; nothing
// else is read. Unlike materialize(), rows outside them are not re-checked.
export async function materializeSlice(
  tx,
  teamId,
  { base, state, pending, exclusions },
) {
  exclusions = await siteExclusions(tx, exclusions);
  const keys = new Set();
  for (const [id, record] of Object.entries(state.entities))
    if (record !== base.entities[id]) keys.add(id);
  const slice = new CanonicalSlice(tx, teamId);
  await slice.include(pending).load(state);
  const { state: projected } = reduceSlice(
    state,
    pending,
    null,
    await slice.context(state),
  );
  const visible = applicationEntities(projected.entities),
    protectedKeys = pendingEntityKeys(pending),
    site = siteWriter(tx, teamId, visible, exclusions);
  for (const [id, record] of Object.entries(projected.entities))
    if (record !== state.entities[id]) keys.add(id);
  for (const op of pending)
    for (const change of op.changes)
      keys.add(entityId(change.entity, change.key));
  const records = [],
    gone = [];
  for (const id of keys)
    if (visible[id]) records.push(visible[id]);
    else if (canRetireProjection(id, visible, protectedKeys)) {
      const [entity, key] = JSON.parse(id);
      gone.push({ entity, entity_key: canonical(key) });
    }
  for (let i = 0; i < records.length; i += 500)
    await site.apply(records.slice(i, i + 500));
  if (gone.length)
    await site.retire(
      (
        await tx.query(
          `SELECT s.entity,s.entity_key FROM site_entities s JOIN jsonb_to_recordset($2::jsonb) AS g(entity text,entity_key text) ON s.entity=g.entity AND s.entity_key=g.entity_key WHERE s.team_id=$1 AND s.deleted=0`,
          [teamId, canonical(gone)],
        )
      ).rows,
    );
  await site.finish();
}
