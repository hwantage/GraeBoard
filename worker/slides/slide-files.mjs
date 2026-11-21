import { SlideFileService } from "../../server/storage/slides/slide-file-service.mjs";
import { PostgresSlideFileRepository } from "../storage/slides/postgres-slide-files.mjs";
import { databaseFor } from "../storage/data.mjs";
import { syncTeamSlides } from "../sync/sync-slides.mjs";
import { slideDownloadName } from "../../shared/slides/slide-file-rules.js";
import { assert } from "../control/access.mjs";

const security = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
};

// External routes for team slide files: the same service and API as the
// internal site, over PostgreSQL metadata and R2 bytes.
export async function slideRoutes(ctx, path, method, body) {
  const match =
    /^\/teams\/([^/]+)\/(slides|slide-shares)(?:\/([^/]+))?(?:\/(content|copy|thumbnail))?$/.exec(
      path,
    );
  if (!match) return undefined;
  const [, teamId, kind, id, action] = match;
  // Team membership and the active team are checked before the store opens.
  const team = await ctx.team(teamId);
  const profile = await ctx.profile(team.id);
  const afterChange = async (write) => {
    const result = await write;
    if (profile.repository)
      ctx.execution?.waitUntil(
        syncTeamSlides(ctx.env, profile).catch(() => {}),
      );
    return result;
  };
  const pool = databaseFor(ctx.env, profile).pool;
  const service = new SlideFileService(
    new PostgresSlideFileRepository({
      pool,
      bucket: ctx.env[profile.bucketBinding],
      teamId,
    }),
    ctx.user,
    {
      teamAccess: (_user, target) => ctx.team(target),
      thumbnailScope: ctx.env[profile.databaseBinding],
    },
  );
  const header = (name) => ctx.request.headers.get(name);
  const bytes = async () => {
    assert(
      header("content-type")?.startsWith("application/octet-stream"),
      415,
      "자료 파일은 application/octet-stream으로 보내야 합니다.",
    );
    return new Uint8Array(await ctx.request.arrayBuffer());
  };
  const title = (name = "x-slide-title") => {
    const value = header(name);
    if (value == null) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return "";
    }
  };
  const created = (value) =>
    new Response(JSON.stringify(value), {
      status: 201,
      headers: {
        ...security,
        "Content-Type": "application/json; charset=utf-8",
      },
    });

  if (kind === "slide-shares") {
    if (!id && method === "POST")
      return created(
        await service.createShare(teamId, await ctx.request.text()),
      );
    if (id && !action && method === "GET")
      return { body: await service.readShare(teamId, id) };
    return undefined;
  }
  if (!id) {
    if (method === "GET") return service.list(teamId);
    if (method === "POST")
      return created(
        await afterChange(
          service.create(teamId, {
            title: title(),
            bytes: await bytes(),
            requestId: header("x-slide-request-id"),
          }),
        ),
      );
    return undefined;
  }
  if (action === "thumbnail") {
    if (method === "GET") return service.thumbnail(teamId, id);
    if (method === "PUT") return service.putThumbnail(teamId, id, body ?? {});
    return undefined;
  }
  if (action === "content") {
    if (method === "GET") {
      const stored = await service.read(teamId, id);
      return new Response(stored.bytes, {
        headers: {
          ...security,
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(slideDownloadName(stored.file.title))}`,
          "X-Slide-Revision": String(stored.file.revision),
          "X-Slide-Title": encodeURIComponent(stored.file.title),
          "X-Slide-Content-Sha256": stored.file.contentHash,
        },
      });
    }
    if (method === "PUT")
      return afterChange(
        service.save(teamId, id, {
          title: title(),
          baseTitle: title("x-slide-base-title"),
          baseRevision: Number(header("x-slide-base-revision")),
          bytes: await bytes(),
          requestId: header("x-slide-request-id"),
        }),
      );
    return undefined;
  }
  if (action === "copy" && method === "POST")
    return created(
      await afterChange(
        service.copy(teamId, id, {
          title: body.title,
          requestId: body.requestId,
        }),
      ),
    );
  if (action) return undefined;
  if (method === "GET") return service.get(teamId, id);
  if (method === "PATCH")
    return afterChange(service.rename(teamId, id, body.title));
  if (method === "DELETE") {
    await afterChange(service.remove(teamId, id));
    return {};
  }
  return undefined;
}
