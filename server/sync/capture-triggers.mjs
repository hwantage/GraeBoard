// TEMP triggers are a transaction-local change detector, never the replication
// protocol. The first domain before-image and final after-image coalesce normal
// DELETE/INSERT implementations into one immutable user operation.
export const captureDetectors = {
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

export function defineCaptureTriggers(db, triggerDefinitions) {
  for (const table of [...Object.keys(captureDetectors), "audit"]) {
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
      const taskColumns = [
          "id",
          "team_id",
          "years",
          "position",
          "deleted_at",
          "default_style",
          "row_style",
          "created_by",
          "created_at",
        ],
        taskUpdate = table === "tasks" && event === "UPDATE",
        detectedEvent = taskUpdate
          ? `UPDATE OF ${taskColumns.join(",")}`
          : event,
        teamExpression = columns.includes("team_id")
          ? `${prefix}.team_id`
          : table === "cells" || table === "task_documents"
            ? `(SELECT team_id FROM tasks WHERE id=${prefix}.task_id)`
            : table === "report_documents" || table === "report_memos"
              ? `(SELECT team_id FROM reports WHERE id=${prefix}.report_id)`
              : `(SELECT team_id FROM calendar_entries WHERE id=${prefix}.entry_id)`,
        conditions = [
          `EXISTS(SELECT 1 FROM sync_capture_teams WHERE team_id=${table === "teams" ? `${prefix}.id` : teamExpression})`,
        ];
      if (taskUpdate)
        conditions.push(
          `(${taskColumns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")})`,
        );
      // An UPSERT that finds an existing cell runs only its UPDATE detector.
      if (table === "cells" && event === "INSERT")
        conditions.push(
          "NOT EXISTS(SELECT 1 FROM cells WHERE task_id=NEW.task_id AND key=NEW.key)",
        );
      const when = ` WHEN ${conditions.join(" AND ")}`;
      triggerDefinitions.set(
        `sync_detect_${table}_${event}`,
        `CREATE TEMP TRIGGER IF NOT EXISTS sync_detect_${table}_${event} BEFORE ${detectedEvent} ON main.${table}${when} BEGIN SELECT graeboard_sync_before('${table}',json_object(${keep.map((c) => `'${c}',${prefix}.${c}`).join(",")})); END`,
      );
    }
  }
}
