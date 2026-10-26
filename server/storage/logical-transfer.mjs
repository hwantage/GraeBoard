import { randomUUID } from "node:crypto";
import {
  TEAM_TRANSFER_TABLES,
  portableRow,
  databaseRow,
  sealTransfer,
  verifyTransfer,
  portableHash,
} from "./logical-format.mjs";
import { canonical, digest, entityId, ENTITIES } from "../sync/protocol.mjs";
import { SqliteDatabase } from "./sqlite.mjs";
import { allEntities, materialize } from "../sync/entities.mjs";
import { readFormatting } from "../db.mjs";

const SHARED = TEAM_TRANSFER_TABLES.filter(
  ([name]) =>
    !["site_entities", "site_audit", "site_operations"].includes(name),
);
const archiveTables = [
  "document_versions",
  "views",
  "saved_filters",
  "filter_states",
  "audit",
  "imports",
];
const stamp = () => new Date().toISOString();

function sqliteRevision(db, teamId, entity, key) {
  const [a, b, c] = key,
    one = (sql, ...args) => db.prepare(sql).get(...args);
  const high =
    one(
      "SELECT revision FROM site_entity_revisions WHERE team_id=? AND entity=? AND entity_key=?",
      teamId,
      entity,
      canonical(key),
    )?.revision || 0;
  let revision = 0;
  if (entity === "cell")
    revision =
      one("SELECT version FROM cells WHERE task_id=? AND key=?", a, b)
        ?.version || 0;
  if (entity === "task")
    revision =
      Date.parse(
        one("SELECT updated_at FROM tasks WHERE id=?", a)?.updated_at,
      ) || 0;
  if (entity === "formats") revision = readFormatting(db, teamId).revision;
  if (entity === "team")
    revision =
      JSON.parse(one("SELECT settings FROM teams WHERE id=?", teamId).settings)
        .revision || 0;
  if (entity === "document") {
    if (a === "task")
      revision =
        one(
          "SELECT revision FROM task_documents WHERE task_id=? AND id=?",
          b,
          c,
        )?.revision || 0;
    if (a === "annual")
      revision =
        one(
          "SELECT revision FROM annual_memos WHERE team_id=? AND year=? AND id=?",
          teamId,
          Number(b),
          c,
        )?.revision || 0;
    if (a === "reportMemo")
      revision =
        one(
          "SELECT revision FROM report_memos WHERE report_id=? AND id=?",
          b,
          c,
        )?.revision || 0;
    if (a === "calendar")
      revision =
        one("SELECT revision FROM calendar_entries WHERE id=?", b)?.revision ||
        0;
  }
  if (entity === "calendar")
    revision =
      one("SELECT revision FROM calendar_entries WHERE id=?", a)?.revision || 0;
  if (entity === "tag")
    revision =
      one("SELECT revision FROM calendar_tags WHERE id=?", a)?.revision || 0;
  if (entity === "rule")
    revision =
      one("SELECT revision FROM calendar_rules WHERE team_id=?", teamId)
        ?.revision || 0;
  return Math.max(high, revision);
}
function sqlitePresentation(db, teamId, link) {
  const entities = allEntities(db, {
    ...link,
    team_id: teamId,
    bootstrap_id: link?.bootstrap_id || randomUUID(),
  });
  const rows = Object.values(entities).map((e) => ({
    team_id: teamId,
    entity: e.entity,
    entity_key: canonical(e.key),
    payload: canonical(e.payload),
    revision: sqliteRevision(db, teamId, e.entity, e.key),
    deleted: Number(e.deleted),
  }));
  // Preserve local historical data without placing it into C or the Git log.
  // Current shared presentation is materialized from the portable rows on return;
  // this archive carries historical bodies, audit and personal local preferences.
  const local = {};
  for (const table of archiveTables)
    local[table] = db
      .prepare(`SELECT * FROM ${table} WHERE team_id=? ORDER BY rowid`)
      .all(teamId)
      .map(portableRow);
  const people = new Set(
    Object.values(entities)
      .filter((e) => e.entity === "person")
      .map((e) => e.key[0]),
  );
  for (const data of Object.values(local))
    for (const row of data)
      for (const k of ["actor_id", "created_by", "user_id", "owner_id"])
        if (row[k]) people.add(row[k]);
  local.people = [...people]
    .map((id) =>
      db
        .prepare(
          "SELECT id,name,color,avatar_initials,avatar_image,created_at FROM users WHERE id=?",
        )
        .get(id),
    )
    .filter(Boolean)
    .map(portableRow);
  rows.push({
    team_id: teamId,
    entity: "localArchive",
    entity_key: '["sqlite-v30"]',
    payload: canonical(local),
    revision: 0,
    deleted: 0,
  });
  for (const object of db
    .prepare(
      "SELECT data FROM sync_objects WHERE team_id=? AND kind='local-transfer-metadata'",
    )
    .all(teamId)) {
    const saved = JSON.parse(Buffer.from(object.data).toString());
    for (const row of saved.site_entities || [])
      if (
        !rows.some(
          (current) =>
            current.entity === row.entity &&
            current.entity_key === row.entity_key,
        )
      )
        rows.push(row);
  }
  return rows.sort(
    (a, b) =>
      a.entity.localeCompare(b.entity) ||
      a.entity_key.localeCompare(b.entity_key),
  );
}

export async function exportTeam(
  adapter,
  teamId,
  { requireFrozen = true, omitJobId } = {},
) {
  const capture = async (tx) => {
    const link = await tx.sync.readLink();
    if (
      requireFrozen &&
      link &&
      !["paused", "recovery", "disconnected"].includes(link.mode)
    )
      throw new Error(
        "Pause synchronization and freeze writes before logical transfer",
      );
    const tables = {};
    for (const [table, order] of TEAM_TRANSFER_TABLES) {
      if (
        adapter.engine === "sqlite" &&
        ["site_entities", "site_audit", "site_operations"].includes(table)
      )
        continue;
      const rows = (
        await tx.query(
          `SELECT * FROM ${table} WHERE ${table === "teams" ? "id" : "team_id"}=$1 ORDER BY ${order}`,
          [teamId],
        )
      ).rows;
      tables[table] = rows
        .filter(
          (row) =>
            table !== "site_maintenance_jobs" || row.job_id !== omitJobId,
        )
        .map(portableRow);
    }
    if (adapter.engine === "sqlite")
      throw new Error("Unexpected asynchronous SQLite export");
    return sealTransfer({
      teamId,
      sourceEngine: adapter.engine,
      createdAt: stamp(),
      tables,
    });
  };
  if (adapter.engine !== "sqlite")
    return adapter.withTeamTransaction(teamId, capture, { readOnly: true });
  return adapter.withTeamTransaction(
    teamId,
    (tx) => {
      const link = tx.sync.readLink();
      if (
        requireFrozen &&
        link &&
        !["paused", "recovery", "disconnected"].includes(link.mode)
      )
        throw new Error(
          "Pause synchronization and freeze writes before logical transfer",
        );
      const tables = {};
      for (const [table, order] of SHARED)
        tables[table] = tx
          .query(
            `SELECT * FROM ${table} WHERE ${table === "teams" ? "id" : "team_id"}=$1 ORDER BY ${order}`,
            [teamId],
          )
          .rows.filter(
            (row) =>
              table !== "site_maintenance_jobs" || row.job_id !== omitJobId,
          )
          .map(portableRow);
      tables.site_entities = sqlitePresentation(adapter.db, teamId, link);
      tables.site_audit = [];
      tables.site_operations = [];
      for (const object of tables.sync_objects.filter(
        (r) => r.kind === "local-transfer-metadata",
      )) {
        const saved = JSON.parse(
          Buffer.from(object.data.$bytes, "base64").toString(),
        );
        tables.site_audit = saved.site_audit || [];
        tables.site_operations = saved.site_operations || [];
      }
      return sealTransfer({
        teamId,
        sourceEngine: "sqlite",
        createdAt: stamp(),
        tables,
      });
    },
    { readOnly: true },
  );
}

export async function freezeTeam(adapter, teamId) {
  const jobId = randomUUID();
  const run = (tx) => {
    const work = function* () {
      const link = yield tx.sync.readLink();
      if (link?.lease_owner)
        throw new Error(
          "Wait for the current synchronization cycle before transfer",
        );
      if (
        (yield tx.query(
          "SELECT 1 FROM site_maintenance_jobs WHERE team_id=$1 AND phase NOT IN ('complete','cancelled')",
          [teamId],
        )).rows.length
      )
        throw new Error("Another maintenance job is active");
      yield tx.query(
        "INSERT INTO site_maintenance_jobs(job_id,team_id,kind,phase,manifest,progress,created_at) VALUES($1,$2,'logical-transfer','frozen',$3,'{}',$4)",
        [
          jobId,
          teamId,
          canonical({ previousMode: link?.mode || null }),
          stamp(),
        ],
      );
      if (link)
        yield tx.query(
          "UPDATE team_sync_links SET mode='paused',generation=generation+1 WHERE team_id=$1",
          [teamId],
        );
      return jobId;
    };
    return executeWork(adapter, work());
  };
  return adapter.withTeamTransaction(teamId, run);
}
function executeWork(adapter, generator) {
  if (adapter.engine === "sqlite") {
    let step = generator.next();
    while (!step.done) step = generator.next(step.value);
    return step.value;
  }
  return (async () => {
    let step = generator.next();
    while (!step.done) step = generator.next(await step.value);
    return step.value;
  })();
}
export async function releaseTransfer(adapter, teamId, jobId) {
  return adapter.withTeamTransaction(teamId, (tx) =>
    executeWork(
      adapter,
      (function* () {
        const row = (yield tx.query(
          "SELECT manifest FROM site_maintenance_jobs WHERE team_id=$1 AND job_id=$2 AND kind='logical-transfer' AND phase='frozen'",
          [teamId, jobId],
        )).rows[0];
        if (!row) throw new Error("Frozen logical transfer job not found");
        // Releasing a source is explicit. Keep synchronization paused until the
        // operator reconciles any target writes; never revive duplicate writers.
        yield tx.query(
          "UPDATE site_maintenance_jobs SET phase='complete' WHERE job_id=$1",
          [jobId],
        );
      })(),
    ),
  );
}
function insert(tx, table, row, postgres) {
  const data = databaseRow(row),
    keys = Object.keys(data);
  return tx.query(
    `INSERT INTO ${table}(${keys.join(",")}) ${postgres && ["sync_outbox", "site_events"].includes(table) ? "OVERRIDING SYSTEM VALUE " : ""}VALUES(${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
    Object.values(data),
  );
}
function restoredTables(payload, { profileId, installationId } = {}) {
  const tables = structuredClone(payload.tables),
    link = tables.team_sync_links[0];
  if (link) {
    const oldSite = link.installation_id;
    Object.assign(link, {
      mode: "recovery",
      writer_epoch: randomUUID(),
      generation: Number(link.generation) + 1,
      lease_owner: null,
      lease_until: null,
      remote_status: null,
      last_error: "Logical restore requires canonical reconciliation",
      updated_at: stamp(),
    });
    if (profileId) link.profile_id = profileId;
    if (installationId) {
      link.installation_id = installationId;
      for (const row of tables.site_retention)
        if (row.site_id === oldSite) row.site_id = installationId;
    }
  }
  return tables;
}
function restoreSqlitePresentation(db, teamId, rows) {
  const archive = rows.find(
    (row) =>
      row.entity === "localArchive" && row.entity_key === '["sqlite-v30"]',
  );
  const local = archive ? JSON.parse(archive.payload) : {};
  const shared = rows.filter((row) => ENTITIES.has(row.entity));
  const records = Object.fromEntries(
    shared.map((row) => {
      const key = JSON.parse(row.entity_key);
      return [
        entityId(row.entity, key),
        {
          entity: row.entity,
          key,
          payload: JSON.parse(row.payload),
          deleted: !!row.deleted,
        },
      ];
    }),
  );
  const people = new Map((local.people || []).map((row) => [row.id, row]));
  for (const record of Object.values(records))
    if (record.entity === "person")
      people.set(record.key[0], {
        id: record.key[0],
        name: record.payload.name,
        created_at: stamp(),
      });
  for (const person of people.values())
    db.prepare(
      "INSERT INTO users(id,username,name,password,active,created_at) VALUES(?,?,?,'!',0,?) ON CONFLICT(id) DO NOTHING",
    ).run(
      person.id,
      "sync-" + person.id + "@invalid.local",
      person.name,
      person.created_at,
    );
  const tx = {
    query(sql, params) {
      const bound = [];
      const statement = db.prepare(
        sql.replace(/\$(\d+)/g, (_, n) => {
          bound.push(params[Number(n) - 1]);
          return "?";
        }),
      );
      return statement.run(...bound);
    },
  };
  for (const row of local.document_versions || [])
    insert(tx, "document_versions", row, false);
  materialize(db, teamId, records);
  for (const table of [
    "views",
    "saved_filters",
    "filter_states",
    "audit",
    "imports",
  ])
    for (const row of local[table] || []) {
      if (table === "saved_filters" && row.scope === "team") continue;
      insert(tx, table, row, false);
    }
  for (const row of shared) {
    const [a, b, c] = JSON.parse(row.entity_key),
      r = Number(row.revision);
    if (!Number.isSafeInteger(r) || r < 0)
      throw new Error("Invalid local revision");
    if (row.entity === "cell")
      db.prepare("UPDATE cells SET version=? WHERE task_id=? AND key=?").run(
        r,
        a,
        b,
      );
    if (row.entity === "task" && r)
      db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(
        new Date(r).toISOString(),
        a,
      );
    if (row.entity === "team") {
      const payload = JSON.parse(row.payload);
      db.prepare("UPDATE teams SET name=?,settings=? WHERE id=?").run(
        payload.name,
        JSON.stringify({ ...payload.settings, revision: r }),
        teamId,
      );
    }
    if (row.entity === "formats")
      db.prepare("UPDATE format_states SET revision=? WHERE team_id=?").run(
        r,
        teamId,
      );
    if (row.entity === "document") {
      if (a === "task")
        db.prepare(
          "UPDATE task_documents SET revision=? WHERE task_id=? AND id=?",
        ).run(r, b, c);
      if (a === "annual")
        db.prepare(
          "UPDATE annual_memos SET revision=? WHERE team_id=? AND year=? AND id=?",
        ).run(r, teamId, Number(b), c);
      if (a === "reportMemo")
        db.prepare(
          "UPDATE report_memos SET revision=? WHERE report_id=? AND id=?",
        ).run(r, b, c);
    }
    for (const [entity, table] of [
      ["calendar", "calendar_entries"],
      ["tag", "calendar_tags"],
    ])
      if (row.entity === entity)
        db.prepare(`UPDATE ${table} SET revision=? WHERE id=?`).run(r, a);
    if (row.entity === "rule")
      db.prepare("UPDATE calendar_rules SET revision=? WHERE team_id=?").run(
        r,
        teamId,
      );
  }
}

export async function importTeam(adapter, bundle, options = {}) {
  const payload = verifyTransfer(bundle),
    teamId = payload.teamId,
    tables = restoredTables(payload, options);
  if (adapter.engine === "sqlite" && payload.sourceEngine !== "sqlite") {
    const extra = {
      site_entities: tables.site_entities.filter(
        (row) => !ENTITIES.has(row.entity),
      ),
      site_audit: tables.site_audit,
      site_operations: tables.site_operations,
    };
    const data = Buffer.from(canonical(extra)),
      hash = digest(data);
    if (!tables.sync_objects.some((row) => row.hash === hash))
      tables.sync_objects.push({
        team_id: teamId,
        hash,
        kind: "local-transfer-metadata",
        data: { $bytes: data.toString("base64") },
        size: data.length,
      });
    tables.sync_objects.sort((a, b) => a.hash.localeCompare(b.hash));
  }
  return adapter.withTeamTransaction(
    teamId,
    (tx) =>
      executeWork(
        adapter,
        (function* () {
          if (options.restoreToken) {
            const prior = (yield tx.query(
              "SELECT manifest FROM site_maintenance_jobs WHERE team_id=$1 AND job_id=$2 AND kind='external-restore' AND phase='complete'",
              [teamId, "restore-" + options.restoreToken],
            )).rows[0];
            if (prior) {
              const link = yield tx.sync.readLink(),
                outbox = (yield tx.query(
                  "SELECT * FROM sync_outbox WHERE team_id=$1 ORDER BY local_seq",
                  [teamId],
                )).rows.map(portableRow);
              if (
                JSON.parse(prior.manifest).bundleHash !== bundle.hash ||
                (link && link.mode !== "recovery") ||
                portableHash(outbox) !== portableHash(tables.sync_outbox)
              )
                throw new Error(
                  "Previously restored target changed; preserve newer writes before retry",
                );
              return {
                teamId,
                alreadyRestored: true,
                recovery: true,
                hash: bundle.hash,
              };
            }
          }
          for (const [table] of TEAM_TRANSFER_TABLES) {
            if (
              table === "teams" ||
              (adapter.engine === "sqlite" &&
                ["site_entities", "site_audit", "site_operations"].includes(
                  table,
                ))
            )
              continue;
            if (
              (yield tx.query(
                `SELECT 1 FROM ${table} WHERE team_id=$1 LIMIT 1`,
                [teamId],
              )).rows.length
            )
              throw new Error("Logical import requires an empty target team");
          }
          if (adapter.engine === "sqlite")
            for (const table of [
              "tasks",
              "reports",
              "annual_memos",
              "document_versions",
              "calendar_entries",
              "calendar_tags",
              "calendar_rules",
              "calendar_weekly_items",
              "views",
              "saved_filters",
              "filter_states",
              "audit",
              "imports",
              "format_rules",
            ])
              if (
                (yield tx.query(
                  `SELECT 1 FROM ${table} WHERE team_id=$1 LIMIT 1`,
                  [teamId],
                )).rows.length
              )
                throw new Error("Logical import requires an empty target team");
          const team = tables.teams[0];
          yield tx.query("UPDATE teams SET name=$2,settings=$3 WHERE id=$1", [
            teamId,
            team.name,
            team.settings,
          ]);
          for (const [table] of TEAM_TRANSFER_TABLES) {
            if (
              table === "teams" ||
              (adapter.engine === "sqlite" &&
                ["site_entities", "site_audit", "site_operations"].includes(
                  table,
                ))
            )
              continue;
            for (const row of tables[table])
              yield insert(tx, table, row, adapter.engine === "postgres");
          }
          if (adapter.engine === "sqlite") {
            restoreSqlitePresentation(adapter.db, teamId, tables.site_entities);
            if (adapter.db.prepare("PRAGMA foreign_key_check").all().length)
              throw new Error("Logical import foreign key check failed");
          } else
            for (const [table, column] of [
              ["sync_outbox", "local_seq"],
              ["site_events", "cursor"],
            ])
              yield tx.query(
                `SELECT setval(pg_get_serial_sequence($1,$2),GREATEST(COALESCE((SELECT MAX(${column}) FROM ${table}),0),1),COALESCE((SELECT MAX(${column}) FROM ${table}),0)>0)`,
                ["graeboard." + table, column],
              );
          // Verify the unmodified protocol rows within the same transaction. Recovery
          // changes only local identity/fences; C, P, receipts and conflicts stay exact.
          for (const [table, order] of SHARED.filter(
            ([table]) =>
              ![
                "teams",
                "team_sync_links",
                "site_retention",
                "sync_person_refs",
              ].includes(table),
          )) {
            const actual = (yield tx.query(
              `SELECT * FROM ${table} WHERE team_id=$1 ORDER BY ${order}`,
              [teamId],
            )).rows.map(portableRow);
            if (portableHash(actual) !== portableHash(tables[table]))
              throw new Error("Logical import verification failed: " + table);
          }
          if (options.restoreToken)
            yield tx.query(
              "INSERT INTO site_maintenance_jobs(job_id,team_id,kind,phase,manifest,progress,created_at) VALUES($1,$2,'external-restore','complete',$3,'{}',$4)",
              [
                "restore-" + options.restoreToken,
                teamId,
                canonical({ bundleHash: bundle.hash }),
                stamp(),
              ],
            );
          return {
            teamId,
            recovery: !!tables.team_sync_links.length,
            hash: bundle.hash,
          };
        })(),
      ),
    { createTeam: tables.teams[0] },
  );
}
