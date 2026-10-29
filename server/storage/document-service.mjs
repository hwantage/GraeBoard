import { withDocumentImageReferences } from "../../shared/document-image-references.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  DOCUMENT_IMAGE_PATTERN,
  MAX_IMAGE_BYTES,
  isDocumentImage,
} from "../../shared/document-images.js";
import {
  documentSchema,
  yearSchema,
  requireThat,
} from "../../shared/validation.js";
import {
  DEFAULT_DOCUMENT_ID,
  DEFAULT_DOCUMENT_TITLE,
  MAX_DOCUMENT_TITLE_LENGTH,
  MAX_TASK_DOCUMENTS,
} from "../../shared/task-documents.js";

const uuid = z.string().uuid();
export const documentIdSchema = z.union([z.literal(DEFAULT_DOCUMENT_ID), uuid]);
export const documentTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_DOCUMENT_TITLE_LENGTH, "문서 제목은 50자까지 입력할 수 있습니다.");
const documentRevisionSchema = z.union([z.number().int().nonnegative(), uuid]);
export const createDocumentSchema = z
  .object({ id: uuid, title: documentTitleSchema.optional() })
  .strict();
export const renameDocumentSchema = z
  .object({ title: documentTitleSchema, expectedTitle: z.string().max(80) })
  .strict();
const saveSchema = z
  .object({
    ...documentSchema.shape,
    expectedRevision: documentRevisionSchema,
    operationId: uuid,
  })
  .strict();
const removeSchema = z
  .object({ expectedRevision: documentRevisionSchema })
  .strict();
const idsSchema = z
  .array(uuid)
  .min(1)
  .max(MAX_TASK_DOCUMENTS)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "같은 메모를 중복 지정할 수 없습니다.",
  );
const reorderSchema = z
  .object({ ids: idsSchema, expectedIds: idsSchema })
  .strict();
const scopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task"),
      taskId: uuid,
      documentId: documentIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("report"),
      reportId: uuid,
      taskId: uuid,
      documentId: documentIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("annual"),
      teamId: uuid,
      year: yearSchema,
      documentId: uuid.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reportMemo"),
      reportId: uuid,
      documentId: uuid.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("calendar"),
      entryId: z.string(),
      documentId: z.literal("main").optional(),
    })
    .strict(),
]);

// Ordinary document commands have no request, response, SQL or engine branches.
// Repositories authorize and commit versions, audit, pending operations and events
// together. Pure SQLite reads remain synchronous; image document saves prepare
// their Markdown outside the writer before committing synchronously.
export class DocumentBusinessService {
  constructor(repository, user, { documentEvents, refreshUser } = {}) {
    this.repository = repository;
    this.user = user;
    this.documentEvents = documentEvents;
    this.refreshUser = refreshUser;
  }
  list(scope, { content = false } = {}) {
    return this.repository.list(this.user, scopeSchema.parse(scope), {
      content,
    });
  }
  imageAccess(scope) {
    return this.repository.imageAccess(this.user, this.document(scope));
  }
  putImage(scope, bytes) {
    requireThat(
      bytes instanceof Uint8Array &&
        bytes.length > 0 &&
        bytes.length <= MAX_IMAGE_BYTES,
      400,
      "문서 이미지 파일을 확인하세요.",
    );
    return this.repository.putImage(this.user, this.document(scope), bytes);
  }
  readImage(url, { stream = false } = {}) {
    const match = DOCUMENT_IMAGE_PATTERN.exec(url);
    requireThat(
      match && isDocumentImage(url),
      400,
      "문서 이미지 주소를 확인하세요.",
    );
    return this.repository.readImage(this.user, match[1], url, { stream });
  }
  read(scope, options) {
    return this.repository.read(this.user, this.document(scope), options);
  }
  create(scope, body) {
    return this.write(
      "create",
      scopeSchema.parse(scope),
      createDocumentSchema.parse(body),
    );
  }
  rename(scope, body) {
    return this.write(
      "rename",
      this.document(scope),
      renameDocumentSchema.parse(body),
    );
  }
  save(scope, body) {
    const target = this.document(scope),
      request = saveSchema.parse(body);
    this.repository.validateRevision?.(target, request.expectedRevision);
    return this.write("save", target, request);
  }
  remove(scope, body) {
    const target = this.document(scope),
      request = removeSchema.parse(body);
    this.repository.validateRevision?.(target, request.expectedRevision);
    return this.write("remove", target, request);
  }
  reorder(scope, body) {
    const target = scopeSchema.parse(scope);
    requireThat(
      ["annual", "reportMemo"].includes(target.kind),
      400,
      "문서 순서를 변경할 수 없는 범위입니다.",
    );
    return this.write("reorder", target, reorderSchema.parse(body));
  }
  write(method, scope, body) {
    return withDocumentImageReferences(() => {
      const result = this.repository[method](this.user, scope, body, {
        clientId: this.clientId,
        refreshUser: this.refreshUser,
      });
      const events = this.documentEvents;
      // Optional process-local delivery port runs only after repository commit.
      // PostgreSQL's durable event row already belongs to that same transaction.
      if (!events || this.repository.documentEvents === events) return result;
      const deliver = (value) => {
        const collection = documentCollectionKey(scope);
        if (collection && method !== "save")
          events.invalidate(collection, this.clientId);
        if (method === "remove") events.notify(documentEventKey(scope));
        return method === "save"
          ? events.publish(documentEventKey(scope), value)
          : value;
      };
      return result?.then ? result.then(deliver) : deliver(result);
    });
  }
  readBatch(reportId, taskIds) {
    return this.repository.readBatch(
      this.user,
      uuid.parse(reportId),
      z.array(uuid).min(1).max(100).parse(taskIds),
    );
  }
  document(scope) {
    const target = scopeSchema.parse(scope);
    if (
      !target.documentId &&
      ["task", "report", "calendar"].includes(target.kind)
    )
      target.documentId = "main";
    requireThat(target.documentId, 400, "문서를 선택하세요.");
    return target;
  }
}

export function documentImageUrl(teamId, bytes) {
  return `/api/document-images/${teamId}/${createHash("sha256").update(bytes).digest("hex")}.webp`;
}

export function requireDocumentRevision(current, request, replay = false) {
  requireThat(
    replay || current.revision === request.expectedRevision,
    409,
    "다른 사용자가 문서를 수정했습니다. 입력은 보존되었습니다. 최신 문서를 확인한 뒤 다시 저장하세요.",
    { current },
  );
}
export function requireDocumentTitle(current, request) {
  requireThat(
    current.title === request.expectedTitle || current.title === request.title,
    409,
    "문서 이름이 변경되었습니다. 목록을 다시 불러와 주세요.",
  );
}
export function requireDocumentOrder(currentIds, request, documents) {
  const same = (a, b) =>
    a.length === b.length && a.every((id, index) => id === b[index]);
  const replay = same(currentIds, request.ids);
  requireThat(
    request.ids.length === currentIds.length &&
      new Set(request.ids).size === currentIds.length &&
      request.ids.every((id) => currentIds.includes(id)) &&
      (replay || same(currentIds, request.expectedIds)),
    409,
    "메모 목록이나 순서가 변경되었습니다. 최신 목록에서 다시 이동하세요.",
    { documents },
  );
  return replay;
}
export function nextDocumentTitle(documents, kind = "task") {
  const prefix = ["annual", "reportMemo", "memo"].includes(kind)
    ? "메모"
    : "문서";
  const titles = new Set(documents.map((doc) => doc.title));
  let number = 1;
  while (titles.has(`${prefix} ${number}`)) number++;
  return `${prefix} ${number}`;
}
export function blankDocument(id = DEFAULT_DOCUMENT_ID) {
  return {
    id,
    title: DEFAULT_DOCUMENT_TITLE,
    markdown: "",
    revision: 0,
    updatedAt: null,
  };
}
export function documentEventKey(scope) {
  const id = scope.documentId || "main";
  if (scope.kind === "task") return `task:${scope.taskId}:${id}`;
  if (scope.kind === "report")
    return `report-task:${scope.reportId}:${scope.taskId}:${id}`;
  if (scope.kind === "annual")
    return `annual_memos:${scope.teamId}:${scope.year}:${id}`;
  if (scope.kind === "reportMemo")
    return `report_memos:${scope.reportId}:${id}`;
  return `calendar:${scope.entryId}`;
}
export function documentCollectionKey(scope) {
  if (scope.kind === "task") return `list:/api/tasks/${scope.taskId}/documents`;
  if (scope.kind === "report")
    return `list:/api/reports/${scope.reportId}/tasks/${scope.taskId}/documents`;
  if (scope.kind === "annual")
    return `list:/api/teams/${scope.teamId}/years/${scope.year}/memos`;
  if (scope.kind === "reportMemo")
    return `list:/api/reports/${scope.reportId}/memos`;
  return null;
}
