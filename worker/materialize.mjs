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
export async function materialize(tx, teamId, { state, pending, exclusions }) {
  const link = await tx.sync.readLink();
  exclusions = exclusions.filter(
    (row) => (row.site_id || row.siteId) === link?.installation_id,
  );
  const visible = applicationEntities(project(state, pending).entities),
    protectedKeys = pendingEntityKeys(pending),
    touched = new Set(),
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
  let batch = [];
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
  for (const id in visible) {
    batch.push(visible[id]);
    if (batch.length === 500) {
      await apply(batch);
      batch = [];
    }
  }
  if (batch.length) await apply(batch);
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
    if (missing.length) {
      const revs = await revisions(missing);
      await tx.query(
        `UPDATE site_entities s SET deleted=1,revision=r.revision FROM jsonb_to_recordset($2::jsonb) AS r(entity text,entity_key text,revision bigint) WHERE s.team_id=$1 AND s.entity=r.entity AND s.entity_key=r.entity_key`,
        [
          teamId,
          canonical(revs.map((r) => ({ ...r, revision: Number(r.revision) }))),
        ],
      );
      changedCount += missing.length;
    }
    after = [rows.at(-1).entity, rows.at(-1).entity_key];
    if (rows.length < 500) break;
  }
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
}
