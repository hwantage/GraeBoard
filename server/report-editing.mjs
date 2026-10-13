import { createHash } from "node:crypto";
import { z } from "zod";
import {
  applyReportOperation,
  ReportEditError,
} from "../shared/report-editing.js";
import { transaction, audit, parse } from "./db.mjs";
import { propertiesFor } from "../shared/domain.js";
import {
  changeSchema,
  copiedRowSchema,
  formatSchema,
  validateCellValue,
  validCellKey,
  requireThat,
} from "./validation.mjs";
import {
  encodeReport,
  decodeReport,
  reportUsersWithAvatars,
} from "./reports.mjs";

const ids = z.array(z.string().uuid()).min(1).max(20000);
const base = { at: z.iso.datetime() };
const editSchema = z
  .object({
    operationId: z.string().uuid(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    operations: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              ...base,
              kind: z.literal("cells"),
              changes: z.array(changeSchema).min(1).max(200000),
            })
            .strict(),
          z
            .object({
              ...base,
              kind: z.literal("format"),
              id: z.string().uuid(),
              scopes: formatSchema.shape.scopes.unwrap(),
            })
            .strict(),
          z
            .object({
              ...base,
              kind: z.literal("create"),
              taskId: z.string().uuid(),
              sourceId: z.string().uuid().optional(),
              copiedRow: copiedRowSchema.optional(),
              fields: z
                .record(z.string().max(80), changeSchema.shape.value.unwrap())
                .default({}),
              insertAt: z
                .object({
                  taskId: z.string().uuid(),
                  placement: z.enum(["before", "after"]),
                })
                .strict()
                .optional(),
            })
            .strict(),
          z
            .object({ ...base, kind: z.literal("delete"), taskIds: ids })
            .strict(),
          z
            .object({
              ...base,
              kind: z.literal("reorder"),
              taskIds: ids,
              targetId: z.string().uuid(),
              placement: z.enum(["before", "after"]),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(1000),
  })
  .strict();

export const reportRevision = (data) =>
  createHash("sha256").update(data).digest("hex");

export function reportResponse(db, row) {
  const report = decodeReport(row.data);
  return {
    id: row.id,
    name: row.name,
    year: row.year,
    referenceDate: row.reference_date,
    createdAt: row.created_at,
    ...report,
    revision: reportRevision(row.data),
    users: reportUsersWithAvatars(db, report.users),
  };
}

export function installReportEditingRoutes(app, { db, managedTeam }) {
  app.patch("/api/reports/:id", (req, res) => {
    const data = editSchema.parse(req.body);
    const result = transaction(db, () => {
      const row = db
        .prepare("SELECT * FROM reports WHERE id=?")
        .get(req.params.id);
      requireThat(row, 404, "스냅샷을 찾을 수 없습니다.");
      managedTeam(req.user, row.team_id, "팀장만 보고본을 수정할 수 있습니다.");
      const revision = reportRevision(row.data);
      const requestHash = createHash("sha256")
        .update(JSON.stringify(data))
        .digest("hex");
      if (revision !== data.revision) {
        // A lost response may be retried after the save committed. Reuse only
        // this actor's exact request while its saved report is still current.
        const last = db
          .prepare(
            "SELECT after_json FROM audit WHERE team_id=? AND action='report-edit' AND target=? AND actor_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
          )
          .get(row.team_id, row.id, req.user.id);
        const previous = last && parse(last.after_json);
        if (
          previous?.operationId === data.operationId &&
          previous.requestHash === requestHash &&
          previous.revision === revision
        )
          return reportResponse(db, row);
      }
      requireThat(
        revision === data.revision,
        409,
        "다른 사용자가 보고본을 수정했습니다. 입력은 유지됩니다. 수정 취소 후 스냅샷을 다시 열어 최신 내용을 확인하세요.",
      );
      const report = decodeReport(row.data);
      // A copied row may contain archived columns/options that were already
      // present in this report. Keep them without importing the live schema.
      const copySettings = {
        ...report.settings,
        properties: propertiesFor(report.settings, true).map((property) => ({
          ...property,
          archived: false,
          values: property.values.map((option) => ({
            ...option,
            archived: false,
          })),
        })),
      };
      const available = db
        .prepare(
          "SELECT u.id,u.name FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.team_id=? AND m.role IN ('lead','member')",
        )
        .all(row.team_id);
      const people = new Map(report.users.map((user) => [user.id, user]));
      for (const user of available)
        if (!people.has(user.id))
          people.set(user.id, { id: user.id, name: user.name });
      const assignable = new Set(people.keys());
      let tasks = report.tasks;
      let changedCells = 0;
      for (const operation of data.operations) {
        const byId = new Map(tasks.map((task) => [task.id, task]));
        if (operation.kind === "cells") {
          changedCells += operation.changes.length;
          for (const change of operation.changes) {
            const task = byId.get(change.taskId);
            requireThat(task, 400, "보고본에서 해당 업무를 찾지 못했습니다.");
            validateCellValue(
              db,
              row.team_id,
              change.key,
              change.value,
              report.settings,
              task.cells[change.key]?.value,
              assignable,
            );
          }
        }
        if (operation.kind === "create")
          for (const [key, value] of Object.entries(operation.fields))
            validateCellValue(
              db,
              row.team_id,
              key,
              value,
              report.settings,
              undefined,
              assignable,
            );
        if (operation.kind === "create" && operation.copiedRow)
          for (const [key, cell] of Object.entries(operation.copiedRow.cells))
            validateCellValue(
              db,
              row.team_id,
              key,
              cell.value,
              copySettings,
              undefined,
              assignable,
            );
        if (operation.kind === "format")
          for (const scope of operation.scopes)
            for (const key of [
              ...(scope.keys || []),
              ...(scope.excludeKeys || []),
            ])
              requireThat(
                validCellKey(key, report.settings),
                400,
                "보고본에 없는 속성입니다.",
              );
        requireThat(
          changedCells <= 200000,
          400,
          "한 번에 저장할 보고본 변경이 너무 많습니다.",
        );
        try {
          tasks = applyReportOperation(tasks, operation, {
            teamId: row.team_id,
            year: row.year,
            actorId: req.user.id,
            settings: report.settings,
          });
        } catch (error) {
          if (!(error instanceof ReportEditError)) throw error;
          requireThat(false, 400, error.message);
        }
      }
      const saved = encodeReport({
        ...report,
        tasks,
        users: [...people.values()],
      });
      db.prepare("UPDATE reports SET data=? WHERE id=?").run(saved, row.id);
      audit(
        db,
        req.user.id,
        row.team_id,
        "report-edit",
        row.id,
        { name: row.name, revision: data.revision, count: report.tasks.length },
        {
          name: row.name,
          revision: reportRevision(saved),
          count: tasks.length,
          operations: data.operations.length,
          operationId: data.operationId,
          requestHash,
        },
      );
      return reportResponse(db, { ...row, data: saved });
    });
    res.json(result);
  });
}
