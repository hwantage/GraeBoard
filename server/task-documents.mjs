import {
  readDocumentVersion,
  withTaskDocumentReferences,
} from "./document-storage.mjs";
import { requireThat } from "./validation.mjs";
import {
  DEFAULT_DOCUMENT_ID,
  DEFAULT_DOCUMENT_TITLE,
} from "../shared/task-documents.js";
import { blankDocument } from "./storage/document-service.mjs";
export {
  documentIdSchema,
  documentTitleSchema,
  createDocumentSchema,
  renameDocumentSchema,
  blankDocument,
  nextDocumentTitle,
} from "./storage/document-service.mjs";

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
