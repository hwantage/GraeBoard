import { prepareReportEdits } from "./storage/report-command-rules.mjs";
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
} from "../shared/validation.js";
import {
  encodeReport,
  decodeReport,
  reportUsersWithAvatars,
  reportDataKey,
  withReportDecodeCache,
} from "./reports.mjs";

import { editSchema } from "./storage/report-command-schema.mjs";

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

export function editReport(
  { db, teamAccess, documentImagesDir },
  user,
  reportId,
  input,
) {
  const data = editSchema.parse(input);
  const result = withReportDecodeCache(() =>
    transaction(db, () => {
      const row = db.prepare("SELECT * FROM reports WHERE id=?").get(reportId);
      requireThat(row, 404, "사본을 찾을 수 없습니다.");
      teamAccess(user, row.team_id);
      requireThat(
        canContribute(user, row.team_id),
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
          .get(row.team_id, row.id, user.id);
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
      const available = db
        .prepare(
          "SELECT u.id,u.name FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.team_id=? AND m.role IN ('lead','member')",
        )
        .all(row.team_id);
      const prepared = prepareReportEdits({
        report,
        operations: data.operations,
        teamId: row.team_id,
        year: data.view?.year ?? row.year,
        actorId: user.id,
        available,
      });
      let { tasks } = prepared;
      const { deleted, people } = prepared;
      for (const task of [...tasks, ...deleted.values()])
        for (const document of task.documents || [])
          if (document.markdown !== undefined)
            validateDocumentImages(document.markdown, row.team_id);
      tasks = storeReportDocuments(db, tasks, row.team_id, user.id);
      const remaining = new Set(tasks.map((task) => task.id));
      const deletedTasks = reportDocumentContents(db, {
        tasks: storeReportDocuments(
          db,
          [...deleted.values()].filter((task) => !remaining.has(task.id)),
          row.team_id,
          user.id,
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
        user.id,
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
    }),
  );
  return result;
}
