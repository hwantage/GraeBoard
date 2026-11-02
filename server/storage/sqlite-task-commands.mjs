import {
  taskCreationFields,
  duplicatedTaskCells,
  pastedTaskCells,
  blankInsertionFormatting,
  validatePersonalView,
  planTaskReorder,
} from "./task-command-rules.mjs";
import {
  transaction,
  parse,
  now,
  id,
  json,
  getTask,
  getTasks,
  nextTaskStamp,
  insertTask,
  audit,
} from "../db.mjs";
import {
  requireThat,
  validateCellValue,
  yearSchema,
  periodScopeSchema,
} from "../../shared/validation.js";
import {
  canEdit,
  canContribute,
  periodYears,
  normalizeView,
  viewLayout,
} from "../../shared/domain.js";
import { taskAuditSnapshot } from "../../shared/formatting.js";
import { retentionView } from "../sync/visibility.mjs";
import { withTaskDocuments } from "../task-documents.mjs";
import { validateDocumentImages } from "../document-images.mjs";
import { insertionPosition } from "../task-position.mjs";

export class SqliteTaskCommands {
  locate(user, taskId, options = {}) {
    return this.control.taskAccess(
      user,
      taskId,
      options.edit,
      options.includeDeleted,
    );
  }
  getMany(user, ids, options = {}) {
    return ids.map((id) => {
      const task = this.locate(user, id, options);
      return retentionView(this.db, task.teamId).task(task);
    });
  }
  create(user, d) {
    const {
      db,
      documentImagesDir,
      control: { teamAccess, taskAccess },
    } = this;
    const team = teamAccess(user, d.teamId);
    requireThat(
      !retentionView(db, d.teamId).years.has(String(d.year)),
      409,
      "이 사이트에서 정리한 연도입니다. 먼저 복원하세요.",
    );
    periodScopeSchema.parse(d);
    requireThat(canContribute(user, d.teamId), 403, "등록 권한이 없습니다.");
    const blankCreation = !d.sourceId && !d.copiedRow;
    const blankInsertion = d.insertAt && blankCreation;
    // 신규 업무는 팀원·상태를 포함해 속성을 비운다. 명시한 값은 fields로 받는다.
    const fields = taskCreationFields(team.settings, user, d);
    let cells = {},
      defaultStyle = team.settings.defaultStyle,
      rowStyle = {},
      documents;
    if (d.sourceId) {
      const source = taskAccess(user, d.sourceId);
      requireThat(
        source.teamId === d.teamId,
        400,
        "같은 팀의 업무만 복제할 수 있습니다.",
      );
      ({
        cells,
        defaultStyle,
        rowStyle = {},
      } = duplicatedTaskCells(source, team.settings, d, fields));
      documents = retentionView(db, source.teamId).documents(
        withTaskDocuments(db, [source])[0].documents,
        ["task", source.id],
      );
    }
    if (d.copiedRow) {
      cells = { ...d.copiedRow.cells };
      defaultStyle = d.copiedRow.defaultStyle;
      rowStyle = d.copiedRow.rowStyle || {};
      documents = d.copiedRow.documents;
      for (const document of documents || [])
        validateDocumentImages(document.markdown, d.teamId);
      cells = pastedTaskCells(d.copiedRow, team.settings, (key, value) =>
        validateCellValue(db, d.teamId, key, value, team.settings),
      );
    }
    for (const [k, v] of Object.entries(fields))
      validateCellValue(db, d.teamId, k, v, team.settings);
    const task = transaction(db, () => {
      let position;
      if (d.insertAt) {
        const target = taskAccess(user, d.insertAt.taskId);
        requireThat(
          target.teamId === d.teamId &&
            target.years.some((y) =>
              periodYears(d.year, d.startMonth).includes(y),
            ),
          400,
          "같은 팀과 연도의 행을 선택하세요.",
        );
        requireThat(
          target.updatedAt === d.insertAt.updatedAt,
          409,
          "기준 행이 변경되었습니다. 새로고침 후 다시 선택하세요.",
        );
        if (blankInsertion) {
          // 빈 행 삽입은 기준 행의 서식만 상속한다. 값은 새 업무 기본값이나
          // 묶음에서 전달한 값을 유지하고, 숨긴 열·빈 주차 서식도 보존한다.
          ({ cells, defaultStyle, rowStyle } = blankInsertionFormatting(
            target,
            team.settings,
            fields,
          ));
        }
        position = insertionPosition(
          db,
          d.teamId,
          periodYears(d.year, d.startMonth),
          target.id,
          d.insertAt.placement,
        );
      }
      const t = insertTask(db, {
        teamId: d.teamId,
        year: d.year,
        actorId: user.id,
        fields,
        cells,
        defaultStyle,
        rowStyle,
        documents,
        position,
      });
      audit(
        db,
        user.id,
        d.teamId,
        "create",
        t.id,
        undefined,
        taskAuditSnapshot(t),
      );
      return t;
    });
    return { task };
  }
  update(user, taskId, d) {
    const {
      db,
      documentImagesDir,
      control: { teamAccess, taskAccess },
    } = this;
    const task = taskAccess(user, taskId, true);
    requireThat(
      d.updatedAt === task.updatedAt,
      409,
      "업무가 변경되었습니다. 새로고침 후 다시 시도하세요.",
    );
    const visibility = retentionView(db, task.teamId);
    requireThat(
      !d.years ||
        d.years.every(
          (year) =>
            !visibility.years.has(String(year)) || task.years.includes(year),
        ),
      409,
      "이 사이트에서 정리한 연도입니다. 먼저 복원하세요.",
    );
    const updated = transaction(db, () => {
      db.prepare(
        "UPDATE tasks SET years=?,position=?,updated_at=? WHERE id=?",
      ).run(
        json(
          d.years
            ? [
                ...d.years,
                ...task.years.filter(
                  (year) =>
                    visibility.years.has(String(year)) &&
                    !d.years.includes(year),
                ),
              ]
            : task.years,
        ),
        d.position ?? task.position,
        nextTaskStamp(task.updatedAt),
        task.id,
      );
      const after = getTask(db, task.id);
      audit(
        db,
        user.id,
        task.teamId,
        "task",
        task.id,
        taskAuditSnapshot(task),
        taskAuditSnapshot(after),
      );
      return after;
    });
    return { task: retentionView(db, updated.teamId).task(updated) };
  }
  remove(user, versions) {
    const {
      db,
      documentImagesDir,
      control: { teamAccess, taskAccess },
    } = this;
    return transaction(db, () => {
      const tasks = versions.map(({ id, updatedAt }) => {
        const task = taskAccess(user, id, true);
        requireThat(
          updatedAt === task.updatedAt,
          409,
          "업무가 변경되었습니다. 확인 후 다시 삭제하세요.",
        );
        return task;
      });
      requireThat(
        tasks.every((t) => t.teamId === tasks[0].teamId),
        400,
        "같은 시트의 업무를 선택하세요.",
      );
      const updatedAt = {};
      for (const task of tasks) {
        updatedAt[task.id] = nextTaskStamp(task.updatedAt);
        const deletedAt = now();
        db.prepare("UPDATE tasks SET deleted_at=?,updated_at=? WHERE id=?").run(
          deletedAt,
          updatedAt[task.id],
          task.id,
        );
        audit(
          db,
          user.id,
          task.teamId,
          "delete",
          task.id,
          taskAuditSnapshot(task),
          { deletedAt, updatedAt: updatedAt[task.id] },
        );
      }
      return { ok: true, updatedAt };
    });
  }
  restore(user, versions) {
    const {
      db,
      documentImagesDir,
      control: { teamAccess, taskAccess },
    } = this;
    return transaction(db, () => {
      const tasks = versions.map(({ id, updatedAt }) => {
        const task = taskAccess(user, id, false, true);
        requireThat(canEdit(user, task), 403, "업무를 복구할 권한이 없습니다.");
        requireThat(
          task.deletedAt &&
            (updatedAt === undefined || updatedAt === task.updatedAt),
          409,
          "이후 변경이 있어 되돌릴 수 없습니다. 변경 이력에서 확인하세요.",
        );
        return task;
      });
      requireThat(
        tasks.every((t) => t.teamId === tasks[0].teamId),
        400,
        "같은 시트의 업무를 선택하세요.",
      );
      for (const task of tasks) {
        db.prepare(
          "UPDATE tasks SET deleted_at=NULL,updated_at=? WHERE id=?",
        ).run(nextTaskStamp(task.updatedAt), task.id);
        audit(db, user.id, task.teamId, "restore", task.id, undefined, {
          restored: true,
        });
      }
      return {
        tasks: tasks.map((task) =>
          retentionView(db, task.teamId).task(getTask(db, task.id)),
        ),
      };
    });
  }
  reorder(user, d) {
    const {
      db,
      control: { taskAccess, teamAccess },
    } = this;
    return transaction(db, () => {
      const requested = d.tasks || [{ id: d.taskId, updatedAt: d.updatedAt }],
        sources = requested.map((t) => taskAccess(user, t.id, true)),
        target = taskAccess(user, d.targetId),
        settings = teamAccess(user, target.teamId).settings;
      // Resolve every source through authorization before gathering the same-team board.
      requireThat(
        sources.every((t) => t.teamId === target.teamId),
        400,
        "같은 팀과 연도의 업무를 선택하세요.",
      );
      const all = retentionView(db, target.teamId).tasks(
          getTasks(db, target.teamId, periodYears(d.year, d.startMonth)),
        ),
        plan = planTaskReorder(
          [
            ...new Map(
              [...all, ...sources, target].map((task) => [task.id, task]),
            ).values(),
          ],
          d,
          settings,
        ),
        put = db.prepare("UPDATE tasks SET position=?,updated_at=? WHERE id=?");
      for (const task of plan.rebased)
        put.run(task.position, nextTaskStamp(task.updatedAt), task.id);
      const tasks = plan.moving.map((task) => {
        const updatedAt = nextTaskStamp(task.updatedAt);
        put.run(task.position, updatedAt, task.id);
        audit(
          db,
          user.id,
          task.teamId,
          "reorder",
          task.id,
          { position: all.find((t) => t.id === task.id).position },
          {
            position: task.position,
            targetId: target.id,
            placement: d.placement,
            groupBy: d.groupBy,
          },
        );
        return { ...task, updatedAt };
      });
      return { task: tasks[0], tasks };
    });
  }
  readViews(user, query) {
    const {
      db,
      documentImagesDir,
      control: { teamAccess, taskAccess },
    } = this;
    const teamId = String(query.teamId);
    const team = teamAccess(user, teamId);
    const year = yearSchema.parse(query.year);
    return {
      views: db
        .prepare(
          "SELECT * FROM views WHERE user_id=? AND team_id=? AND name='__current' AND year=?",
        )
        .all(user.id, teamId, year)
        .map((v) => ({
          id: v.id,
          name: v.name,
          data: viewLayout(normalizeView(parse(v.data), team.settings)),
          updatedAt: v.updated_at,
        })),
    };
  }
  saveView(user, d) {
    const {
      db,
      documentImagesDir,
      control: { teamAccess, taskAccess },
    } = this;
    const team = teamAccess(user, d.teamId);
    validatePersonalView(d.data, team.settings);
    db.prepare(
      "INSERT INTO views VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,team_id,year,name) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
    ).run(
      id(),
      user.id,
      d.teamId,
      d.data.year,
      d.name,
      json(viewLayout(d.data)),
      now(),
    );
    return { ok: true };
  }
}
