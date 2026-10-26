import { registerEventRoute } from "./event-streams.mjs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { validateDocumentImages } from "./document-images.mjs";
import {
  readDocumentVersion,
  storeDocumentVersion,
  pruneDocumentVersions,
  withTaskDocumentReferences,
} from "./document-storage.mjs";
import { audit, now, transaction, touchTasks } from "./db.mjs";
import { documentSchema, requireThat } from "./validation.mjs";
import {
  DEFAULT_DOCUMENT_ID,
  DEFAULT_DOCUMENT_TITLE,
  MAX_TASK_DOCUMENTS,
  MAX_DOCUMENT_TITLE_LENGTH,
  hasDocumentContent,
} from "../shared/task-documents.js";

export const documentIdSchema = z.union([
  z.literal(DEFAULT_DOCUMENT_ID),
  z.string().uuid(),
]);
export const documentTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_DOCUMENT_TITLE_LENGTH, "문서 제목은 50자까지 입력할 수 있습니다.");
export const createDocumentSchema = z
  .object({ id: z.string().uuid(), title: documentTitleSchema.optional() })
  .strict();
export const renameDocumentSchema = z
  .object({ title: documentTitleSchema, expectedTitle: z.string().max(80) })
  .strict();
export function blankDocument(id = DEFAULT_DOCUMENT_ID) {
  return {
    id,
    title: DEFAULT_DOCUMENT_TITLE,
    markdown: "",
    revision: 0,
    updatedAt: null,
  };
}
export function nextDocumentTitle(documents) {
  const titles = new Set(documents.map((doc) => doc.title));
  let number = 1;
  while (titles.has(`문서 ${number}`)) number++;
  return `문서 ${number}`;
}
export function getTaskDocument(db, taskId, documentId = DEFAULT_DOCUMENT_ID) {
  const row = db
    .prepare(
      "SELECT d.id,d.title,v.markdown,d.revision,d.updated_at AS updatedAt FROM task_documents d JOIN document_versions v ON v.id=d.version_id WHERE d.task_id=? AND d.id=?",
    )
    .get(taskId, documentId);
  requireThat(
    row ||
      (documentId === DEFAULT_DOCUMENT_ID &&
        !db
          .prepare("SELECT 1 FROM task_documents WHERE task_id=? LIMIT 1")
          .get(taskId)),
    404,
    "문서를 찾을 수 없습니다.",
  );
  return row || blankDocument(documentId);
}
export function listTaskDocuments(db, taskId) {
  const docs = db
    .prepare(
      "SELECT id,title,has_content AS hasContent,revision,updated_at AS updatedAt FROM task_documents WHERE task_id=? ORDER BY position,id",
    )
    .all(taskId);
  return docs.length
    ? docs
    : [
        {
          id: DEFAULT_DOCUMENT_ID,
          title: DEFAULT_DOCUMENT_TITLE,
          revision: 0,
          hasContent: false,
          updatedAt: null,
        },
      ];
}
export function withTaskDocuments(db, tasks) {
  return withTaskDocumentReferences(db, tasks).map((task) => ({
    ...task,
    documents: task.documents.map((doc) => ({
      id: doc.id,
      title: doc.title,
      markdown: readDocumentVersion(db, doc.versionId).markdown,
    })),
  }));
}
const saveSchema = z
  .object({
    ...documentSchema.shape,
    expectedRevision: z.number().int().nonnegative(),
    operationId: z.string().uuid(),
  })
  .strict();

export function installTaskDocumentRoutes(
  app,
  { db, taskAccess, documentImagesDir, documentEvents },
) {
  const summary = (task) => {
    const documents = db
      .prepare(
        "SELECT COUNT(*) AS count,MAX(has_content) AS has_content FROM task_documents WHERE task_id=?",
      )
      .get(task.id);
    return {
      hasDocument: !!documents.has_content,
      documentCount: documents.count,
      taskUpdatedAt: db
        .prepare("SELECT updated_at FROM tasks WHERE id=?")
        .get(task.id).updated_at,
    };
  };
  function insert(task, id, title, position, actorId) {
    db.prepare(
      "INSERT INTO task_documents(task_id,id,title,position,version_id,has_content,revision,updated_at,actor_id) VALUES(?,?,?,?,?,0,0,?,?)",
    ).run(
      task.id,
      id,
      title,
      position,
      storeDocumentVersion(db, {
        teamId: task.teamId,
        documentId: `${task.id}:${id}`,
        markdown: "",
        actorId,
      }),
      now(),
      actorId,
    );
  }
  registerEventRoute(app, "/api/tasks/:id/documents/events", (req, res) =>
    documentEvents.watch(
      req,
      res,
      `list:/api/tasks/${req.params.id}/documents`,
      (request) => taskAccess(request.user, request.params.id),
    ),
  );
  app.get("/api/tasks/:id/documents", (req, res) => {
    const task = taskAccess(req.user, req.params.id);
    res.json({
      documents:
        req.query.content === "1"
          ? withTaskDocuments(db, [task])[0].documents
          : listTaskDocuments(db, task.id),
    });
  });
  app.post("/api/tasks/:id/documents", (req, res) => {
    const data = createDocumentSchema.parse(req.body);
    const result = transaction(db, () => {
      const task = taskAccess(req.user, req.params.id, true);
      let docs = listTaskDocuments(db, task.id);
      if (!docs.some((doc) => doc.id === data.id)) {
        requireThat(
          docs.length < MAX_TASK_DOCUMENTS,
          400,
          `업무마다 문서를 ${MAX_TASK_DOCUMENTS}개까지 추가할 수 있습니다.`,
        );
        if (
          !db
            .prepare("SELECT 1 FROM task_documents WHERE task_id=? LIMIT 1")
            .get(task.id)
        )
          insert(
            task,
            DEFAULT_DOCUMENT_ID,
            DEFAULT_DOCUMENT_TITLE,
            0,
            req.user.id,
          );
        const position =
          db
            .prepare(
              "SELECT MAX(position) AS value FROM task_documents WHERE task_id=?",
            )
            .get(task.id).value + 1;
        insert(
          task,
          data.id,
          data.title || nextDocumentTitle(docs),
          position,
          req.user.id,
        );
        touchTasks(db, [task]);
        audit(
          db,
          req.user.id,
          task.teamId,
          "document-create",
          task.id,
          undefined,
          { documentId: data.id },
        );
        docs = listTaskDocuments(db, task.id);
      }
      return { documents: docs, ...summary(task) };
    });
    res.status(201).json(result);
  });
  app.patch("/api/tasks/:id/documents/:documentId", (req, res) => {
    const data = renameDocumentSchema.parse(req.body);
    const docId = documentIdSchema.parse(req.params.documentId);
    res.json(
      transaction(db, () => {
        const task = taskAccess(req.user, req.params.id, true);
        const current = documentEvents.stamp(
          getTaskDocument(db, task.id, docId),
        );
        requireThat(
          current.title === data.expectedTitle || current.title === data.title,
          409,
          "문서 이름이 변경되었습니다. 목록을 다시 불러와 주세요.",
        );
        if (
          !db
            .prepare("SELECT 1 FROM task_documents WHERE task_id=? AND id=?")
            .get(task.id, docId)
        )
          insert(task, docId, current.title, 0, req.user.id);
        db.prepare(
          "UPDATE task_documents SET title=? WHERE task_id=? AND id=?",
        ).run(data.title, task.id, docId);
        touchTasks(db, [task]);
        return { documents: listTaskDocuments(db, task.id), ...summary(task) };
      }),
    );
  });
  app.delete("/api/tasks/:id/documents/:documentId", (req, res) => {
    const docId = documentIdSchema.parse(req.params.documentId);
    const data = z
      .object({ expectedRevision: z.number().int().nonnegative() })
      .strict()
      .parse(req.body);
    res.json(
      transaction(db, () => {
        const task = taskAccess(req.user, req.params.id, true);
        const current = documentEvents.stamp(
          getTaskDocument(db, task.id, docId),
        );
        requireThat(
          current.revision === data.expectedRevision,
          409,
          "문서가 변경되었습니다. 최신 문서를 확인한 뒤 삭제하세요.",
        );
        db.prepare("DELETE FROM task_documents WHERE task_id=? AND id=?").run(
          task.id,
          docId,
        );
        touchTasks(db, [task]);
        pruneDocumentVersions(db, task.teamId);
        audit(db, req.user.id, task.teamId, "document-delete", task.id, {
          documentId: docId,
          title: current.title,
        });
        return { documents: listTaskDocuments(db, task.id), ...summary(task) };
      }),
    );
  });
  const documentKey = (req) =>
    `task:${req.params.id}:${req.params.documentId || DEFAULT_DOCUMENT_ID}`;
  function readDocument(req) {
    const task = taskAccess(req.user, req.params.id);
    return {
      ...getTaskDocument(
        db,
        task.id,
        documentIdSchema.parse(req.params.documentId || DEFAULT_DOCUMENT_ID),
      ),
      ...summary(task),
    };
  }
  for (const path of [
    "/api/tasks/:id/document",
    "/api/tasks/:id/documents/:documentId",
  ]) {
    app.get(path, (req, res) => {
      taskAccess(req.user, req.params.id);
      res.json(
        documentEvents.stamp(
          getTaskDocument(
            db,
            req.params.id,
            documentIdSchema.parse(
              req.params.documentId || DEFAULT_DOCUMENT_ID,
            ),
          ),
        ),
      );
    });
    registerEventRoute(app, `${path}/events`, (req, res) =>
      documentEvents.subscribe(req, res, documentKey(req), readDocument),
    );
    app.put(path, (req, res) => {
      const data = saveSchema.parse(req.body);
      const docId = documentIdSchema.parse(
        req.params.documentId || DEFAULT_DOCUMENT_ID,
      );
      const result = transaction(db, () => {
        const task = taskAccess(req.user, req.params.id, true);
        const current = documentEvents.stamp(
          getTaskDocument(db, task.id, docId),
        );
        const hash = createHash("sha256")
          .update(JSON.stringify(data))
          .digest("hex");
        const previous = db
          .prepare(
            "SELECT operation_id,request_hash,actor_id,version_id FROM task_documents WHERE task_id=? AND id=?",
          )
          .get(task.id, docId);
        const replay =
          previous?.operation_id === data.operationId &&
          previous.actor_id === req.user.id &&
          previous.request_hash === hash;
        requireThat(
          replay || current.revision === data.expectedRevision,
          409,
          "다른 사용자가 문서를 수정했습니다. 입력은 보존되었습니다. 최신 문서를 확인한 뒤 다시 저장하세요.",
          { current },
        );
        if (!replay && current.markdown !== data.markdown) {
          validateDocumentImages(data.markdown, task.teamId, documentImagesDir);
          const updatedAt = now();
          db.prepare(
            `INSERT INTO task_documents(task_id,id,title,version_id,has_content,revision,updated_at,actor_id,operation_id,request_hash)
            VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,id) DO UPDATE SET version_id=excluded.version_id,has_content=excluded.has_content,revision=excluded.revision,updated_at=excluded.updated_at,actor_id=excluded.actor_id,operation_id=excluded.operation_id,request_hash=excluded.request_hash`,
          ).run(
            task.id,
            docId,
            current.title,
            storeDocumentVersion(db, {
              teamId: task.teamId,
              documentId:
                readDocumentVersion(db, previous?.version_id)?.documentId ||
                `${task.id}:${docId}`,
              markdown: data.markdown,
              actorId: req.user.id,
            }),
            Number(hasDocumentContent(data.markdown)),
            current.revision + 1,
            updatedAt,
            req.user.id,
            data.operationId,
            hash,
          );
          touchTasks(db, [task]);
          audit(
            db,
            req.user.id,
            task.teamId,
            "document",
            task.id,
            {
              documentId: docId,
              revision: current.revision,
              bytes: Buffer.byteLength(current.markdown),
            },
            {
              documentId: docId,
              revision: current.revision + 1,
              bytes: Buffer.byteLength(data.markdown),
              updatedAt,
            },
          );
          pruneDocumentVersions(db, task.teamId);
        }
        return { ...getTaskDocument(db, task.id, docId), ...summary(task) };
      });
      res.json(documentEvents.publish(documentKey(req), result));
    });
  }
}
