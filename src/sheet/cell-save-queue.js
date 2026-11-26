// Changes to the original sheet made while an earlier one is being saved wait
// in order (see useSheetOperations). Each keeps what its author saw when
// making it: the version of every cell it changes, the team's formatting
// revision and, for a format change, each row's update stamp.
//
// An own save moves such an expectation only when the value the save
// replaced is the one the author saw: the save's result names both (`before`
// and `cells` for cell versions, `previousFormatRevision` and
// `formatRevision`, `previousUpdatedAt` and `updatedAt` for row stamps). A
// change someone else saved meanwhile therefore leaves the expectation as it
// was, and the server refuses the queued change as a conflict instead of it
// overwriting that change unseen. A result without the value before (a
// replayed operation, an older server) moves nothing; the server then
// refuses the change and the user decides.
//
// An expectation is keyed by what it guards: "c:<task>:<key>" a cell's
// version, "t:<task>" a row's update stamp, "f" the formatting revision.
import { STYLE_KEYS } from "../../shared/formatting/compact.js";
import { scopeKey, scopeMatches } from "../../shared/formatting/formatting.js";

/** @typedef {import("../types").Task} Task */
/** @typedef {import("../types").BatchResult} BatchResult */
/** @typedef {import("../types").CellChange} CellChange */
/** @typedef {import("../types").FormatChange} FormatChange */
/** @typedef {{ operationId: string, createdAt: string, changes: CellChange[], format?: FormatChange }} Payload */
/** @typedef {{ id: number, payload: Payload, bases: Map<string, number | string> }} QueuedChange */

const cellKey = (/** @type {string} */ taskId, /** @type {string} */ key) =>
  `c:${taskId}:${key}`;
const taskKey = (/** @type {string} */ taskId) => `t:${taskId}`;

/**
 * A change joining the queue, expecting what its payload was built from.
 * `given` holds expectations kept elsewhere for some keys (see watch).
 * @param {Payload} payload
 * @param {number} id
 * @param {Map<string, number | string>} [given]
 * @returns {QueuedChange}
 */
export function enqueue(payload, id, given) {
  /** @type {Map<string, number | string>} */
  const bases = new Map();
  for (const change of payload.changes) {
    const key = cellKey(change.taskId, change.key);
    bases.set(key, given?.get(key) ?? change.expectedVersion);
    if (change.expectedFormatRevision !== undefined)
      bases.set("f", change.expectedFormatRevision);
  }
  if (payload.format) {
    bases.set("f", payload.format.expectedRevision);
    for (const [taskId, stamp] of Object.entries(
      payload.format.expectedTasks || {},
    ))
      bases.set(taskKey(taskId), stamp);
  }
  return { id, payload, bases };
}

/**
 * What an editor opened on a cell saw: the version shown then. It moves with
 * own saves like a queued change (see rebase) and becomes the expectation of
 * the edit committed in it.
 * @param {string} taskId
 * @param {string} key
 * @param {number} version
 * @returns {QueuedChange}
 */
export function watch(taskId, key, version) {
  return {
    id: 0,
    payload: { operationId: "", createdAt: "", changes: [] },
    bases: new Map([[cellKey(taskId, key), version]]),
  };
}

// What an own saved result moved, by expectation key: [value before, after].
function moves(/** @type {BatchResult} */ result) {
  /** @type {Map<string, [number | string, number | string]>} */
  const moved = new Map();
  const before = new Map(
    result.before.map((c) => [cellKey(c.taskId, c.key), c.version]),
  );
  for (const c of result.cells) {
    const key = cellKey(c.taskId, c.key);
    if (before.has(key)) moved.set(key, [before.get(key), c.version]);
  }
  if (
    result.previousFormatRevision !== undefined &&
    result.formatRevision !== undefined
  )
    moved.set("f", [result.previousFormatRevision, result.formatRevision]);
  for (const [id, stamp] of Object.entries(result.updatedAt || {})) {
    const previous = result.previousUpdatedAt?.[id];
    if (previous !== undefined) moved.set(taskKey(id), [previous, stamp]);
  }
  return moved;
}

/**
 * Moves the expectations of queued changes past an own saved change: each
 * one that saw exactly what the save replaced now expects what it left.
 * @param {QueuedChange[]} queue
 * @param {BatchResult} result
 * @returns {QueuedChange[]}
 */
export function rebase(queue, result) {
  const moved = moves(result);
  if (!moved.size) return queue;
  return queue.map((change) => {
    let bases = change.bases;
    for (const [key, value] of change.bases) {
      const move = moved.get(key);
      if (!move || move[0] !== value) continue;
      if (bases === change.bases) bases = new Map(bases);
      bases.set(key, move[1]);
    }
    return bases === change.bases ? change : { ...change, bases };
  });
}

/**
 * The request for a queued change, with what it expects now.
 * @param {QueuedChange} change
 * @param {string} createdAt
 * @returns {Payload}
 */
export function request(change, createdAt) {
  const value = (/** @type {string} */ key) => change.bases.get(key);
  const { payload } = change;
  return {
    ...payload,
    createdAt,
    changes: payload.changes.map((c) => ({
      ...c,
      expectedVersion: Number(value(cellKey(c.taskId, c.key))),
      ...(c.expectedFormatRevision !== undefined
        ? { expectedFormatRevision: Number(value("f")) }
        : {}),
    })),
    ...(payload.format
      ? {
          format: {
            ...payload.format,
            expectedRevision: Number(value("f")),
            ...(payload.format.expectedTasks
              ? {
                  expectedTasks: Object.fromEntries(
                    Object.keys(payload.format.expectedTasks).map((id) => [
                      id,
                      String(value(taskKey(id))),
                    ]),
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
}

const hasStyle = (/** @type {object | undefined} */ style) => {
  for (const _ in style) return true;
  return false;
};

// The team's formatting with a queued format change applied, as its author
// expects to see it: each scope's rule takes the new style and the newest
// order. The saved result replaces it.
function formattingWith(
  /** @type {Task["formatting"]} */ formatting,
  /** @type {FormatChange} */ format,
  /** @type {number} */ queued,
) {
  const rules = (formatting?.rules || []).map((rule) => ({
    ...rule,
    style: { ...rule.style },
    orders: { ...rule.orders },
  }));
  let order =
    Math.max(0, ...rules.flatMap((rule) => Object.values(rule.orders || {}))) +
    1;
  for (const [index, scope] of (format.scopes || []).entries()) {
    let rule = rules.find((r) => scopeKey(r) === scopeKey(scope));
    if (!rule) {
      rule = {
        id: `queued:${queued}:${index}`,
        rows: scope.rows,
        keys: scope.keys,
        excludeKeys: scope.excludeKeys || [],
        style: {},
        orders: {},
      };
      rules.push(rule);
    }
    const names = scope.reset
      ? Object.keys(STYLE_KEYS)
      : Object.keys(scope.style);
    for (const name of names) {
      if (Object.hasOwn(scope.style, name))
        rule.style[name] = scope.style[name];
      else delete rule.style[name];
      rule.orders[name] = order++;
    }
  }
  return { revision: formatting?.revision ?? 0, rules };
}

/**
 * The sheet as its author sees it: the stored sheet with every queued change
 * applied. A changed cell shows the version its change expects, so a change
 * made on it builds on that change.
 * @param {Task[]} tasks
 * @param {QueuedChange[]} queue
 * @returns {Task[]}
 */
export function project(tasks, queue) {
  if (!queue.length) return tasks;
  /** @type {Map<string, Task>} */
  const byId = new Map(tasks.map((task) => [task.id, task])),
    copied = new Set();
  // A task this projection changes, copied once.
  const own = (/** @type {string} */ id) => {
    const task = byId.get(id);
    if (!task || copied.has(id)) return task;
    const next = { ...task, cells: { ...task.cells } };
    byId.set(id, next);
    copied.add(id);
    return next;
  };
  let formatting = null,
    formatTeam = null;
  for (const { id: queued, payload, bases } of queue) {
    for (const c of payload.changes) {
      const task = own(c.taskId);
      if (!task) continue;
      const previous = task.cells[c.key] || {
        value: "",
        style: {},
        version: 0,
      };
      task.cells[c.key] = {
        ...previous,
        ...(c.value !== undefined ? { value: c.value } : {}),
        ...(c.style !== undefined ? { style: c.style } : {}),
        version: Number(
          bases.get(cellKey(c.taskId, c.key)) ?? previous.version,
        ),
      };
    }
    const scopes = payload.format?.scopes;
    if (!scopes) continue;
    formatting = formattingWith(
      formatting || tasks[0]?.formatting,
      payload.format,
      queued,
    );
    formatTeam = payload.format.teamId;
    // A cell's own style gives way to the scopes over it, as when saved,
    // queued changes' cells included. Only the scopes' rows are looked at.
    const rows = scopes.some((scope) => !scope.rows)
      ? tasks.map((task) => task.id)
      : [...new Set(scopes.flatMap((scope) => scope.rows))];
    for (const id of rows) {
      const shown = byId.get(id);
      if (!shown) continue;
      for (const key of Object.keys(shown.cells)) {
        // Most cells have no own style: nothing gives way.
        if (!hasStyle(byId.get(id).cells[key].style)) continue;
        const names = scopes
          .filter((scope) => scopeMatches(scope, id, key))
          .flatMap((scope) =>
            scope.reset ? Object.keys(STYLE_KEYS) : Object.keys(scope.style),
          );
        const style = byId.get(id).cells[key].style;
        if (!names.some((name) => Object.hasOwn(style, name))) continue;
        const target = own(id),
          next = { ...style };
        for (const name of names) delete next[name];
        target.cells[key] = { ...target.cells[key], style: next };
      }
    }
  }
  return tasks.map((task) => {
    const next = byId.get(task.id) || task;
    return formatting && next.teamId === formatTeam
      ? { ...next, formatting }
      : next;
  });
}
