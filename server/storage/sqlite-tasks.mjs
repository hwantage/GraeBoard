import {
  transaction,
  parse,
  now,
  getTasksById,
  upsertCellStatement,
  pruneStyles,
  touchTasks,
} from "../db.mjs";
import { requireThat, validateCellValue } from "../validation.mjs";
import { canEdit, canManageTeam, periodYears } from "../../shared/domain.js";
import { styleNormalizer, unpack } from "../../shared/compact.js";
import { applyFormatting, replayFormatOperation } from "../formatting.mjs";
import {
  storeCellOperation,
  replayCellOperation,
} from "../cell-operations.mjs";
import { retentionView } from "../sync/visibility.mjs";
import { prepareCellChange } from "./task-service.mjs";

export class SqliteTaskRepository {
  constructor({ db, control, cachedTasks, cellEvents }) {
    Object.assign(this, { db, control, cachedTasks, cellEvents });
  }
  query(user, { teamId, year, startMonth, deleted, ifNoneMatch }) {
    this.control.teamAccess(user, teamId);
    if (deleted)
      requireThat(
        canManageTeam(user, teamId),
        403,
        "팀장만 삭제한 업무를 조회할 수 있습니다.",
      );
    const period = periodYears(year, startMonth),
      etag = this.cachedTasks.etag(teamId, period, deleted),
      cellEventId = this.cellEvents.cursor();
    if (ifNoneMatch === etag) return { etag, cellEventId, notModified: true };
    const encoded = this.cachedTasks(teamId, period, deleted, etag);
    const visibility = retentionView(this.db, teamId);
    if (visibility.active) {
      const data = unpack(JSON.parse(encoded.body.toString("utf8")));
      data.tasks = visibility.years.has(String(year))
        ? []
        : visibility.tasks(data.tasks);
      return { etag, cellEventId, data };
    }
    return { etag, cellEventId, encoded };
  }
  saveBatch(user, d) {
    const {
      db,
      cellEvents,
      control: { teamAccess, taskAccess },
    } = this;
    const old = db
      .prepare("SELECT * FROM operations WHERE id=?")
      .get(d.operationId);
    if (old) {
      requireThat(old.actor_id === user.id, 403, "다른 사용자의 작업입니다.");
      const replay =
        parse(old.response)?.kind === "format-audit"
          ? replayFormatOperation(db, old)
          : replayCellOperation(db, old);
      if (replay.formatTeamId) teamAccess(user, replay.formatTeamId);
      for (const taskId of new Set(replay.cells.map((c) => c.taskId)))
        taskAccess(user, taskId, false, true);
      return replay;
    }
    if (d.format) {
      const team = teamAccess(user, d.format.teamId);
      const visibility = retentionView(db, team.id);
      for (const scope of d.format.scopes || [])
        for (const taskId of scope.rows || [])
          visibility.requireVisible("task", [taskId]);
      return transaction(db, () => applyFormatting(db, user, d, team));
    }
    let eventTasks;
    const response = transaction(db, () => {
      const seen = new Set();
      for (const change of d.changes) {
        const ck = `${change.taskId}:${change.key}`;
        requireThat(
          !seen.has(ck),
          400,
          "한 작업에서 같은 셀을 중복 수정할 수 없습니다.",
        );
        seen.add(ck);
      }
      // 업무와 팀은 각각 한 번씩만 읽는다. 수천 셀 배치에서 업무마다 조회하지 않는다.
      const taskIds = [...new Set(d.changes.map((c) => c.taskId))];
      const tasks = new Map(
        getTasksById(db, taskIds)
          .filter((t) => !t.deletedAt)
          .map((t) => [t.id, t]),
      );
      eventTasks = tasks;
      requireThat(
        taskIds.every((taskId) => tasks.has(taskId)),
        404,
        "업무를 찾을 수 없습니다.",
      );
      const teams = new Map(),
        visibility = new Map();
      for (const task of tasks.values()) {
        if (!visibility.has(task.teamId))
          visibility.set(task.teamId, retentionView(db, task.teamId));
        visibility.get(task.teamId).requireVisible("task", [task.id]);
        if (!teams.has(task.teamId))
          teams.set(task.teamId, teamAccess(user, task.teamId));
        requireThat(
          canEdit(user, task),
          403,
          "이 업무를 편집할 권한이 없습니다.",
        );
      }
      const before = [],
        after = [];
      const normalize = styleNormalizer();
      for (const change of d.changes) {
        const task = tasks.get(change.taskId),
          team = teams.get(task.teamId);
        const previous = task.cells[change.key] ?? {
          value: "",
          style: {},
          version: 0,
        };
        const desired = prepareCellChange({
          change,
          task,
          previous,
          formatRevision: task.formatting?.revision ?? 0,
          normalize,
          validateValue: () =>
            validateCellValue(
              db,
              task.teamId,
              change.key,
              change.value,
              team.settings,
              previous.value,
            ),
        });
        if (!desired) continue;
        const { value, style } = desired;
        before.push({ taskId: task.id, key: change.key, ...previous });
        after.push({
          taskId: task.id,
          key: change.key,
          value,
          style,
          version: previous.version + 1,
        });
      }
      const put = upsertCellStatement(db);
      for (const c of after)
        put.run(c.taskId, c.key, c.value, c.style, c.version);
      pruneStyles(
        db,
        before.map((c) => c.style),
      );
      const updatedAt = touchTasks(db, [
        ...new Set(after.map((c) => tasks.get(c.taskId))),
      ]);
      const result = {
        cells: after,
        before,
        operationId: d.operationId,
        savedAt: now(),
        updatedAt,
        ...(tasks.size &&
        new Set([...tasks.values()].map((t) => t.teamId)).size === 1
          ? { formatRevision: [...tasks.values()][0].formatting?.revision ?? 0 }
          : {}),
      };
      storeCellOperation(db, user.id, result, tasks);
      return result;
    });
    // Publish only after COMMIT. A replayed operation returns above and cannot
    // emit twice. Cell records retain their versions/styles; no View is sent.
    cellEvents.publish(response, eventTasks);
    return response;
  }
}
