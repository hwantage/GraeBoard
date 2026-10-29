import { getTasksById } from "../db.mjs";
import { randomUUID } from "node:crypto";
import { equal } from "./protocol.mjs";
import { retentionView } from "./visibility.mjs";

export function createSyncNotifier({
  db,
  clearTeam,
  documentEvents,
  cellEvents,
}) {
  return function notify(
    teamId,
    keys,
    { retentionChanged = false, previous = {}, entities = {} } = {},
  ) {
    if (!keys.length && !retentionChanged) return;
    clearTeam?.(teamId);
    const changed = keys.map((key) => JSON.parse(key));
    if (
      retentionChanged ||
      changed.some(([entity]) => !["task", "cell"].includes(entity))
    )
      documentEvents.invalidate("team:" + teamId);
    for (const key of keys) {
      const [entity, parts] = JSON.parse(key);
      if (entity === "report") documentEvents.invalidate("report:" + parts[0]);
      if (entity === "document") {
        const [kind, a, b, c] = parts;
        const body =
          kind === "task"
            ? `task:${a}:${b}`
            : kind === "report"
              ? `report-task:${a}:${b}:${c}`
              : kind === "annual"
                ? `annual_memos:${teamId}:${a}:${b}`
                : kind === "reportMemo"
                  ? `report_memos:${a}:${b}`
                  : `calendar:${a}`;
        documentEvents.notify(body);
        if (kind === "task")
          documentEvents.invalidate(`list:/api/tasks/${a}/documents`);
        if (kind === "report") {
          documentEvents.invalidate("report:" + a);
          documentEvents.invalidate(
            `list:/api/reports/${a}/tasks/${b}/documents`,
          );
        }
        if (kind === "annual")
          documentEvents.invalidate(
            `list:/api/teams/${teamId}/years/${a}/memos`,
          );
        if (kind === "reportMemo") {
          documentEvents.invalidate("report:" + a);
          documentEvents.invalidate(`list:/api/reports/${a}/memos`);
        }
      }
    }
    const taskKeys = keys.filter((key) => JSON.parse(key)[0] === "task");
    const scopeChanged = taskKeys.some((key) => {
      const before = previous[key],
        after = entities[key];
      return (
        !before ||
        !after ||
        !!before.deleted !== !!after.deleted ||
        !equal(before.payload.years, after.payload.years)
      );
    });
    if (retentionChanged || scopeChanged) {
      // Membership and retention changes invalidate old scoped replay payloads.
      cellEvents.invalidateTeam(teamId);
    } else {
      // Ordinary remote cell edits keep the existing incremental SSE path.
      // Document-only commits must not force thirty full task snapshots.
      const cells = changed.filter(([entity]) => entity === "cell");
      if (cells.length || taskKeys.length) {
        const view = retentionView(db, teamId);
        const tasks = new Map(
          getTasksById(db, [
            ...new Set([
              ...cells.map(([, key]) => key[0]),
              ...taskKeys.map((key) => JSON.parse(key)[1][0]),
            ]),
          ])
            .filter(
              (task) =>
                task.teamId === teamId &&
                !task.deletedAt &&
                !view.hidden("task", [task.id]),
            )
            .map((task) => [task.id, task]),
        );
        const updates = cells.flatMap(([, [taskId, key]]) => {
          const cell = tasks.get(taskId)?.cells[key];
          return cell ? [{ taskId, key, ...cell }] : [];
        });
        cellEvents.publish(
          {
            operationId: randomUUID(),
            cells: updates,
            taskMetadata: Object.fromEntries(
              taskKeys.flatMap((key) => {
                const task = tasks.get(JSON.parse(key)[1][0]);
                if (!task) return [];
                const { updatedAt, position, defaultStyle, rowStyle } = task;
                return [
                  [task.id, { updatedAt, position, defaultStyle, rowStyle }],
                ];
              }),
            ),
            updatedAt: Object.fromEntries(
              [...tasks].map(([id, task]) => [id, task.updatedAt]),
            ),
          },
          tasks,
        );
      }
    }
  };
}
