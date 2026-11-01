import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  periodYears,
} from "../shared/domain.js";
import { assert } from "./access.mjs";
export const stamp = (row) =>
  new Date(Number(row?.revision) || 0).toISOString();
const retentionYears = new WeakMap();
export async function excludedYears(s) {
  if (!retentionYears.has(s))
    retentionYears.set(
      s,
      s.tx
        .query(
          "SELECT r.entity_key FROM site_retention r JOIN team_sync_links l ON l.team_id=r.team_id AND l.installation_id=r.site_id WHERE r.team_id=$1 AND r.kind='year'",
          [s.teamId],
        )
        .then(
          (result) =>
            new Set(
              result.rows.map((row) => Number(JSON.parse(row.entity_key)[0])),
            ),
        ),
    );
  return retentionYears.get(s);
}

export async function settingsFor(s) {
  const row = await s.get("team", []);
  return {
    ...normalizeSettings(row?.payload?.settings || DEFAULT_SETTINGS),
    revision: row?.revision || 0,
  };
}
// A list passes formatViews so tasks under the same rules share one formatting
// object; the response encoder then serializes the team format once, not per task.
const taskFormatting = (format, id, formatViews) => {
  const rules = [],
    applied = [];
  format.payload.rules.forEach((rule, index) => {
    if (rule.rows && !rule.rows.includes(id)) return;
    rules.push(rule);
    applied.push(index);
  });
  const key = applied.join(",");
  if (formatViews?.has(key)) return formatViews.get(key);
  const formatting = { ...format.payload, rules, revision: format.revision };
  formatViews?.set(key, formatting);
  return formatting;
};
const summarize = (documents) => ({
  count: documents.length,
  content: documents.some((d) => !!d.payload.markdown.trim()),
});
// JS String.prototype.trim()'s whitespace, so SQL decides "has content" as
// taskView's markdown.trim() does.
const CONTENT =
  "[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]";
// Each task's live document count and whether any has content, aggregated in
// SQL so a task list does not read every document's markdown.
async function documentSummaries(s) {
  const summaries = new Map();
  if (s.lists.has("document")) {
    const groups = new Map();
    for (const d of await s.list("document"))
      if (d.key[0] === "task") {
        if (!groups.has(d.key[1])) groups.set(d.key[1], []);
        groups.get(d.key[1]).push(d);
      }
    for (const [id, docs] of groups) summaries.set(id, summarize(docs));
    return summaries;
  }
  for (const row of (
    await s.tx.query(
      "SELECT entity_key::jsonb->>1 AS task,COUNT(*)::int AS count,COALESCE(bool_or((payload::jsonb->>'markdown') ~ $2),false) AS content FROM site_entities WHERE team_id=$1 AND entity='document' AND deleted=0 AND left(entity_key,8)='[\"task\",' GROUP BY 1",
      [s.teamId, CONTENT],
    )
  ).rows)
    summaries.set(row.task, { count: row.count, content: row.content });
  return summaries;
}
export async function taskView(
  s,
  row,
  { cells, documents, documentSummary, format, formatViews } = {},
) {
  const id = row.key[0],
    excluded = await excludedYears(s);
  cells ||= await s.listChildren("cell", [id]);
  if (!documentSummary) {
    documents ||= await s.listChildren("document", ["task", id]);
    documentSummary = summarize(
      documents.filter(
        (d) => d.key[0] === "task" && d.key[1] === id && !d.deleted,
      ),
    );
  }
  format ||= await s.get("formats", []);
  return {
    id,
    teamId: s.teamId,
    ...row.payload,
    years: row.payload.years.filter((year) => !excluded.has(year)),
    updatedAt: stamp(row),
    cells: Object.fromEntries(
      cells
        .filter((c) => c.key[0] === id && !c.deleted)
        .map((c) => [c.key[1], { ...c.payload, version: c.revision }]),
    ),
    documentCount: documentSummary.count,
    hasDocument: documentSummary.content,
    ...(format ? { formatting: taskFormatting(format, id, formatViews) } : {}),
  };
}
export async function taskList(
  s,
  { year, startMonth = 1, deleted = false } = {},
) {
  const excluded = await excludedYears(s);
  if (year && excluded.has(Number(year))) return [];
  const rows = await s.list("task"),
    cells = await s.list("cell"),
    documents = await documentSummaries(s),
    format = await s.get("formats", []),
    years = year ? periodYears(year, startMonth) : null,
    cellGroups = new Map(),
    formatViews = new Map();
  for (const c of cells) {
    if (!cellGroups.has(c.key[0])) cellGroups.set(c.key[0], []);
    cellGroups.get(c.key[0]).push(c);
  }
  return Promise.all(
    rows
      .filter(
        (r) =>
          !!r.payload.deletedAt === deleted &&
          r.payload.years.some(
            (y) => !excluded.has(y) && (!years || years.includes(y)),
          ),
      )
      .sort(
        (a, b) =>
          a.payload.position - b.payload.position ||
          a.key[0].localeCompare(b.key[0]),
      )
      .map((r) =>
        taskView(s, r, {
          cells: cellGroups.get(r.key[0]) || [],
          documentSummary: documents.get(r.key[0]) || summarize([]),
          format,
          formatViews,
        }),
      ),
  );
}
// taskList's live tasks in its order, with only the named cells: for a picker
// or an import rule that never shows a whole task, so the team's other cells
// and documents are not read.
export async function taskCells(s, columns) {
  const excluded = await excludedYears(s),
    rows = (await s.list("task"))
      .filter(
        (r) =>
          !r.payload.deletedAt && r.payload.years.some((y) => !excluded.has(y)),
      )
      .sort(
        (a, b) =>
          a.payload.position - b.payload.position ||
          a.key[0].localeCompare(b.key[0]),
      ),
    cells = new Map();
  for (const row of (
    await s.tx.query(
      "SELECT entity_key,payload FROM site_entities WHERE team_id=$1 AND entity='cell' AND deleted=0 AND entity_key::jsonb->>1=ANY($2::text[])",
      [s.teamId, columns],
    )
  ).rows) {
    const [task, column] = JSON.parse(row.entity_key);
    if (!cells.has(task)) cells.set(task, {});
    cells.get(task)[column] = JSON.parse(row.payload);
  }
  return rows.map((r) => ({
    id: r.key[0],
    years: r.payload.years.filter((year) => !excluded.has(year)),
    cells: cells.get(r.key[0]) || {},
  }));
}
export async function assignable(ctx, teamId) {
  return new Set(
    (await ctx.controlStore.members(teamId, { activeOnly: true }))
      .filter((user) => ["lead", "member"].includes(user.role))
      .map((user) => user.id),
  );
}
export function requireTask(row) {
  assert(
    row && !row.deleted && !row.payload.deletedAt,
    404,
    "업무를 찾을 수 없습니다.",
  );
  return row;
}
