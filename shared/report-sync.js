import { applyReportOperation } from "./report-editing.js";

// Rebase independent pending cell edits onto a fresh report. Structural edits
// retain the existing revision conflict flow instead of guessing their intent.
export function rebaseReportCells(base, remote, operations, context) {
  if (operations.some((operation) => operation.kind !== "cells")) return null;
  let before = base;
  let after = remote;
  const history = [remote];
  for (const operation of operations) {
    const oldRows = new Map(before.map((task) => [task.id, task]));
    const newRows = new Map(after.map((task) => [task.id, task]));
    for (const change of operation.changes) {
      const old = oldRows.get(change.taskId),
        fresh = newRows.get(change.taskId);
      if (!old || !fresh) return null;
      const a = old.cells[change.key] || { value: "", style: {}, version: 0 };
      const b = fresh.cells[change.key] || { value: "", style: {}, version: 0 };
      if (
        a.version !== b.version ||
        JSON.stringify(a) !== JSON.stringify(b) ||
        JSON.stringify(old.formatting) !== JSON.stringify(fresh.formatting)
      )
        return null;
    }
    before = applyReportOperation(before, operation, context);
    after = applyReportOperation(after, operation, context);
    history.push(after);
  }
  return { tasks: after, history };
}
