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
export async function taskView(
  s,
  row,
  { cells, documents, format, formatViews } = {},
) {
  const id = row.key[0],
    excluded = await excludedYears(s);
  cells ||= await s.listChildren("cell", [id]);
  documents ||= await s.listChildren("document", ["task", id]);
  format ||= await s.get("formats", []);
  const docs = documents.filter(
    (d) => d.key[0] === "task" && d.key[1] === id && !d.deleted,
  );
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
    documentCount: docs.length,
    hasDocument: docs.some((d) => !!d.payload.markdown.trim()),
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
    documents = await s.list("document"),
    format = await s.get("formats", []),
    years = year ? periodYears(year, startMonth) : null,
    cellGroups = new Map(),
    docGroups = new Map(),
    formatViews = new Map();
  for (const c of cells) {
    if (!cellGroups.has(c.key[0])) cellGroups.set(c.key[0], []);
    cellGroups.get(c.key[0]).push(c);
  }
  for (const d of documents)
    if (d.key[0] === "task") {
      if (!docGroups.has(d.key[1])) docGroups.set(d.key[1], []);
      docGroups.get(d.key[1]).push(d);
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
          documents: docGroups.get(r.key[0]) || [],
          format,
          formatViews,
        }),
      ),
  );
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
