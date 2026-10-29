import { requireThat } from "../shared/validation.js";
import { DEFAULT_DOCUMENT_ID } from "../shared/task-documents.js";
import { blankDocument } from "./storage/document-service.mjs";
import { readDocumentVersion } from "./document-storage.mjs";

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
