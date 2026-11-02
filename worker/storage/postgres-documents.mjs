import { z } from "zod";
import {
  MAX_TASK_DOCUMENTS,
  DEFAULT_DOCUMENT_TITLE,
  MAX_DOCUMENT_TITLE_LENGTH,
  hasDocumentContent,
} from "../../shared/task-documents.js";
import { assert } from "../access.mjs";
import { imageReferences } from "../images.mjs";
import { stamp, excludedYears } from "../tasks.mjs";
import { databaseFor } from "../data.mjs";
import {
  nextDocumentTitle,
  requireDocumentRevision,
  requireDocumentTitle,
  requireDocumentOrder,
  documentImageUrl,
} from "../../server/storage/document-service.mjs";
const docId = (value) =>
  value === "main" ? value : z.string().uuid().parse(value);
const matching = (row, prefix) =>
  prefix.every((part, i) => row.key[i] === part) &&
  row.key.length === prefix.length + 1;
async function annualHidden(s, scope) {
  return (
    scope.prefix[0] === "annual" &&
    (await excludedYears(s)).has(Number(scope.prefix[1]))
  );
}
export async function requireUploadDocument(s, scope) {
  if (scope.kind !== "annual") {
    const parent = await s.get(
      scope.kind === "reportMemo" ? "report" : scope.kind,
      [scope.prefix[1]],
    );
    assert(
      parent && !parent.deleted && !parent.payload.deletedAt,
      404,
      "문서의 원본 자료를 찾을 수 없습니다.",
    );
    if (scope.kind === "report")
      assert(
        parent.payload.data.tasks.some((task) => task.id === scope.prefix[2]),
        404,
        "사본 업무를 찾을 수 없습니다.",
      );
  }
  assert(
    !(await annualHidden(s, scope)),
    409,
    "이 사이트에서 정리한 연도입니다. 먼저 복원하세요.",
  );
  const row = await s.get("document", [
    ...scope.prefix,
    docId(scope.documentId),
  ]);
  assert(
    !row?.deleted &&
      (row ||
        (scope.documentId === "main" &&
          ["task", "report", "calendar"].includes(scope.kind))),
    404,
    "문서를 찾을 수 없습니다. 먼저 복원하세요.",
  );
}

export function documentView(row, id = "main") {
  return {
    id,
    title: row?.payload.title || DEFAULT_DOCUMENT_TITLE,
    markdown: row?.payload.markdown || "",
    revision: row?.revision || 0,
    updatedAt: row ? stamp(row) : null,
    sync: { session: "postgres", sequence: row?.revision || 0 },
  };
}
// Keys of the live (or deleted) documents under a key prefix, without reading
// their markdown. A session that already holds the whole list answers from it.
export async function documentKeysUnder(s, parent, { deleted = false } = {}) {
  const prefix = JSON.stringify(parent).slice(0, -1) + ",";
  if (s.lists.has("document"))
    return (await s.list("document", { deleted: true }))
      .filter(
        (row) =>
          row.deleted === deleted && JSON.stringify(row.key).startsWith(prefix),
      )
      .map((row) => row.key);
  return (
    await s.tx.query(
      "SELECT entity_key FROM site_entities WHERE team_id=$1 AND entity='document' AND deleted=$2 AND left(entity_key,length($3))=$3 ORDER BY entity_key",
      [s.teamId, deleted ? 1 : 0, prefix],
    )
  ).rows.map((row) => JSON.parse(row.entity_key));
}
// One owner's list from its live rows. A task or report task that never had a
// document shows the empty main document; `used` says whether a deleted one
// exists and is asked only when no live row does.
// content "stored": the stored documents alone, as {id, title, markdown}. That
// is what the internal site answers for a task's or copy row's documents with
// their content, and all a pasted or restored row may carry (copiedRowSchema).
async function listView(rows, kind, used, content) {
  rows.sort(
    (a, b) =>
      a.payload.position - b.payload.position ||
      a.key.at(-1).localeCompare(b.key.at(-1)),
  );
  if (content === "stored")
    return rows.map((r) => ({
      id: r.key.at(-1),
      title: r.payload.title,
      markdown: r.payload.markdown,
    }));
  if (!rows.length && ["task", "report"].includes(kind) && !(await used()))
    return [
      {
        id: "main",
        title: DEFAULT_DOCUMENT_TITLE,
        revision: 0,
        hasContent: false,
        ...(content ? { markdown: "" } : {}),
      },
    ];
  return rows.map((r) => ({
    id: r.key.at(-1),
    title: r.payload.title,
    revision: r.revision,
    hasContent: hasDocumentContent(r.payload.markdown),
    updatedAt: stamp(r),
    ...(content ? { markdown: r.payload.markdown } : {}),
  }));
}
// Reads only the owner's rows by key prefix, as SQLite reads one owner's table
// rows, instead of every document of the team.
export async function documentList(s, scope, { content = false } = {}) {
  if (await annualHidden(s, scope)) return [];
  const rows = (await s.listChildren("document", scope.prefix)).filter((r) =>
    matching(r, scope.prefix),
  );
  return listView(
    rows,
    scope.kind,
    async () =>
      (await documentKeysUnder(s, scope.prefix, { deleted: true })).some(
        (key) => matching({ key }, scope.prefix),
      ),
    content,
  );
}
// documentList for every owner directly under `parent` (each task of a report),
// read with one query and grouped once instead of one read per owner. Owners
// are tasks or report tasks, never annual memos. `rows` are the live rows read.
export async function documentListsUnder(s, parent, kind) {
  const rows = await s.listChildren("document", parent),
    owners = new Map(),
    ownerOf = (key) =>
      key.length === parent.length + 2 ? key[parent.length] : undefined;
  for (const row of rows) {
    const owner = ownerOf(row.key);
    if (owner === undefined) continue;
    if (!owners.has(owner)) owners.set(owner, []);
    owners.get(owner).push(row);
  }
  let deleted;
  const used = async (owner) => {
    deleted ||= documentKeysUnder(s, parent, { deleted: true }).then(
      (keys) => new Set(keys.map(ownerOf)),
    );
    return (await deleted).has(owner);
  };
  return {
    rows,
    list: (owner, { content = false } = {}) =>
      listView(
        [...(owners.get(owner) || [])],
        kind,
        () => used(owner),
        content,
      ),
  };
}
async function result(s, scope) {
  const documents = await documentList(s, scope);
  return {
    documents,
    documentCount: documents.length,
    hasDocument: documents.some((d) => d.hasContent),
  };
}

// Same document commands as SQLite, on the existing PostgreSQL DataSession.
// Permission resolution and all writes stay on this backend, including Node injection.
export class PostgresDocumentRepository {
  constructor({ context }) {
    this.context = context;
  }
  async resolve(user, target, { write = false } = {}) {
    const ctx = this.context;
    assert(user.id === ctx.user.id, 403, "사용자 저장소 범위를 확인하세요.");
    const { kind, documentId } = target;
    if (kind === "task") {
      const { teamId, row } = await ctx.locate("task", target.taskId, {
        write,
      });
      assert(!row.payload.deletedAt, 404, "업무를 찾을 수 없습니다.");
      return { teamId, prefix: ["task", target.taskId], documentId, kind };
    }
    if (["report", "reportMemo"].includes(kind)) {
      const { teamId, row } = await ctx.locate("report", target.reportId, {
        write,
      });
      if (kind === "report")
        assert(
          row.payload.data.tasks.some((t) => t.id === target.taskId),
          404,
          "사본 업무를 찾을 수 없습니다.",
        );
      return {
        teamId,
        prefix:
          kind === "report"
            ? ["report", target.reportId, target.taskId]
            : ["reportMemo", target.reportId],
        documentId,
        kind,
      };
    }
    if (kind === "annual") {
      await ctx.team(target.teamId, { write });
      return {
        teamId: target.teamId,
        prefix: ["annual", String(target.year)],
        documentId,
        kind,
      };
    }
    const { teamId, row } = await ctx.locate("calendar", target.entryId);
    assert(!row.payload.deletedAt, 404, "일정을 찾을 수 없습니다.");
    if (write)
      assert(
        row.payload.userId === null ||
          user.systemRole === "admin" ||
          user.teamRoles[teamId] === "lead" ||
          (row.payload.userId === user.id &&
            user.teamRoles[teamId] === "member"),
        403,
        "일정을 편집할 권한이 없습니다.",
      );
    return {
      teamId,
      prefix: ["calendar", target.entryId],
      documentId: "main",
      kind,
      allowViewer: row.payload.userId === null,
    };
  }
  async imageAccess(user, target) {
    const scope = await this.resolve(user, target, { write: true });
    await this.context.data(scope.teamId, (s) =>
      requireUploadDocument(s, scope),
    );
    return scope.teamId;
  }
  async putImage(user, target, bytes) {
    const ctx = this.context,
      scope = await this.resolve(user, target, { write: true }),
      profile = await ctx.profile(scope.teamId),
      images = await ctx.imageStore(scope.teamId),
      leaseId = crypto.randomUUID(),
      url = documentImageUrl(scope.teamId, bytes),
      database = databaseFor(ctx.env, profile);
    await ctx.data(
      scope.teamId,
      async (s) => {
        await requireUploadDocument(s, scope);
        await s.put(
          "uploadLease",
          [leaseId],
          { startedAt: new Date().toISOString(), actorId: user.id },
          { shared: false },
        );
      },
      { write: true, allowViewer: scope.allowViewer },
    );
    try {
      await images.install(url, bytes);
      return { url };
    } finally {
      await database
        .withTeamTransaction(scope.teamId, (tx) =>
          tx.query(
            "DELETE FROM site_entities WHERE team_id=$1 AND entity='uploadLease' AND entity_key=$2",
            [scope.teamId, JSON.stringify([leaseId])],
          ),
        )
        .catch(() => {});
    }
  }
  async readImage(user, teamId, url, { stream = false } = {}) {
    assert(
      user.id === this.context.user.id,
      403,
      "사용자 저장소 범위를 확인하세요.",
    );
    await this.context.team(teamId);
    const images = await this.context.imageStore(teamId),
      object = await images.getObject(url);
    assert(object, 404, "문서 이미지를 찾을 수 없습니다.");
    return stream ? object.body : new Uint8Array(await object.arrayBuffer());
  }
  list(user, scope, options = {}) {
    return this.execute(user, scope, "GET", {}, options);
  }
  read(user, scope) {
    return this.execute(user, scope, "GET");
  }
  create(user, scope, body) {
    return this.execute(user, scope, "POST", body);
  }
  rename(user, scope, body) {
    return this.execute(user, scope, "PATCH", body);
  }
  save(user, scope, body) {
    return this.execute(user, scope, "PUT", body);
  }
  remove(user, scope, body) {
    return this.execute(user, scope, "DELETE", body);
  }
  reorder(user, scope, body) {
    return this.execute(
      user,
      { ...scope, documentId: "reorder" },
      "POST",
      body,
    );
  }
  async readBatch(user, reportId, taskIds) {
    const tasks = [];
    let bytes = 0;
    for (const taskId of taskIds) {
      const { documents } = await this.list(
        user,
        { kind: "report", reportId, taskId },
        { content: true },
      );
      const size = documents.reduce(
        (sum, doc) => sum + new TextEncoder().encode(doc.markdown).length,
        0,
      );
      if (tasks.length && bytes + size > 8 * 1024 * 1024) break;
      tasks.push({ id: taskId, documents });
      bytes += size;
    }
    return { tasks };
  }
  async execute(user, target, method, body = {}, { content = false } = {}) {
    const ctx = this.context,
      scope = await this.resolve(user, target, { write: method !== "GET" });
    const { teamId, prefix, documentId, kind } = scope;
    // Only this team's images; one whose file is missing is shown as missing
    // in the document, never a reason to refuse saving it.
    if (body.markdown !== undefined) imageReferences(body.markdown, teamId);
    return ctx.data(
      teamId,
      async (s) => {
        if (kind !== "annual") {
          const parentKind = kind === "reportMemo" ? "report" : kind;
          const parent = await s.get(parentKind, [prefix[1]]);
          assert(
            parent && !parent.deleted && !parent.payload.deletedAt,
            404,
            "문서의 원본 자료를 찾을 수 없습니다.",
          );
          if (kind === "report")
            assert(
              parent.payload.data.tasks.some((t) => t.id === prefix[2]),
              404,
              "사본 업무를 찾을 수 없습니다.",
            );
        }
        if (await annualHidden(s, scope)) {
          if (method === "GET" && !documentId) return { documents: [] };
          assert(
            false,
            method === "GET" ? 404 : 409,
            "이 사이트에서 정리한 연도입니다. 먼저 복원하세요.",
          );
        }
        const key =
            documentId && documentId !== "reorder"
              ? [...prefix, docId(documentId)]
              : null,
          row = key ? await s.get("document", key) : null;
        assert(
          !row?.deleted,
          404,
          "이 사이트에서 제외되거나 삭제된 문서입니다. 먼저 복원하세요.",
        );
        const virtual =
          key &&
          documentId === "main" &&
          ["task", "report", "calendar"].includes(kind);
        if (method === "GET")
          return !key
            ? {
                documents: await documentList(s, scope, {
                  content:
                    content && ["task", "report"].includes(kind)
                      ? "stored"
                      : content,
                }),
              }
            : (assert(row || virtual, 404, "문서를 찾을 수 없습니다."),
              documentView(row, documentId));
        if (!key && method === "POST" && documentId !== "reorder") {
          const id = docId(body.id);
          assert(
            !(await s.get("document", [...prefix, id]))?.deleted,
            409,
            "이 사이트에서 제외되거나 삭제된 문서입니다. 먼저 복원하세요.",
          );
          const docs = await documentList(s, scope),
            allDocs = (await s.list("document", { deleted: true })).filter(
              (r) => matching(r, prefix),
            );
          if (docs.some((d) => d.id === id)) return result(s, scope);
          assert(
            docs.length < MAX_TASK_DOCUMENTS,
            400,
            `문서는 ${MAX_TASK_DOCUMENTS}개까지 추가할 수 있습니다.`,
          );
          if (["task", "report"].includes(kind) && !allDocs.length)
            await s.put("document", [...prefix, "main"], {
              title: DEFAULT_DOCUMENT_TITLE,
              position: 0,
              markdown: "",
            });
          let number = 1;
          while (
            docs.some(
              (d) =>
                d.title ===
                (["annual", "reportMemo"].includes(kind) ? "메모 " : "문서 ") +
                  number,
            )
          )
            number++;
          const title = body.title || nextDocumentTitle(docs, kind);
          assert(
            typeof title === "string" &&
              title.trim() &&
              title.length <= MAX_DOCUMENT_TITLE_LENGTH,
            400,
            "문서 이름을 확인하세요.",
          );
          await s.put("document", [...prefix, id], {
            title: title.trim(),
            position:
              Math.max(
                -1,
                ...allDocs.map((d) => d.payload.position),
                ...(["task", "report"].includes(kind) ? [0] : []),
              ) + 1,
            markdown: "",
          });
          if (kind === "task") await s.touch("task", [prefix[1]]);
          return result(s, scope);
        }
        if (documentId === "reorder" && method === "POST") {
          const docs = await documentList(s, scope),
            ids = docs.map((d) => d.id);
          if (requireDocumentOrder(ids, body, docs)) return result(s, scope);
          const full = (await s.list("document", { deleted: true }))
              .filter((row) => matching(row, prefix))
              .sort(
                (a, b) =>
                  a.payload.position - b.payload.position ||
                  a.key.at(-1).localeCompare(b.key.at(-1)),
              ),
            ordered = body.ids[Symbol.iterator]();
          for (const [position, slot] of full.entries()) {
            if (slot.deleted) continue;
            const old = await s.get("document", [
              ...prefix,
              ordered.next().value,
            ]);
            await s.put("document", old.key, { ...old.payload, position });
          }
          return result(s, scope);
        }
        assert(key && (row || virtual), 404, "문서를 찾을 수 없습니다.");
        const current = documentView(row, documentId),
          payload = row?.payload || {
            title: DEFAULT_DOCUMENT_TITLE,
            position: 0,
            markdown: "",
          };
        if (method === "PUT") {
          requireDocumentRevision(current, body);
          assert(
            typeof body.operationId === "string",
            400,
            "저장 요청 ID가 필요합니다.",
          );
          const saved = await s.put("document", key, {
            ...payload,
            markdown: body.markdown,
          });
          if (kind === "task") await s.touch("task", [prefix[1]]);
          if (kind === "calendar") await s.touch("calendar", [prefix[1]]);
          return {
            ...documentView(saved, documentId),
            ...(await result(s, scope)),
            ...(kind === "calendar"
              ? {
                  entry: await (
                    await import("../calendar.mjs")
                  ).entryView(s, await s.get("calendar", [prefix[1]])),
                }
              : {}),
          };
        }
        if (method === "PATCH") {
          requireDocumentTitle(current, body);
          assert(
            typeof body.title === "string" &&
              body.title.trim() &&
              body.title.length <= MAX_DOCUMENT_TITLE_LENGTH,
            400,
            "문서 이름을 확인하세요.",
          );
          assert(
            current.title === body.expectedTitle ||
              current.title === body.title,
            409,
            "문서 이름이 변경되었습니다.",
          );
          await s.put("document", key, {
            ...payload,
            title: body.title.trim(),
          });
          return result(s, scope);
        }
        if (method === "DELETE") {
          assert(
            body.expectedRevision === current.revision,
            409,
            "문서가 변경되었습니다.",
          );
          if (row) await s.put("document", key, payload, { deleted: true });
          return result(s, scope);
        }
        throw Object.assign(new Error("지원하지 않는 문서 요청입니다."), {
          status: 400,
        });
      },
      {
        write: method !== "GET",
        body,
        allowViewer: scope.allowViewer,
        action: "document",
      },
    );
  }
}
