import express from "express";
import { SlideFileService } from "../storage/slides/slide-file-service.mjs";
import {
  MAX_SLIDE_FILE_BYTES,
  MAX_SLIDE_SHARE_BYTES,
  slideDownloadName,
} from "../../shared/slides/slide-file-rules.js";
import { requireThat } from "../../shared/validation.js";

// Node routes for team slide files. Bytes travel as `application/octet-stream`
// in both directions; metadata is JSON.
export function installSlideFileRoutes(
  app,
  { repository, teamAccess, onChange = () => {} },
) {
  app.locals.slideFileRepository = repository;
  const service = (req) =>
    new SlideFileService(repository, req.user, { teamAccess });
  const bytes = express.raw({
    type: "application/octet-stream",
    limit: MAX_SLIDE_FILE_BYTES,
  });
  const text = express.text({
    type: "text/plain",
    limit: MAX_SLIDE_SHARE_BYTES,
  });
  const body = (req) => {
    requireThat(
      Buffer.isBuffer(req.body),
      415,
      "자료 파일은 application/octet-stream으로 보내야 합니다.",
    );
    return new Uint8Array(
      req.body.buffer,
      req.body.byteOffset,
      req.body.length,
    );
  };
  const title = (req) => {
    try {
      return decodeURIComponent(req.get("X-Slide-Title") || "");
    } catch {
      return "";
    }
  };
  const base = "/api/teams/:teamId/slides";
  // A stored change is offered to the other site shortly afterwards.
  const route = (handler) => (req, res, next) =>
    Promise.resolve(handler(req, res))
      .then(() => {
        if (req.method !== "GET" && req.path.includes("/slides"))
          onChange(req.params.teamId);
      })
      .catch(next);

  app.get(
    base,
    route(async (req, res) =>
      res.json(await service(req).list(req.params.teamId)),
    ),
  );
  app.post(
    base,
    bytes,
    route(async (req, res) =>
      res.status(201).json(
        await service(req).create(req.params.teamId, {
          title: title(req),
          bytes: body(req),
          requestId: req.get("X-Slide-Request-Id"),
        }),
      ),
    ),
  );
  app.get(
    `${base}/:fileId`,
    route(async (req, res) =>
      res.json(await service(req).get(req.params.teamId, req.params.fileId)),
    ),
  );
  app.get(
    `${base}/:fileId/content`,
    route(async (req, res) => {
      const stored = await service(req).read(
        req.params.teamId,
        req.params.fileId,
      );
      res
        .set({
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(slideDownloadName(stored.file.title))}`,
          "X-Content-Type-Options": "nosniff",
          "X-Slide-Revision": String(stored.file.revision),
          "X-Slide-Title": encodeURIComponent(stored.file.title),
          "X-Slide-Content-Sha256": stored.file.contentHash,
        })
        .end(Buffer.from(stored.bytes));
    }),
  );
  app.put(
    `${base}/:fileId/content`,
    bytes,
    route(async (req, res) =>
      res.json(
        await service(req).save(req.params.teamId, req.params.fileId, {
          baseRevision: Number(req.get("X-Slide-Base-Revision")),
          bytes: body(req),
          requestId: req.get("X-Slide-Request-Id"),
        }),
      ),
    ),
  );
  app.patch(
    `${base}/:fileId`,
    route(async (req, res) =>
      res.json(
        await service(req).rename(
          req.params.teamId,
          req.params.fileId,
          req.body?.title,
        ),
      ),
    ),
  );
  app.post(
    `${base}/:fileId/copy`,
    route(async (req, res) =>
      res.status(201).json(
        await service(req).copy(req.params.teamId, req.params.fileId, {
          title: req.body?.title,
          requestId: req.body?.requestId,
        }),
      ),
    ),
  );
  app.delete(
    `${base}/:fileId`,
    route(async (req, res) => {
      await service(req).remove(req.params.teamId, req.params.fileId);
      res.json({});
    }),
  );

  const shares = "/api/teams/:teamId/slide-shares";
  app.post(
    shares,
    text,
    route(async (req, res) =>
      res
        .status(201)
        .json(await service(req).createShare(req.params.teamId, req.body)),
    ),
  );
  app.get(
    `${shares}/:shareId`,
    route(async (req, res) =>
      res.json({
        body: await service(req).readShare(
          req.params.teamId,
          req.params.shareId,
        ),
      }),
    ),
  );
}
