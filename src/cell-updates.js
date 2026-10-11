/** @typedef {import("./types").Task} Task */
/** @typedef {import("./types").SavedCell} SavedCell */
/** @typedef {{ cells: SavedCell[], updatedAt?: Record<string, string> }} CellUpdates */
/** @typedef {{ tasks: Task[], cellEventId: string }} TaskSnapshot */

// HTTP acknowledgements and SSE can arrive in either order. Never replace a
// newer cell with an older version, or clone rows that have not changed.
/** @param {Task[]} tasks @param {CellUpdates} update @returns {Task[]} */
export function mergeCellUpdates(tasks, update) {
  /** @type {Map<string, Map<string, SavedCell>>} */
  const byTask = new Map();
  for (const c of update.cells) {
    let cells = byTask.get(c.taskId);
    if (!cells) byTask.set(c.taskId, (cells = new Map()));
    if ((cells.get(c.key)?.version ?? -1) < c.version) cells.set(c.key, c);
  }
  let changed = false;
  const next = tasks.map((task) => {
    const changes = byTask.get(task.id);
    if (!changes) return task;
    let cells = task.cells;
    for (const { taskId, key, ...c } of changes.values()) {
      if ((cells[key]?.version ?? 0) >= c.version) continue;
      if (cells === task.cells) cells = { ...cells };
      cells[key] = c;
    }
    if (cells === task.cells) return task;
    changed = true;
    const stamp = update.updatedAt?.[task.id];
    return {
      ...task,
      cells,
      updatedAt: stamp && stamp > task.updatedAt ? stamp : task.updatedAt,
    };
  });
  return changed ? next : tasks;
}

/** @param {Task[]} tasks @param {Task[]} snapshot @returns {Task[]} */
export function mergeSnapshotCells(tasks, snapshot) {
  const byId = new Map(snapshot.map((task) => [task.id, task]));
  let changed = false;
  const next = tasks.map((task) => {
    const fresh = byId.get(task.id);
    if (!fresh) return task;
    let cells = task.cells;
    for (const [key, c] of Object.entries(fresh.cells)) {
      if ((cells[key]?.version ?? 0) >= c.version) continue;
      if (cells === task.cells) cells = { ...cells };
      cells[key] = c;
    }
    if (cells === task.cells) return task;
    changed = true;
    return {
      ...task,
      cells,
      updatedAt:
        fresh.updatedAt > task.updatedAt ? fresh.updatedAt : task.updatedAt,
    };
  });
  return changed ? next : tasks;
}
