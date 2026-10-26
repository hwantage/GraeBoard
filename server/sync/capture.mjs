import { HttpError } from "../validation.mjs";
import { LINK_METADATA_COLUMNS } from "../storage/team-store.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { readEntity } from "./entities.mjs";
import { makeOperation } from "./operations.mjs";
import { entityId, initialToken, canonical } from "./protocol.mjs";

// TEMP triggers are a transaction-local change detector, never the replication
// protocol. The first domain before-image and final after-image coalesce normal
// DELETE/INSERT implementations into one immutable user operation.
const detectors = {
  teams: (r) => ["team", [], r.id],
  tasks: (r) => ["task", [r.id], r.team_id],
  cells: (r) => ["cell", [r.task_id, r.key], null, "tasks", r.task_id],
  task_documents: (r) => [
    "document",
    ["task", r.task_id, r.id],
    null,
    "tasks",
    r.task_id,
  ],
  annual_memos: (r) => [
    "document",
    ["annual", String(r.year), r.id],
    r.team_id,
  ],
  reports: (r) => ["report", [r.id], r.team_id],
  report_documents: (r) => [
    "document",
    ["report", r.report_id, r.task_id, r.document_id],
    null,
    "reports",
    r.report_id,
  ],
  report_memos: (r) => [
    "document",
    ["reportMemo", r.report_id, r.id],
    null,
    "reports",
    r.report_id,
  ],
  calendar_entries: (r) => ["calendar", [r.id], r.team_id],
  calendar_entry_tags: (r) => [
    "calendar",
    [r.entry_id],
    null,
    "calendar_entries",
    r.entry_id,
  ],
  calendar_tags: (r) => ["tag", [r.id], r.team_id],
  calendar_rules: (r) => ["rule", [], r.team_id],
  calendar_weekly_items: (r) => [
    "weekly",
    [r.user_id, r.week_start, r.task_id],
    r.team_id,
  ],
  saved_filters: (r) =>
    r.scope === "team" ? ["filter", [r.id], r.team_id] : null,
  format_rules: (r) => ["formats", [], r.team_id],
};
export function installCapture(db, { onPending = () => {} } = {}) {
  const requestActor = new AsyncLocalStorage();
  const triggerDefinitions = new Map();
  let triggersEnabled = false,
    failure = null;
  function reconcileTriggers() {
    const enabled = links.size > 0;
    if (enabled === triggersEnabled || !triggerDefinitions.size) return;
    for (const [name, sql] of triggerDefinitions)
      db.exec(enabled ? sql : `DROP TRIGGER IF EXISTS temp.${name}`);
    triggersEnabled = enabled;
  }
  let active = false,
    suppressed = 0,
    before = new Map(),
    actors = new Map(),
    links = new Map(),
    prior = new Map(),
    created = [],
    restores = new Map(),
    order = 0,
    checkedTeams = new Set(),
    people = null;
  // Keep prepared reads local to capture. The shared entity reader still defines
  // payloads, while each keystroke avoids preparing the same SQLite programs.
  const statements = new Map(),
    reader = {
      prepare(sql) {
        if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
        return statements.get(sql);
      },
    };
  const prepare = (sql) => reader.prepare(sql);
  const rememberPending = (operation) => {
    const position = ++order;
    for (const [index, change] of operation.changes.entries()) {
      const key = operation.teamId + entityId(change.entity, change.key);
      const value = {
        opId: operation.opId,
        version: `${operation.opId}:${index}`,
        generation: change.generation,
        order: position,
      };
      prior.set(key, value);
      if (
        change.action === "restore" &&
        ["task", "calendar"].includes(change.entity)
      )
        restores.set(key, { ...value, generation: value.version });
    }
  };
  const parentRestore = (teamId, entity, key) => {
    if (entity === "cell")
      return restores.get(teamId + entityId("task", [key[0]]));
    if (entity === "document" && ["task", "calendar"].includes(key[0]))
      return restores.get(teamId + entityId(key[0], [key[1]]));
    return undefined;
  };
  const refresh = () => {
    links = new Map(
      prepare(
        `SELECT ${LINK_METADATA_COLUMNS} FROM team_sync_links WHERE mode<>'disconnected'`,
      )
        .all()
        .map((l) => [l.team_id, l]),
    );
    prior = new Map();
    restores = new Map();
    order = 0;
    people = null;
    for (const r of prepare(
      "SELECT payload FROM sync_outbox WHERE status<>'acknowledged' ORDER BY local_seq",
    ).all())
      rememberPending(JSON.parse(r.payload));
    reconcileTriggers();
  };
  refresh();
  const record = (teamId, entity, key) => {
    if (!active || suppressed || !links.has(teamId)) return;
    const mapKey = teamId + entityId(entity, key);
    if (before.has(mapKey)) return;
    if (!checkedTeams.has(teamId)) {
      if (
        prepare(
          "SELECT 1 FROM site_maintenance_jobs WHERE team_id=? AND kind<>'backup' AND phase NOT IN ('complete','cancelled')",
        ).get(teamId)
      )
        throw (failure = new HttpError(
          409,
          "팀 데이터 정리가 진행 중입니다. 입력을 보존하고 잠시 후 저장하세요.",
        ));
      checkedTeams.add(teamId);
    }
    const value = readEntity(reader, teamId, entity, key);
    if (value) {
      let pending = prior.get(mapKey);
      const restored = parentRestore(teamId, entity, key);
      if (restored && (!pending || restored.order > pending.order))
        pending = restored;
      const row =
        pending ||
        prepare(
          "SELECT generation,version FROM sync_entities WHERE team_id=? AND entity=? AND entity_key=?",
        ).get(teamId, entity, canonical(key));
      const token = row
        ? null
        : initialToken(links.get(teamId).bootstrap_id, entity, key);
      value.generation = row?.generation || token;
      value.version = row?.version || token;
    }
    before.set(mapKey, { teamId, entity, key, value });
  };
  db.function("graeboard_sync_before", (table, data) => {
    if (!active || suppressed || !links.size) return 0;
    const row = JSON.parse(data);
    if (table === "audit") {
      if (row.team_id) actors.set(row.team_id, row.actor_id);
      return 0;
    }
    const target = detectors[table]?.(row);
    if (!target) return 0;
    const [entity, key, direct, owner, ownerId] = target,
      teamId =
        direct ||
        prepare(`SELECT team_id FROM ${owner} WHERE id=?`).get(ownerId)
          ?.team_id;
    if (teamId) {
      record(teamId, entity, key);
      // Report edits replace the parent JSON before rebuilding document rows.
      // Capture child titles/order/body while their original parent still exists;
      // a later document DELETE trigger can no longer read that before-image.
      if (table === "reports")
        for (const child of prepare(
          "SELECT task_id,document_id FROM report_documents WHERE report_id=?",
        ).all(row.id))
          record(teamId, "document", [
            "report",
            row.id,
            child.task_id,
            child.document_id,
          ]);
      if (table === "calendar_entries")
        record(teamId, "document", ["calendar", row.id, "main"]);
    }
    return 0;
  });
  // User accounts stay local. Invalidate only the display-reference lookup, even
  // when a control transaction or a received person changes the users table.
  db.function("graeboard_sync_people_changed", () => {
    people = null;
    return 0;
  });
  for (const event of ["INSERT", "UPDATE", "DELETE"])
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS sync_people_${event} AFTER ${event} ON main.users BEGIN SELECT graeboard_sync_people_changed(); END`,
    );
  for (const table of [...Object.keys(detectors), "audit"]) {
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .filter((c) => c.type !== "BLOB")
      .map((c) => c.name);
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      const prefix = event === "DELETE" ? "OLD" : "NEW";
      // Only identity/context columns are passed, not body/settings/password data.
      const keep = columns.filter((c) =>
        [
          "id",
          "team_id",
          "task_id",
          "key",
          "year",
          "report_id",
          "document_id",
          "entry_id",
          "user_id",
          "week_start",
          "scope",
          "actor_id",
        ].includes(c),
      );
      // Cell writes touch the task's local updated_at on every save. It is not
      // shared task content and must not trigger two complete task/style reads.
      const when =
        table === "tasks" && event === "UPDATE"
          ? ` WHEN ${["id", "team_id", "years", "position", "deleted_at", "default_style", "row_style", "created_by", "created_at"].map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")}`
          : "";
      triggerDefinitions.set(
        `sync_detect_${table}_${event}`,
        `CREATE TEMP TRIGGER IF NOT EXISTS sync_detect_${table}_${event} BEFORE ${event} ON main.${table}${when} BEGIN SELECT graeboard_sync_before('${table}',json_object(${keep.map((c) => `'${c}',${prefix}.${c}`).join(",")})); END`,
      );
    }
  }
  reconcileTriggers();
  const capture = {
    get failure() {
      return failure;
    },
    withActor(actorId, work) {
      return requestActor.run(actorId, work);
    },
    begin() {
      failure = null;
      active = links.size > 0;
      if (!active) return;
      before = new Map();
      actors = new Map();
      created = [];
      checkedTeams = new Set();
    },
    flush() {
      if (suppressed || !before.size) return;
      const teams = new Map();
      for (const item of before.values()) {
        if (!teams.has(item.teamId))
          teams.set(item.teamId, { before: {}, after: {} });
        const group = teams.get(item.teamId),
          key = entityId(item.entity, item.key);
        group.before[key] = item.value;
        group.after[key] = readEntity(
          reader,
          item.teamId,
          item.entity,
          item.key,
        );
      }
      for (const [teamId, group] of teams) {
        const link = links.get(teamId);
        const actorRef =
          requestActor.getStore() ||
          actors.get(teamId) ||
          `system:${link.installation_id}`;
        // Referenced people are display-only and are captured in the same command
        // before content can reference a newly registered local person.
        people ||= prepare("SELECT id,name FROM users").all();
        const content = JSON.stringify(group.after);
        for (const person of people)
          if (person.id === actorRef || content.includes(person.id)) {
            const key = entityId("person", [person.id]);
            if (
              !prior.has(teamId + key) &&
              !prepare(
                "SELECT 1 FROM sync_entities WHERE team_id=? AND entity='person' AND entity_key=?",
              ).get(teamId, canonical([person.id]))
            ) {
              group.before[key] = null;
              group.after[key] = {
                entity: "person",
                key: [person.id],
                payload: { name: person.name },
                deleted: false,
              };
            }
          }
        const operation = makeOperation({
          link,
          actorRef,
          ...group,
          getPrior: (key) => prior.get(teamId + key)?.opId,
        });
        if (operation) {
          // Hashing and Git preparation happen in the background. The immutable
          // JSON and ID are already durable with the business transaction.
          prepare(
            "INSERT INTO sync_outbox(op_id,team_id,payload,status,created_at) VALUES(?,?,?,'pending',?)",
          ).run(
            operation.opId,
            teamId,
            canonical(operation),
            operation.createdAt,
          );
          created.push(operation);
        }
      }
    },
    committed() {
      active = false;
      for (const op of created) {
        rememberPending(op);
        // The local transaction has committed; a scheduling failure must not
        // turn a durable save into a misleading HTTP failure. P remains durable.
        try {
          onPending(op.teamId);
        } catch (error) {
          console.error("Sync scheduling failed:", error.message);
        }
      }
      before.clear();
      created = [];
    },
    rollback() {
      active = false;
      before.clear();
      created = [];
      people = null;
    },
    refresh,
    acknowledged(teamId, opIds) {
      const link = prepare(
        `SELECT ${LINK_METADATA_COLUMNS} FROM team_sync_links WHERE team_id=?`,
      ).get(teamId);
      if (link && link.mode !== "disconnected") links.set(teamId, link);
      else links.delete(teamId);
      const ids = new Set(opIds);
      for (const map of [prior, restores])
        for (const [key, value] of map)
          if (key.startsWith(teamId) && ids.has(value.opId)) map.delete(key);
    },
    without(work) {
      suppressed++;
      try {
        return work();
      } finally {
        suppressed--;
      }
    },
  };
  db.syncCapture = capture;
  return capture;
}
