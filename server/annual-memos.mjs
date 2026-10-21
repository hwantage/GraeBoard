import { createHash } from "node:crypto";
import { z } from "zod";
import { audit, now, transaction } from "./db.mjs";
import { canContribute } from "../shared/domain.js";
import {
  MAX_TASK_DOCUMENTS,
  hasDocumentContent,
} from "../shared/task-documents.js";
import { documentSchema, requireThat, yearSchema } from "./validation.mjs";
import {
  createDocumentSchema,
  renameDocumentSchema,
} from "./task-documents.mjs";
import {
  readDocumentVersion,
  storeDocumentVersion,
  pruneDocumentVersions,
} from "./document-storage.mjs";
import { validateDocumentImages } from "./document-images.mjs";

const saveSchema = z
  .object({
    ...documentSchema.shape,
    expectedRevision: z.number().int().nonnegative(),
    operationId: z.string().uuid(),
  })
  .strict();

export function installAnnualMemoRoutes(app, options) {
  const { db, teamAccess } = options;
  const annual = installMemoRoutes(app, {
    ...options,
    table: "annual_memos",
    base: "/api/teams/:teamId/years/:year/memos",
    scope(req) {
      const teamId = z.string().uuid().parse(req.params.teamId);
      const year = yearSchema.parse(req.params.year);
      teamAccess(req.user, teamId);
      return { teamId, year };
    },
  });
  const report = installMemoRoutes(app, {
    ...options,
    table: "report_memos",
    base: "/api/reports/:reportId/memos",
    scope(req) {
      const reportId = z.string().uuid().parse(req.params.reportId);
      const row = db
        .prepare("SELECT team_id,year FROM reports WHERE id=?")
        .get(reportId);
      requireThat(row, 404, "사본을 찾을 수 없습니다.");
      teamAccess(req.user, row.team_id);
      return { reportId, teamId: row.team_id, year: row.year };
    },
  });
  return {
    memoImageAccess: (req) =>
      (req.params.reportId ? report : annual).memoImageAccess(req),
  };
}

// Annual sheets and saved copies share editing, permissions and conflict checks.
// Memo metadata and references are relational; no memo edit rewrites the sheet BLOB.
function installMemoRoutes(
  app,
  { db, documentImagesDir, documentEvents, table, base, scope: resolveScope },
) {
  const isReport = table === "report_memos";
  const ownerColumns = isReport ? ["report_id"] : ["team_id", "year"];
  const where = ownerColumns.map((column) => `${column}=?`).join(" AND ");
  const memoWhere = ownerColumns.map((column) => `m.${column}=?`).join(" AND ");
  const ownerArgs = (context) =>
    isReport ? [context.reportId] : [context.teamId, context.year];
  function scope(req, write = false) {
    const context = resolveScope(req);
    if (write)
      requireThat(
        canContribute(req.user, context.teamId),
        403,
        "메모 편집 권한이 없습니다.",
      );
    return context;
  }
  function list(context) {
    return db
      .prepare(
        `SELECT id,title,revision,has_content AS hasContent,updated_at AS updatedAt FROM ${table} WHERE ${where} ORDER BY position,id`,
      )
      .all(...ownerArgs(context));
  }
  function row(req, context) {
    const id = z.string().uuid().parse(req.params.documentId);
    const memo = db
      .prepare(
        `SELECT m.*,v.document_id AS document_identity FROM ${table} m JOIN document_versions v ON v.id=m.version_id WHERE ${memoWhere} AND m.id=?`,
      )
      .get(...ownerArgs(context), id);
    requireThat(memo, 404, "메모를 찾을 수 없습니다.");
    return memo;
  }
  function memoAudit(req, context, action, target, before, after) {
    audit(
      db,
      req.user.id,
      context.teamId,
      isReport ? `report-${action}` : action,
      target,
      before,
      { ...after, ...(isReport ? { reportId: context.reportId } : {}) },
    );
  }
  function document(memo) {
    return {
      id: memo.id,
      title: memo.title,
      markdown: readDocumentVersion(db, memo.version_id).markdown,
      revision: memo.revision,
      updatedAt: memo.updated_at,
    };
  }
  const memoImageAccess = (req) => {
    const context = scope(req, true);
    row(req, context);
    return context.teamId;
  };
  app.get(`${base}/events`, (req, res) =>
    documentEvents.watch(req, res, `list:${req.path.slice(0, -7)}`, scope),
  );
  app.get(base, (req, res) => res.json({ documents: list(scope(req)) }));
  app.post(base, (req, res) => {
    const data = createDocumentSchema.parse(req.body);
    res.status(201).json(
      transaction(db, () => {
        const context = scope(req, true);
        const documents = list(context);
        if (!documents.some((doc) => doc.id === data.id)) {
          requireThat(
            documents.length < MAX_TASK_DOCUMENTS,
            400,
            `메모는 ${MAX_TASK_DOCUMENTS}개까지 추가할 수 있습니다.`,
          );
          const titles = new Set(documents.map((doc) => doc.title));
          let number = 1;
          while (titles.has(`메모 ${number}`)) number++;
          const position = db
            .prepare(
              `SELECT COALESCE(MAX(position),-1)+1 AS value FROM ${table} WHERE ${where}`,
            )
            .get(...ownerArgs(context)).value;
          const versionId = storeDocumentVersion(db, {
            teamId: context.teamId,
            documentId: `memo:${context.reportId || context.year}:${data.id}`,
            markdown: "",
            actorId: req.user.id,
          });
          db.prepare(
            `INSERT INTO ${table}(${isReport ? "report_id" : "team_id,year"},id,title,position,version_id,has_content,revision,updated_at,actor_id) VALUES(${isReport ? "?" : "?,?"},?,?,?,?,0,0,?,?)`,
          ).run(
            ...ownerArgs(context),
            data.id,
            data.title || `메모 ${number}`,
            position,
            versionId,
            now(),
            req.user.id,
          );
          memoAudit(req, context, "memo-create", data.id, undefined, {
            year: context.year,
          });
        }
        return { documents: list(context) };
      }),
    );
  });
  app.post(`${base}/reorder`, (req, res) => {
    const idsSchema = z
      .array(z.string().uuid())
      .min(1)
      .max(MAX_TASK_DOCUMENTS)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "같은 메모를 중복 지정할 수 없습니다.",
      );
    const data = z
      .object({ ids: idsSchema, expectedIds: idsSchema })
      .strict()
      .parse(req.body);
    res.json(
      transaction(db, () => {
        const context = scope(req, true);
        const documents = list(context);
        const currentIds = documents.map((doc) => doc.id);
        const sameMembers =
          data.ids.length === currentIds.length &&
          data.ids.every((id) => currentIds.includes(id));
        const replay = currentIds.join(":") === data.ids.join(":");
        requireThat(
          sameMembers &&
            (replay || currentIds.join(":") === data.expectedIds.join(":")),
          409,
          "메모 목록이나 순서가 변경되었습니다. 최신 목록에서 다시 이동하세요.",
          { documents },
        );
        if (!replay) {
          const put = db.prepare(
            `UPDATE ${table} SET position=? WHERE ${where} AND id=?`,
          );
          data.ids.forEach((id, index) =>
            put.run(index, ...ownerArgs(context), id),
          );
          memoAudit(
            req,
            context,
            "memo-reorder",
            String(context.year),
            { ids: currentIds },
            { ids: data.ids },
          );
        }
        return { documents: list(context) };
      }),
    );
  });
  const documentKey = (req) =>
    `${table}:${ownerArgs(scope(req)).join(":")}:${req.params.documentId}`;
  const readDocument = (req) => document(row(req, scope(req)));
  app.get(`${base}/:documentId/events`, (req, res) =>
    documentEvents.subscribe(req, res, documentKey(req), readDocument),
  );
  app.get(`${base}/:documentId`, (req, res) =>
    res.json(documentEvents.stamp(readDocument(req))),
  );
  app.patch(`${base}/:documentId`, (req, res) => {
    const data = renameDocumentSchema.parse(req.body);
    res.json(
      transaction(db, () => {
        const context = scope(req, true),
          memo = row(req, context);
        requireThat(
          memo.title === data.expectedTitle || memo.title === data.title,
          409,
          "문서 이름이 변경되었습니다. 목록을 다시 불러와 주세요.",
        );
        db.prepare(`UPDATE ${table} SET title=? WHERE ${where} AND id=?`).run(
          data.title,
          ...ownerArgs(context),
          memo.id,
        );
        return { documents: list(context) };
      }),
    );
  });
  app.put(`${base}/:documentId`, (req, res) => {
    const data = saveSchema.parse(req.body);
    const saved = transaction(db, () => {
      const context = scope(req, true),
        memo = row(req, context);
      const current = documentEvents.stamp(document(memo));
      const hash = createHash("sha256")
        .update(JSON.stringify(data))
        .digest("hex");
      const replay =
        memo.operation_id === data.operationId &&
        memo.actor_id === req.user.id &&
        memo.request_hash === hash;
      requireThat(
        replay || current.revision === data.expectedRevision,
        409,
        "다른 사용자가 문서를 수정했습니다. 입력은 보존되었습니다. 최신 문서를 확인한 뒤 다시 저장하세요.",
        { current },
      );
      if (!replay && current.markdown !== data.markdown) {
        validateDocumentImages(
          data.markdown,
          context.teamId,
          documentImagesDir,
        );
        const versionId = storeDocumentVersion(db, {
          teamId: context.teamId,
          documentId: memo.document_identity,
          markdown: data.markdown,
          actorId: req.user.id,
        });
        db.prepare(
          `UPDATE ${table} SET version_id=?,has_content=?,revision=revision+1,updated_at=?,actor_id=?,operation_id=?,request_hash=? WHERE ${where} AND id=?`,
        ).run(
          versionId,
          Number(hasDocumentContent(data.markdown)),
          now(),
          req.user.id,
          data.operationId,
          hash,
          ...ownerArgs(context),
          memo.id,
        );
        memoAudit(
          req,
          context,
          "memo",
          memo.id,
          { revision: memo.revision },
          { year: context.year, revision: memo.revision + 1 },
        );
        pruneDocumentVersions(db, context.teamId, [memo.version_id]);
      }
      return document(row(req, context));
    });
    res.json(documentEvents.publish(documentKey(req), saved));
  });
  app.delete(`${base}/:documentId`, (req, res) => {
    const data = z
      .object({ expectedRevision: z.number().int().nonnegative() })
      .strict()
      .parse(req.body);
    res.json(
      transaction(db, () => {
        const context = scope(req, true),
          memo = row(req, context);
        requireThat(
          memo.revision === data.expectedRevision,
          409,
          "문서가 변경되었습니다. 최신 문서를 확인한 뒤 삭제하세요.",
        );
        db.prepare(`DELETE FROM ${table} WHERE ${where} AND id=?`).run(
          ...ownerArgs(context),
          memo.id,
        );
        pruneDocumentVersions(db, context.teamId, [memo.version_id]);
        memoAudit(req, context, "memo-delete", memo.id, {
          year: context.year,
          title: memo.title,
        });
        return { documents: list(context) };
      }),
    );
  });
  return { memoImageAccess };
}
