import { validateDocumentImages } from "./document-images.mjs";
import {
  storeReportDocuments,
  syncReportDocuments,
  pruneDocumentVersions,
  reportDocumentContents,
  readReport,
} from "./document-storage.mjs";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  applyReportOperation,
  ReportEditError,
} from "../shared/report-editing.js";
import { transaction, audit, parse } from "./db.mjs";
import { taskAuditSnapshot } from "../shared/formatting.js";
import { propertiesFor, canContribute } from "../shared/domain.js";
import {
  changeSchema,
  copiedRowSchema,
  formatSchema,
  styleSchema,
  viewSchema,
  validateCellValue,
  validCellKey,
  requireThat,
} from "./validation.mjs";
import {
  encodeReport,
  decodeReport,
  reportUsersWithAvatars,
  reportDataKey,
} from "./reports.mjs";

const ids = z.array(z.string().uuid()).min(1).max(20000);
const base = { at: z.iso.datetime() };
const restoreTaskSchema = z
  .object({
    id: z.string().uuid(),
    teamId: z.string().uuid(),
    years: z.array(z.number().int().min(2000).max(2100)).max(101),
    position: z.number().finite(),
    createdBy: z.string().uuid(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.string().nullable().optional(),
    cells: z.record(
      z.string().max(80),
      z
        .object({
          value: changeSchema.shape.value.unwrap(),
          style: styleSchema,
          version: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    defaultStyle: styleSchema.optional(),
    rowStyle: styleSchema.optional(),
    hasDocument: z.boolean().optional(),
    documentCount: z.number().int().nonnegative().optional(),
    documents: copiedRowSchema.shape.documents,
    formatting: z
      .object({
        revision: z.number().int().nonnegative(),
        rules: z
          .array(
            z
              .object({
                id: z.string().max(100),
                rows: z.array(z.string().uuid()).max(20000).nullable(),
                keys: z.array(z.string().max(80)).max(1000).nullable(),
                excludeKeys: z.array(z.string().max(80)).max(1000).optional(),
                style: styleSchema,
                orders: z.record(
                  z.string().max(30),
                  z.number().int().nonnegative(),
                ),
              })
              .strict(),
          )
          .max(10000),
      })
      .strict()
      .optional(),
  })
  .strict();
const editSchema = z
  .object({
    operationId: z.string().uuid(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    view: viewSchema.optional(),
    operations: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              ...base,
              kind: z.literal("restore"),
              removeIds: z.array(z.string().uuid()).max(20000).optional(),
              tasks: z
                .array(restoreTaskSchema)
                .max(20000)
                .refine(
                  (tasks) =>
                    new Set(tasks.map((task) => task.id)).size === tasks.length,
                ),
            })
            .strict(),
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
      .max(1000),
  })
  .strict();

// Sheet edits and document edits have independent optimistic locks. Always apply
// sheet operations to the latest stored report to preserve its document refs.
const revisions = new Map();
export function reportRevision(data, decoded) {
  const key = reportDataKey(data);
  if (revisions.has(key)) return revisions.get(key);
  const report = decoded || decodeReport(data);
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        ...report,
        tasks: report.tasks.map(
          ({ documents, hasDocument, documentCount, ...task }) => task,
        ),
      }),
    )
    .digest("hex");
  if (revisions.size >= 256) revisions.delete(revisions.keys().next().value);
  revisions.set(key, revision);
  return revision;
}

export function reportResponse(db, row) {
  const report = readReport(db, row);
  return {
    id: row.id,
    name: row.name,
    year: row.year,
    referenceDate: row.reference_date,
    createdAt: row.created_at,
    ...report,
    tasks: report.tasks.map(({ documents, ...task }) => ({
      ...task,
      documentCount: documents?.length || 0,
    })),
    revision: reportRevision(row.data, report),
    users: reportUsersWithAvatars(db, report.users),
  };
}

export function installReportEditingRoutes(
  app,
  { db, teamAccess, documentImagesDir },
) {
  app.patch("/api/reports/:id", (req, res) => {
    const data = editSchema.parse(req.body);
    const result = transaction(db, () => {
      const row = db
        .prepare("SELECT * FROM reports WHERE id=?")
        .get(req.params.id);
      requireThat(row, 404, "사본을 찾을 수 없습니다.");
      teamAccess(req.user, row.team_id);
      requireThat(
        canContribute(req.user, row.team_id),
        403,
        "사본을 편집할 권한이 없습니다.",
      );
      const report = readReport(db, row);
      const revision = reportRevision(row.data, report);
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
        "다른 사용자가 사본을 수정했습니다. 입력은 유지됩니다. 최신 내용을 다시 불러오거나 입력을 보관한 뒤 재시도하세요.",
      );
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
      const deleted = new Map();
      let changedCells = 0;
      for (const operation of data.operations) {
        if (operation.kind === "restore") {
          for (const task of operation.tasks) {
            requireThat(
              task.teamId === row.team_id,
              400,
              "다른 팀의 업무는 복원할 수 없습니다.",
            );
            for (const [key, cell] of Object.entries(task.cells)) {
              changedCells++;
              validateCellValue(
                db,
                row.team_id,
                key,
                cell.value,
                copySettings,
                undefined,
                assignable,
              );
            }
          }
        }
        const byId = new Map(tasks.map((task) => [task.id, task]));
        if (
          operation.kind === "create" &&
          operation.sourceId &&
          operation.copiedRow?.documents
        ) {
          const source = byId.get(operation.sourceId);
          operation.copiedRow.documents = operation.copiedRow.documents.map(
            (doc) => ({
              ...source?.documents?.find((item) => item.id === doc.id),
              ...doc,
            }),
          );
        }
        if (operation.kind === "cells") {
          changedCells += operation.changes.length;
          for (const change of operation.changes) {
            const task = byId.get(change.taskId);
            requireThat(task, 400, "사본에서 해당 업무를 찾지 못했습니다.");
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
                "사본에 없는 속성입니다.",
              );
        requireThat(
          changedCells <= 200000,
          400,
          "한 번에 저장할 사본 변경이 너무 많습니다.",
        );
        try {
          const previous = tasks;
          tasks = applyReportOperation(tasks, operation, {
            teamId: row.team_id,
            year: data.view?.year ?? row.year,
            actorId: req.user.id,
            settings: report.settings,
          });
          const remaining = new Set(tasks.map((task) => task.id));
          for (const task of previous)
            if (!remaining.has(task.id)) deleted.set(task.id, task);
        } catch (error) {
          if (!(error instanceof ReportEditError)) throw error;
          requireThat(false, 400, error.message);
        }
      }
      for (const task of [...tasks, ...deleted.values()])
        for (const document of task.documents || [])
          if (document.markdown !== undefined)
            validateDocumentImages(
              document.markdown,
              row.team_id,
              documentImagesDir,
            );
      tasks = storeReportDocuments(db, tasks, row.team_id, req.user.id);
      const remaining = new Set(tasks.map((task) => task.id));
      const deletedTasks = reportDocumentContents(db, {
        tasks: storeReportDocuments(
          db,
          [...deleted.values()].filter((task) => !remaining.has(task.id)),
          row.team_id,
          req.user.id,
        ),
      }).tasks.map(taskAuditSnapshot);
      const memberKeys = propertiesFor(report.settings, true)
        .filter((p) => p.kind === "member")
        .map((p) => p.id);
      const deletedMemberIds = new Set(
        deletedTasks.flatMap((task) =>
          memberKeys.flatMap((key) => task.cells[key]?.value || []),
        ),
      );
      const saved = encodeReport({
        ...report,
        ...(data.view ? { view: data.view } : {}),
        tasks,
        users: [...people.values()],
      });
      db.prepare("UPDATE reports SET data=?,year=? WHERE id=?").run(
        saved,
        data.view?.year ?? row.year,
        row.id,
      );
      syncReportDocuments(db, row.id, tasks);
      pruneDocumentVersions(db, row.team_id);
      const response = reportResponse(db, {
        ...row,
        year: data.view?.year ?? row.year,
        data: saved,
      });
      audit(
        db,
        req.user.id,
        row.team_id,
        "report-edit",
        row.id,
        {
          name: row.name,
          revision: data.revision,
          count: report.tasks.length,
          ...(deletedTasks.length
            ? {
                deletedTasks,
                deletedUsers: [...people.values()].filter((user) =>
                  deletedMemberIds.has(user.id),
                ),
              }
            : {}),
        },
        {
          name: row.name,
          revision: response.revision,
          count: tasks.length,
          operations: data.operations.length,
          operationId: data.operationId,
          requestHash,
          ...(deletedTasks.length
            ? { deletedTaskIds: deletedTasks.map((task) => task.id) }
            : {}),
        },
      );
      return response;
    });
    res.json(result);
  });
}
