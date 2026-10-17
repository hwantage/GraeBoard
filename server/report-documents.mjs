import { createHash } from "node:crypto";
import { z } from "zod";
import { transaction, audit, parse } from "./db.mjs";
import { documentSchema, requireThat } from "./validation.mjs";
import { encodeReport } from "./reports.mjs";
import { canContribute } from "../shared/domain.js";
import {
  DEFAULT_DOCUMENT_ID,
  DEFAULT_DOCUMENT_TITLE,
  MAX_TASK_DOCUMENTS,
} from "../shared/task-documents.js";
import {
  documentIdSchema,
  createDocumentSchema,
  renameDocumentSchema,
  blankDocument,
  nextDocumentTitle,
} from "./task-documents.mjs";
import {
  readDocumentVersion,
  storeReportDocuments,
  syncReportDocuments,
  pruneDocumentVersions,
  readReport,
  reportDocumentTasks,
} from "./document-storage.mjs";
import { validateDocumentImages } from "./document-images.mjs";

export function reportTaskDocument(db, task, documentId = DEFAULT_DOCUMENT_ID) {
  const doc = task.documents?.find((doc) => doc.id === documentId);
  requireThat(
    doc || (documentId === DEFAULT_DOCUMENT_ID && !task.documents?.length),
    404,
    "문서를 찾을 수 없습니다.",
  );
  const version = readDocumentVersion(db, doc?.versionId);
  return version
    ? {
        id: doc.id,
        title: doc.title,
        markdown: version.markdown,
        revision: version.id,
        updatedAt: version.createdAt,
      }
    : blankDocument(documentId);
}
function listDocuments(task) {
  const docs = (task.documents || []).map((doc) => ({
    id: doc.id,
    title: doc.title,
    hasContent: !!doc.hasContent,
    revision: doc.versionId,
    updatedAt: null,
  }));
  return docs.length
    ? docs
    : [
        {
          id: DEFAULT_DOCUMENT_ID,
          title: DEFAULT_DOCUMENT_TITLE,
          hasContent: false,
          revision: 0,
          updatedAt: null,
        },
      ];
}
const revisionSchema = z.union([z.literal(0), z.string().uuid()]);
const saveSchema = z
  .object({
    ...documentSchema.shape,
    expectedRevision: revisionSchema,
    operationId: z.string().uuid(),
  })
  .strict();

export function installReportDocumentRoutes(
  app,
  { db, teamAccess, documentImagesDir },
) {
  function reportAccess(req, write = false) {
    const row = db
      .prepare("SELECT * FROM reports WHERE id=?")
      .get(req.params.id);
    requireThat(row, 404, "사본을 찾을 수 없습니다.");
    teamAccess(req.user, row.team_id);
    if (write)
      requireThat(
        canContribute(req.user, row.team_id),
        403,
        "사본을 편집할 권한이 없습니다.",
      );
    return row;
  }
  function access(req, write = false) {
    const row = reportAccess(req, write);
    const tasks = reportDocumentTasks(db, row, [req.params.taskId]);
    requireThat(tasks, 404, "사본에서 해당 업무를 찾지 못했습니다.");
    return { row, task: tasks[0] };
  }
  function persist({ row, task }, documents, actorId) {
    const report = readReport(db, row);
    const original = report.tasks.find((item) => item.id === task.id);
    const [saved] = storeReportDocuments(
      db,
      [{ ...original, documents }],
      row.team_id,
      actorId,
    );
    const tasks = report.tasks.map((item) =>
      item.id === task.id ? saved : item,
    );
    db.prepare("UPDATE reports SET data=? WHERE id=?").run(
      encodeReport({ ...report, tasks }),
      row.id,
    );
    syncReportDocuments(db, row.id, tasks);
    pruneDocumentVersions(db, row.team_id);
    return saved;
  }
  function persistBody({ row, task }, document, actorId) {
    const [saved] = storeReportDocuments(
      db,
      [
        {
          ...task,
          documents: task.documents.map((doc) =>
            doc.id === document.id ? document : doc,
          ),
        },
      ],
      row.team_id,
      actorId,
    );
    const version = saved.documents.find((doc) => doc.id === document.id);
    db.prepare(
      "UPDATE report_documents SET version_id=? WHERE report_id=? AND task_id=? AND document_id=?",
    ).run(version.versionId, row.id, task.id, document.id);
    pruneDocumentVersions(db, row.team_id, [document.versionId]);
    return saved;
  }
  function result(task) {
    return {
      documents: listDocuments(task),
      hasDocument: !!task.hasDocument,
      documentCount: task.documents?.length || 0,
      taskUpdatedAt: task.updatedAt,
    };
  }
  const base = "/api/reports/:id/tasks/:taskId";
  app.post("/api/reports/:id/documents/batch", (req, res) => {
    const { taskIds } = z
      .object({
        taskIds: z.array(z.string().uuid()).min(1).max(100),
      })
      .strict()
      .parse(req.body);
    const row = reportAccess(req);
    const tasks = reportDocumentTasks(db, row, taskIds);
    requireThat(tasks, 404, "사본에서 해당 업무를 찾지 못했습니다.");
    const result = [];
    let bytes = 0;
    for (const task of tasks) {
      const documents = task.documents.map((doc) => ({
        id: doc.id,
        title: doc.title,
        markdown: readDocumentVersion(db, doc.versionId).markdown,
      }));
      const size = documents.reduce(
        (sum, doc) => sum + Buffer.byteLength(doc.markdown),
        0,
      );
      // Bound each response; one row (at most 50 × 256 KiB) is indivisible.
      if (result.length && bytes + size > 8 * 1024 * 1024) break;
      result.push({ id: task.id, documents });
      bytes += size;
    }
    res.json({ tasks: result });
  });
  app.get(base + "/documents", (req, res) => {
    const { task } = access(req);
    res.json({
      documents:
        req.query.content === "1"
          ? (task.documents || []).map((doc) => ({
              id: doc.id,
              title: doc.title,
              markdown: readDocumentVersion(db, doc.versionId).markdown,
            }))
          : listDocuments(task),
    });
  });
  app.post(base + "/documents", (req, res) => {
    const data = createDocumentSchema.parse(req.body);
    res.status(201).json(
      transaction(db, () => {
        const state = access(req, true);
        const docs = state.task.documents?.length
          ? state.task.documents
          : [
              {
                id: DEFAULT_DOCUMENT_ID,
                title: DEFAULT_DOCUMENT_TITLE,
                markdown: "",
              },
            ];
        if (docs.some((doc) => doc.id === data.id)) return result(state.task);
        requireThat(
          docs.length < MAX_TASK_DOCUMENTS,
          400,
          `업무마다 문서를 ${MAX_TASK_DOCUMENTS}개까지 추가할 수 있습니다.`,
        );
        const saved = persist(
          state,
          [
            ...docs,
            {
              id: data.id,
              title: data.title || nextDocumentTitle(docs),
              markdown: "",
            },
          ],
          req.user.id,
        );
        audit(
          db,
          req.user.id,
          state.row.team_id,
          "document-create",
          `${state.row.id}:${state.task.id}`,
          undefined,
          { documentId: data.id },
        );
        return result(saved);
      }),
    );
  });
  app.patch(base + "/documents/:documentId", (req, res) => {
    const data = renameDocumentSchema.parse(req.body);
    const docId = documentIdSchema.parse(req.params.documentId);
    res.json(
      transaction(db, () => {
        const state = access(req, true);
        const current = reportTaskDocument(db, state.task, docId);
        requireThat(
          current.title === data.expectedTitle || current.title === data.title,
          409,
          "문서 이름이 변경되었습니다. 목록을 다시 불러와 주세요.",
        );
        const docs = state.task.documents?.length
          ? state.task.documents
          : [
              {
                id: DEFAULT_DOCUMENT_ID,
                title: DEFAULT_DOCUMENT_TITLE,
                markdown: "",
              },
            ];
        return result(
          persist(
            state,
            docs.map((doc) =>
              doc.id === docId ? { ...doc, title: data.title } : doc,
            ),
            req.user.id,
          ),
        );
      }),
    );
  });
  app.delete(base + "/documents/:documentId", (req, res) => {
    const data = z
      .object({ expectedRevision: revisionSchema })
      .strict()
      .parse(req.body);
    const docId = documentIdSchema.parse(req.params.documentId);
    res.json(
      transaction(db, () => {
        const state = access(req, true);
        const current = reportTaskDocument(db, state.task, docId);
        requireThat(
          current.revision === data.expectedRevision,
          409,
          "문서가 변경되었습니다. 최신 문서를 확인한 뒤 삭제하세요.",
        );
        const saved = persist(
          state,
          (state.task.documents || []).filter((doc) => doc.id !== docId),
          req.user.id,
        );
        audit(
          db,
          req.user.id,
          state.row.team_id,
          "document-delete",
          `${state.row.id}:${state.task.id}`,
          { documentId: docId, title: current.title },
        );
        return result(saved);
      }),
    );
  });
  for (const path of [base + "/document", base + "/documents/:documentId"]) {
    app.get(path, (req, res) => {
      const { task } = access(req);
      res.json(
        reportTaskDocument(
          db,
          task,
          documentIdSchema.parse(req.params.documentId || DEFAULT_DOCUMENT_ID),
        ),
      );
    });
    app.put(path, (req, res) => {
      const data = saveSchema.parse(req.body);
      const docId = documentIdSchema.parse(
        req.params.documentId || DEFAULT_DOCUMENT_ID,
      );
      res.json(
        transaction(db, () => {
          const state = access(req, true);
          const { row, task } = state;
          const current = reportTaskDocument(db, task, docId);
          const target = `${row.id}:${task.id}:${docId}`;
          const requestHash = createHash("sha256")
            .update(JSON.stringify(data))
            .digest("hex");
          const last = db
            .prepare(
              "SELECT after_json FROM audit WHERE team_id=? AND action='report-document' AND target=? AND actor_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
            )
            .get(row.team_id, target, req.user.id);
          const previous = last && parse(last.after_json);
          const replay =
            previous?.operationId === data.operationId &&
            previous.requestHash === requestHash &&
            previous.revision === current.revision;
          requireThat(
            replay || current.revision === data.expectedRevision,
            409,
            "다른 사용자가 문서를 수정했습니다. 입력은 보존되었습니다. 최신 문서를 확인한 뒤 다시 저장하세요.",
            { current },
          );
          let saved = task;
          if (!replay && current.markdown !== data.markdown) {
            validateDocumentImages(
              data.markdown,
              row.team_id,
              documentImagesDir,
            );
            const docs = task.documents || [];
            const existing = docs.find((doc) => doc.id === docId);
            const document = {
              ...existing,
              id: docId,
              title: current.title,
              markdown: data.markdown,
            };
            saved = existing
              ? persistBody(state, document, req.user.id)
              : persist(state, [...docs, document], req.user.id);
            audit(
              db,
              req.user.id,
              row.team_id,
              "report-document",
              target,
              { revision: current.revision },
              {
                revision: reportTaskDocument(db, saved, docId).revision,
                operationId: data.operationId,
                requestHash,
              },
            );
          }
          return {
            ...reportTaskDocument(db, saved, docId),
            hasDocument: !!saved.hasDocument,
            documentCount: saved.documents?.length || 0,
            taskUpdatedAt: task.updatedAt,
          };
        }),
      );
    });
  }
}
