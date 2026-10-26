import { z } from "zod";
import {
  audit,
  id,
  now,
  parse,
  transaction,
  upsertCellStatement,
  pruneStyles,
  touchTasks,
} from "../db.mjs";
import { requireThat } from "../validation.mjs";
import {
  auditSheetSql,
  deletedReportTasks,
  restoreReportTasks,
} from "../sheet-history.mjs";
import { decodeReport } from "../reports.mjs";
import { applyFormatting } from "../formatting.mjs";
import { retentionView } from "../sync/visibility.mjs";
export class SqliteHistoryRepository {
  constructor({ db, control, documentEvents }) {
    Object.assign(this, { db, control, documentEvents });
  }
  query(user, query) {
    const {
      db,
      control: { teamAccess, taskAccess },
    } = this;
    const teamId = String(query.teamId);
    teamAccess(user, teamId);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(query.limit || 100);
    const taskId = query.taskId ? z.string().uuid().parse(query.taskId) : null;
    const sheetId =
      query.sheetId === undefined
        ? null
        : z
            .union([z.literal("original"), z.string().uuid()])
            .parse(query.sheetId);
    if (sheetId && sheetId !== "original")
      requireThat(
        db
          .prepare("SELECT id FROM reports WHERE id=? AND team_id=?")
          .get(sheetId, teamId),
        404,
        "사본을 찾을 수 없습니다.",
      );
    if (taskId && (!sheetId || sheetId === "original"))
      requireThat(
        taskAccess(user, taskId, false, true).teamId === teamId,
        403,
        "같은 팀의 업무를 선택하세요.",
      );
    const rows = db
      .prepare(
        `SELECT a.*,u.name AS actor, ${auditSheetSql} AS report_id FROM audit a JOIN users u ON a.actor_id=u.id WHERE a.team_id=?
          AND (? IS NULL OR COALESCE(${auditSheetSql},'original')=?)
          AND (? IS NULL OR a.target=? OR EXISTS(SELECT 1 FROM json_each(CASE WHEN a.action='cells' THEN COALESCE(json_extract(a.after_json,'$.$data'),a.after_json) ELSE '[]' END) c WHERE json_extract(c.value,'$.taskId')=?) OR (a.action='format' AND EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(a.after_json,'$.$data.taskIds'),json_extract(a.after_json,'$.taskIds'),'[]')) t WHERE t.value=?))) ORDER BY a.created_at DESC,a.rowid DESC LIMIT ?`,
      )
      .all(teamId, sheetId, sheetId, taskId, taskId, taskId, taskId, limit);
    const reports = new Map();
    const reportSnapshots = new Map();
    for (const row of rows) {
      if (!row.report_id || reports.has(row.report_id)) continue;
      reports.set(
        row.report_id,
        db
          .prepare("SELECT * FROM reports WHERE id=? AND team_id=?")
          .get(row.report_id, teamId),
      );
    }
    return {
      entries: rows.map((r) => {
        const before = parse(r.before_json),
          after = parse(r.after_json);
        const report = reports.get(r.report_id);
        if (before?.deletedTasks && report && !reportSnapshots.has(report.id))
          reportSnapshots.set(report.id, decodeReport(report.data));
        const task =
          r.action === "delete" &&
          db
            .prepare("SELECT deleted_at AS deletedAt FROM tasks WHERE id=?")
            .get(r.target);
        const latestDeletion =
          task?.deletedAt &&
          db
            .prepare(
              "SELECT id FROM audit WHERE team_id=? AND action='delete' AND target=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
            )
            .get(teamId, r.target);
        return {
          id: r.id,
          actor: r.actor,
          actorId: r.actor_id,
          action: r.action,
          target: r.target,
          before,
          after,
          sheet: {
            id: r.report_id || "original",
            name: r.report_id
              ? report?.name || after?.name || before?.name || "삭제된 사본"
              : "원본",
          },
          restorableTaskIds:
            r.action === "delete" && latestDeletion?.id === r.id
              ? [r.target]
              : r.action === "report-edit" && before?.deletedTasks && report
                ? deletedReportTasks(db, r, reportSnapshots.get(report.id)).map(
                    (t) => t.id,
                  )
                : [],
          createdAt: r.created_at,
        };
      }),
    };
  }
  restore(user, entryId, body) {
    const {
      db,
      control: { teamAccess, taskAccess, managedTeam, restoreTaskRows },
    } = this;
    const work = () => {
      const entry = db.prepare("SELECT * FROM audit WHERE id=?").get(entryId);
      requireThat(entry, 404, "이력을 찾을 수 없습니다.");
      if (entry.action === "report-edit") {
        teamAccess(user, entry.team_id);
        retentionView(db, entry.team_id).requireVisible("report", [
          entry.target,
        ]);
        return restoreReportTasks(db, user, entry, body.revision);
      }
      const team = managedTeam(
        user,
        entry.team_id,
        "팀장만 이전 내용을 복원할 수 있습니다.",
      );
      if (entry.action === "delete") {
        const latest = db
          .prepare(
            "SELECT id FROM audit WHERE team_id=? AND action='delete' AND target=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
          )
          .get(entry.team_id, entry.target);
        requireThat(
          latest?.id === entry.id,
          409,
          "이후 삭제 이력이 있습니다. 최신 이력에서 복구하세요.",
        );
        const task = taskAccess(user, entry.target, false, true);
        return restoreTaskRows(user, [
          {
            id: task.id,
            updatedAt: parse(entry.after_json)?.updatedAt || task.updatedAt,
          },
        ]);
      }
      if (entry.action === "format") {
        const expectedRevision = z
          .number()
          .int()
          .nonnegative()
          .parse(body.formatRevision);
        const expectedCells = z
          .record(z.string(), z.number().int().nonnegative())
          .parse(body.versions);
        const request = {
          operationId: id(),
          createdAt: now(),
          format: {
            teamId: entry.team_id,
            expectedRevision,
            restore: entry.target,
            expectedCells,
          },
        };
        return transaction(db, () =>
          applyFormatting(db, user, request, team, entry),
        );
      }
      requireThat(
        entry.action === "cells",
        400,
        "셀 변경 이력만 이 화면에서 복원할 수 있습니다.",
      );
      const expected = z
        .record(z.string(), z.number().int())
        .parse(body.versions);
      const before = parse(entry.before_json, []);
      const restored = transaction(db, () => {
        const prev = [],
          after = [],
          tasks = new Map();
        for (const c of before) {
          if (!tasks.has(c.taskId))
            tasks.set(c.taskId, taskAccess(user, c.taskId, true));
          const task = tasks.get(c.taskId);
          const current = task.cells[c.key] ?? {
            value: "",
            style: {},
            version: 0,
          };
          requireThat(
            expected[`${c.taskId}:${c.key}`] === current.version,
            409,
            "복구 대상이 변경되었습니다. 최신 이력을 다시 확인하세요.",
          );
          prev.push({ taskId: c.taskId, key: c.key, ...current });
          after.push({
            ...c,
            version: current.version + 1,
          });
        }
        const put = upsertCellStatement(db);
        for (const c of after)
          put.run(c.taskId, c.key, c.value, c.style, c.version);
        pruneStyles(
          db,
          prev.map((c) => c.style),
        );
        touchTasks(db, [...tasks.values()]);
        audit(db, user.id, entry.team_id, "cells", id(), prev, after);
        return after;
      });
      return { cells: restored };
    };
    const value = db.syncCapture
      ? db.syncCapture.withActor(user.id, work)
      : work();
    const entry = db
      .prepare("SELECT team_id,action,target FROM audit WHERE id=?")
      .get(entryId);
    if (entry) {
      this.documentEvents?.invalidate("team:" + entry.team_id);
      if (entry.action === "report-edit")
        this.documentEvents?.invalidate("report:" + entry.target);
    }
    return value;
  }
}
