import { normalizeStyle, sameStyle } from "./compact.js";

// A scope belongs to task IDs and column keys, never to positions in a View.
// A null key list covers every current/future column of the same task.
export const EMPTY_FORMATTING = Object.freeze({ revision: 0, rules: [] });
const indexes = new WeakMap();
function index(formatting) {
  if (indexes.has(formatting)) return indexes.get(formatting);
  const all = [],
    rows = new Map();
  for (const rule of formatting.rules) {
    const entry = {
      rule,
      keys: rule.keys === null ? null : new Set(rule.keys),
      excluded: new Set(rule.excludeKeys || []),
    };
    if (rule.rows === null) all.push(entry);
    else
      for (const id of rule.rows) {
        if (!rows.has(id)) rows.set(id, []);
        rows.get(id).push(entry);
      }
  }
  const result = { all, rows };
  indexes.set(formatting, result);
  return result;
}

export function commonStyle(task, key) {
  const formatting = task.formatting;
  if (!formatting?.rules.length) return task.rowStyle || {};
  const { all, rows } = index(formatting),
    style = { ...task.rowStyle },
    orders = {};
  for (const { rule, keys, excluded } of [
    ...all,
    ...(rows.get(task.id) || []),
  ]) {
    if ((keys && !keys.has(key)) || excluded.has(key)) continue;
    for (const [name, order] of Object.entries(rule.orders)) {
      if ((orders[name] ?? -1) >= order) continue;
      orders[name] = order;
      // An ordered missing property means a reset to the task's base style.
      if (Object.hasOwn(rule.style, name)) style[name] = rule.style[name];
      else delete style[name];
    }
  }
  return style;
}

export function inheritedStyle(task, key) {
  return { ...task.defaultStyle, ...commonStyle(task, key) };
}

// Row/column lines are explicit lines, just like cell overrides, and therefore
// take priority over the computed week boundary in the grid and XLSX exports.
export function explicitStyle(task, key) {
  return { ...commonStyle(task, key), ...task.cells[key]?.style };
}

export function normalizeCellStyle(task, key, style) {
  const common = commonStyle(task, key);
  const result = normalizeStyle(style, { ...task.defaultStyle, ...common });
  for (const name of ["borderTop", "borderRight", "borderBottom", "borderLeft"])
    if (
      Object.hasOwn(common, name) &&
      Object.hasOwn(result, name) &&
      sameStyle({ [name]: result[name] }, { [name]: common[name] })
    )
      delete result[name];
  return result;
}

// Clearing one cell must also cancel common row/column properties. A null
// override restores the native appearance when the task has no base value.
export function resetCellStyle(task, key) {
  return Object.fromEntries(
    Object.keys(commonStyle(task, key)).map((name) => [
      name,
      task.defaultStyle?.[name] ?? null,
    ]),
  );
}

export function rowFontSize(task) {
  const keys = new Set(["", ...Object.keys(task.cells)]);
  if (task.formatting?.rules.length) {
    const { all, rows } = index(task.formatting);
    for (const { rule } of [...all, ...(rows.get(task.id) || [])]) {
      if (!Object.hasOwn(rule.orders, "fontSize")) continue;
      for (const key of rule.keys || []) keys.add(key);
      for (const key of rule.excludeKeys || []) keys.add(key);
    }
  }
  let size = 9;
  for (const key of keys)
    size = Math.max(
      size,
      { ...inheritedStyle(task, key), ...task.cells[key]?.style }.fontSize || 9,
    );
  return size;
}

const scopeIndexes = new WeakMap();
export function scopeMatches(scope, taskId, key) {
  // A request's scopes are immutable. Index once instead of scanning every
  // selected task ID again for each existing cell. An omitted key tests rows only.
  if (!scopeIndexes.has(scope))
    scopeIndexes.set(scope, {
      rows: scope.rows === null ? null : new Set(scope.rows),
      keys: scope.keys === null ? null : new Set(scope.keys),
      excluded: new Set(scope.excludeKeys || []),
    });
  const { rows, keys, excluded } = scopeIndexes.get(scope);
  return (
    (rows === null || rows.has(taskId)) &&
    (key === undefined ||
      ((keys === null || keys.has(key)) && !excluded.has(key)))
  );
}

export function scopeKey(scope) {
  return JSON.stringify([
    scope.rows === null ? null : [...new Set(scope.rows)].sort(),
    scope.keys === null ? null : [...new Set(scope.keys)].sort(),
    [...new Set(scope.excludeKeys || [])].sort(),
  ]);
}

export function scopesOverlap(a, b) {
  if (
    a.rows !== null &&
    b.rows !== null &&
    !a.rows.some((id) => b.rows.includes(id))
  )
    return false;
  const keys = a.keys === null ? b.keys : a.keys;
  return (
    keys === null ||
    keys.some(
      (key) =>
        (b.keys === null || b.keys.includes(key)) &&
        (a.keys === null || a.keys.includes(key)) &&
        !(a.excludeKeys || []).includes(key) &&
        !(b.excludeKeys || []).includes(key),
    )
  );
}

export function rowFormatSignature(task) {
  return JSON.stringify([
    task.rowStyle || {},
    (task.formatting?.rules || [])
      .filter((r) => r.rows === null || r.rows.includes(task.id))
      .map((r) => [r.id, r.keys, r.excludeKeys || [], r.style, r.orders]),
  ]);
}

// A task audit is a standalone snapshot, not the live team's shared context.
// Keep only rules that affect this task and do not repeat other task IDs.
export function taskAuditSnapshot(task) {
  const { formatting, ...snapshot } = task;
  const rules = (formatting?.rules || [])
    .filter((rule) => rule.rows === null || rule.rows.includes(task.id))
    .map((rule) => ({
      ...rule,
      rows: rule.rows === null ? null : [task.id],
    }));
  return rules.length
    ? { ...snapshot, formatting: { revision: formatting.revision, rules } }
    : snapshot;
}

// Keep a copied row's indefinite rules indefinite. Column rules are materialized
// only for their actual keys, so a new task does not keep references to its source.
export function copyRowFormatting(task) {
  const rules = (task.formatting?.rules || []).filter(
    (r) => r.rows === null || r.rows.includes(task.id),
  );
  const rowTask = {
    ...task,
    formatting: { revision: 0, rules: rules.filter((r) => r.keys === null) },
  };
  const defaultStyle = task.defaultStyle || {},
    rowStyle = commonStyle(rowTask, "");
  const keys = new Set(Object.keys(task.cells));
  for (const rule of rules) for (const key of rule.keys || []) keys.add(key);
  for (const rule of rules)
    for (const key of rule.excludeKeys || []) keys.add(key);
  const cells = Object.fromEntries(
    [...keys].map((key) => [
      key,
      {
        value: task.cells[key]?.value ?? "",
        style: {
          ...Object.fromEntries(
            Object.keys(rowStyle).map((name) => [
              name,
              task.defaultStyle?.[name] ?? null,
            ]),
          ),
          ...explicitStyle(task, key),
        },
      },
    ]),
  );
  return {
    defaultStyle,
    ...(Object.keys(rowStyle).length ? { rowStyle } : {}),
    cells,
  };
}
