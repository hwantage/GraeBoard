import { applyBorderPreset } from "../shared/borders.js";
import { sameStyle } from "../shared/compact.js";
/** @typedef {import("./types").FormatScope} FormatScope */
/** @typedef {import("./types").Style} Style */
/**
 * @param {{r1: number, r2: number, c1: number, c2: number, kind?: string}[]} ranges
 * @param {import("./types").Task[]} tasks
 * @param {{key: string}[]} columns
 * @param {Style} style
 * @param {boolean} reset
 * @param {{preset: import("./types").BorderPreset, border: import("./types").Border | null}} [border]
 * @returns {FormatScope[]}
 */
export function formatScopes(ranges, tasks, columns, style, reset, border) {
  if (!border)
    return ranges.map((r) => ({
      rows: tasks.slice(r.r1, r.r2 + 1).map((t) => t.id),
      keys:
        r.kind === "rows" || r.kind === "all"
          ? null
          : columns.slice(r.c1, r.c2 + 1).map((c) => c.key),
      style,
      reset,
    }));
  const fullRows = new Set();
  for (const r of ranges)
    if (r.kind === "rows" || r.kind === "all")
      for (let i = r.r1; i <= r.r2; i++) fullRows.add(i);
  const has = (r, c) =>
    ranges.some((a) => r >= a.r1 && r <= a.r2 && c >= a.c1 && c <= a.c2);
  const patch = (r, c) =>
    applyBorderPreset({}, border.preset, border.border, {
      Top: !has(r - 1, c),
      Bottom: !has(r + 1, c),
      Left: !has(r, c - 1),
      Right: !has(r, c + 1),
    });
  /** @type {FormatScope[]} */
  const scopes = [];
  for (let r = 0; r < tasks.length; r++) {
    /** @type {Map<string, {style: Style, keys: string[]}>} */
    const groups = new Map();
    const base = fullRows.has(r)
      ? applyBorderPreset({}, border.preset, border.border, {
          Top: !fullRows.has(r - 1),
          Bottom: !fullRows.has(r + 1),
          Left: false,
          Right: false,
        })
      : null;
    const excluded = [];
    for (let c = 0; c < columns.length; c++) {
      if (!has(r, c)) continue;
      const part = patch(r, c);
      if (base && sameStyle(base, part)) continue;
      if (base) excluded.push(columns[c].key);
      if (!Object.keys(part).length) continue;
      const key = JSON.stringify(part);
      if (!groups.has(key)) groups.set(key, { style: part, keys: [] });
      groups.get(key).keys.push(columns[c].key);
    }
    if (base && Object.keys(base).length)
      scopes.push({
        rows: [tasks[r].id],
        keys: null,
        excludeKeys: excluded,
        style: base,
      });
    for (const g of groups.values())
      scopes.push({ rows: [tasks[r].id], keys: g.keys, style: g.style });
  }
  // Rows with the same border pattern share one rule, including column interiors.
  /** @type {Map<string, FormatScope>} */
  const combined = new Map();
  for (const scope of scopes) {
    const key = JSON.stringify([
      scope.keys,
      scope.excludeKeys || [],
      scope.style,
    ]);
    const existing = combined.get(key);
    if (existing) existing.rows.push(...scope.rows);
    else combined.set(key, scope);
  }
  return [...combined.values()];
}
