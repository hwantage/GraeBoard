import { z } from "zod";
import {
  MAX_TASK_DOCUMENTS,
  DEFAULT_DOCUMENT_TITLE,
  MAX_DOCUMENT_TITLE_LENGTH,
  hasDocumentContent,
} from "../shared/task-documents.js";
import { documentSchema, yearSchema } from "../server/validation.mjs";
import { assert } from "./access.mjs";
import { R2ImageStore, convertImage } from "./images.mjs";
import { databaseFor } from "./data.mjs";
import { profileFor } from "./config.mjs";
import { authenticate } from "./control.mjs";
import { stamp, excludedYears } from "./tasks.mjs";

const docId = (value) =>
  value === "main" ? value : z.string().uuid().parse(value);
export async function documentScope(ctx, path, { write = false } = {}) {
  let m;
  if (
    (m = /^\/tasks\/([^/]+)\/(document|documents)(?:\/([^/]+))?$/.exec(path))
  ) {
    const { teamId, row } = await ctx.locate("task", m[1], { write });
    assert(!row.payload.deletedAt, 404, "업무를 찾을 수 없습니다.");
    return {
      teamId,
      prefix: ["task", m[1]],
      documentId: m[2] === "document" ? "main" : m[3],
      kind: "task",
    };
  }
  if (
    (m =
      /^\/reports\/([^/]+)\/tasks\/([^/]+)\/(document|documents)(?:\/([^/]+))?$/.exec(
        path,
      ))
  ) {
    const { teamId, row } = await ctx.locate("report", m[1], { write });
    assert(
      row.payload.data.tasks.some((t) => t.id === m[2]),
      404,
      "사본 업무를 찾을 수 없습니다.",
    );
    return {
      teamId,
      prefix: ["report", m[1], m[2]],
      documentId: m[3] === "document" ? "main" : m[4],
      kind: "report",
    };
  }
  if (
    (m = /^\/teams\/([^/]+)\/years\/([^/]+)\/memos(?:\/([^/]+))?$/.exec(path))
  ) {
    await ctx.team(m[1], { write });
    return {
      teamId: m[1],
      prefix: ["annual", String(yearSchema.parse(m[2]))],
      documentId: m[3],
      kind: "memo",
    };
  }
  if ((m = /^\/reports\/([^/]+)\/memos(?:\/([^/]+))?$/.exec(path))) {
    const { teamId } = await ctx.locate("report", m[1], { write });
    return {
      teamId,
      prefix: ["reportMemo", m[1]],
      documentId: m[2],
      kind: "memo",
    };
  }
  if ((m = /^\/calendar\/entries\/([^/]+)\/document$/.exec(path))) {
    const { teamId, row } = await ctx.locate("calendar", m[1]);
    assert(!row.payload.deletedAt, 404, "일정을 찾을 수 없습니다.");
    if (write)
      assert(
        row.payload.userId === null ||
          ctx.user.systemRole === "admin" ||
          ctx.user.teamRoles[teamId] === "lead" ||
          (row.payload.userId === ctx.user.id &&
            ctx.user.teamRoles[teamId] === "member"),
        403,
        "일정을 편집할 권한이 없습니다.",
      );
    return {
      teamId,
      prefix: ["calendar", m[1]],
      documentId: "main",
      kind: "calendar",
      allowViewer: row.payload.userId === null,
    };
  }
  return null;
}
const matching = (row, prefix) =>
  prefix.every((part, i) => row.key[i] === part) &&
  row.key.length === prefix.length + 1;
async function annualHidden(s, scope) {
  return (
    scope.prefix[0] === "annual" &&
    (await excludedYears(s)).has(Number(scope.prefix[1]))
  );
}
async function requireUploadDocument(s, scope) {
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
export async function documentList(s, scope, { content = false } = {}) {
  if (await annualHidden(s, scope)) return [];
  const rows = (await s.list("document"))
    .filter((r) => matching(r, scope.prefix))
    .sort(
      (a, b) =>
        a.payload.position - b.payload.position ||
        a.key.at(-1).localeCompare(b.key.at(-1)),
    );
  if (
    !rows.length &&
    ["task", "report"].includes(scope.kind) &&
    !(await s.list("document", { deleted: true })).some((r) =>
      matching(r, scope.prefix),
    )
  )
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
async function result(s, scope) {
  const documents = await documentList(s, scope);
  return {
    documents,
    documentCount: documents.length,
    hasDocument: documents.some((d) => d.hasContent),
  };
}
export async function documentRoutes(ctx, path, method, body, query) {
  const imageUpload = path.endsWith("/images");
  const base = imageUpload ? path.slice(0, -7) : path;
  const scope = await documentScope(ctx, base, { write: method !== "GET" });
  if (!scope) return undefined;
  const { teamId, prefix, documentId, kind } = scope,
    team = await ctx.team(teamId),
    profile = profileFor(ctx.env, team.profile_id, teamId),
    images = new R2ImageStore(ctx.env[profile.bucketBinding], teamId);
  if (imageUpload && method === "POST") {
    assert(
      documentId && documentId !== "reorder",
      404,
      "문서를 찾을 수 없습니다.",
    );
    await ctx.data(teamId, (s) => requireUploadDocument(s, scope));
    assert(ctx.env.IMAGES, 503, "Images binding을 설정하세요.");
    const leaseId = crypto.randomUUID(),
      db = databaseFor(ctx.env, profile);
    await ctx.data(
      teamId,
      (s) =>
        s.put(
          "uploadLease",
          [leaseId],
          { startedAt: new Date().toISOString(), actorId: ctx.user.id },
          { shared: false },
        ),
      { write: true, allowViewer: scope.allowViewer },
    );
    try {
      const form = await ctx.request.formData(),
        file = form.get("image"),
        converted = await convertImage(file, ctx.env.IMAGES);
      ctx.user = await authenticate(ctx.env, ctx.identity);
      ctx.teamCache.clear();
      const refreshed = await ctx.team(teamId);
      assert(
        refreshed.profile_id === profile.profileId,
        409,
        "팀 이미지 연결이 변경되었습니다.",
      );
      await documentScope(ctx, base, { write: true });
      await ctx.data(teamId, (s) => requireUploadDocument(s, scope));
      const url = `/api/document-images/${teamId}/${converted.hash}.webp`;
      await images.install(url, converted.bytes);
      return { url };
    } finally {
      await db
        .withTeamTransaction(teamId, (tx) =>
          tx.query(
            "DELETE FROM site_entities WHERE team_id=$1 AND entity='uploadLease' AND entity_key=$2",
            [teamId, JSON.stringify([leaseId])],
          ),
        )
        .catch(() => {});
    }
  }
  if (method === "PUT") documentSchema.parse({ markdown: body.markdown });
  if (body.markdown !== undefined) await images.validate(body.markdown);
  return ctx.data(
    teamId,
    async (s) => {
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
                content: query.get("content") === "1",
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
          allDocs = (await s.list("document", { deleted: true })).filter((r) =>
            matching(r, prefix),
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
            (d) => d.title === (kind === "memo" ? "메모 " : "문서 ") + number,
          )
        )
          number++;
        const title =
          body.title || `${kind === "memo" ? "메모" : "문서"} ${number}`;
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
        assert(
          Array.isArray(body.ids) &&
            new Set(body.ids).size === ids.length &&
            body.ids.every((id) => ids.includes(id)) &&
            JSON.stringify(body.expectedIds) === JSON.stringify(ids),
          409,
          "문서 목록이 변경되었습니다.",
        );
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
        assert(
          body.expectedRevision === current.revision,
          409,
          "다른 사용자가 문서를 수정했습니다. 입력은 보존되었습니다.",
          { current },
        );
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
                  await import("./calendar.mjs")
                ).entryView(s, await s.get("calendar", [prefix[1]])),
              }
            : {}),
        };
      }
      if (method === "PATCH") {
        assert(
          typeof body.title === "string" &&
            body.title.trim() &&
            body.title.length <= MAX_DOCUMENT_TITLE_LENGTH,
          400,
          "문서 이름을 확인하세요.",
        );
        assert(
          current.title === body.expectedTitle || current.title === body.title,
          409,
          "문서 이름이 변경되었습니다.",
        );
        await s.put("document", key, { ...payload, title: body.title.trim() });
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
