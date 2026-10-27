import { assert } from "./access.mjs";
import { R2ImageStore, convertImage } from "./images.mjs";
import { databaseFor } from "./data.mjs";
import { profileFor } from "./config.mjs";
import { authenticate } from "./control.mjs";
import { documentRouteScope } from "../shared/document-routes.js";
import { DocumentBusinessService } from "../server/storage/document-service.mjs";
import { PostgresDocumentRepository } from "../server/storage/postgres-documents.mjs";
export {
  documentView,
  documentList,
} from "../server/storage/postgres-documents.mjs";

export async function documentScope(ctx, path, options) {
  const target = documentRouteScope(path);
  return target
    ? new PostgresDocumentRepository({ context: ctx }).resolve(
        ctx.user,
        target,
        options,
      )
    : null;
}
export async function documentRoutes(ctx, path, method, body, query) {
  const imageUpload = path.endsWith("/images"),
    base = imageUpload ? path.slice(0, -7) : path;
  const target = documentRouteScope(base);
  if (!target) return undefined;
  const repository = new PostgresDocumentRepository({ context: ctx });
  if (!imageUpload) {
    const service = new DocumentBusinessService(repository, ctx.user);
    if (target.documentId === "reorder" && method === "POST") {
      delete target.documentId;
      return service.reorder(target, body);
    }
    if (method === "GET")
      return target.documentId
        ? service.read(target)
        : service.list(target, { content: query.get("content") === "1" });
    if (method === "POST" && !target.documentId)
      return service.create(target, body);
    if (method === "PUT") return service.save(target, body);
    if (method === "PATCH") return service.rename(target, body);
    if (method === "DELETE") return service.remove(target, body);
    throw Object.assign(new Error("지원하지 않는 문서 요청입니다."), {
      status: 400,
    });
  }
  const scope = await repository.resolve(ctx.user, target, {
    write: method !== "GET",
  });
  const { teamId, documentId } = scope,
    team = await ctx.team(teamId),
    profile = profileFor(ctx.env, team.profile_id, teamId),
    images = new R2ImageStore(ctx.env[profile.bucketBinding], teamId);
  if (imageUpload && method === "POST") {
    assert(
      documentId && documentId !== "reorder",
      404,
      "문서를 찾을 수 없습니다.",
    );
    await new DocumentBusinessService(repository, ctx.user).imageAccess(target);
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
      ctx.user = await authenticate(ctx.env, ctx.identity, ctx.request);
      ctx.teamCache.clear();
      const refreshed = await ctx.team(teamId);
      assert(
        refreshed.profile_id === profile.profileId,
        409,
        "팀 이미지 연결이 변경되었습니다.",
      );
      await documentScope(ctx, base, { write: true });
      await new DocumentBusinessService(repository, ctx.user).imageAccess(
        target,
      );
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
  return undefined;
}
