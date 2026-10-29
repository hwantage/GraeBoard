import { registerEventRoute } from "./event-streams.mjs";
import {
  documentEventKey,
  documentCollectionKey,
} from "./storage/document-service.mjs";
import { documentRouteScope } from "../shared/document-routes.js";

// Node document routes use SQLite permissions and retention. Body saves await
// image preparation before entering the synchronous write transaction.
export function installDocumentBusinessRoutes(
  app,
  { service, documentEvents },
) {
  app.locals.documentService = service;
  const business = (req) => {
    const value = service(req);
    value.clientId = req.get("X-Client-ID")?.slice(0, 64);
    return value;
  };
  const routes = [
    "/api/tasks/:id/documents",
    "/api/reports/:id/tasks/:taskId/documents",
    "/api/teams/:teamId/years/:year/memos",
    "/api/reports/:reportId/memos",
  ];
  const target = (req) => documentRouteScope(req.path.slice(4));
  const send = (
    result,
    res,
    next,
    { status = 200, stamp = false, scope } = {},
  ) => {
    const complete = (value) => {
      // Preserve the established body GET envelopes; SSE/save retain summaries.
      if (scope?.kind === "task") {
        const { hasDocument, documentCount, taskUpdatedAt, ...body } = value;
        value = body;
      }
      if (scope?.kind === "calendar") {
        const { entry, ...body } = value;
        value = body;
      }
      return res
        .status(status)
        .json(stamp ? documentEvents.stamp(value) : value);
    };
    return complete(result);
  };
  for (const base of routes) {
    registerEventRoute(app, `${base}/events`, (req, res) => {
      const scope = documentRouteScope(req.path.slice(4, -7));
      return documentEvents.watch(
        req,
        res,
        documentCollectionKey(scope),
        (request) => business(request).list(scope),
      );
    });
    app.get(base, (req, res, next) =>
      send(
        business(req).list(target(req), { content: req.query.content === "1" }),
        res,
        next,
      ),
    );
    app.post(base, (req, res, next) =>
      send(business(req).create(target(req), req.body), res, next, {
        status: 201,
      }),
    );
    if (base.endsWith("/memos"))
      app.post(`${base}/reorder`, (req, res, next) => {
        const scope = documentRouteScope(req.path.slice(4, -8));
        return send(business(req).reorder(scope, req.body), res, next);
      });
    app.patch(`${base}/:documentId`, (req, res, next) =>
      send(business(req).rename(target(req), req.body), res, next),
    );
    app.delete(`${base}/:documentId`, (req, res, next) =>
      send(business(req).remove(target(req), req.body), res, next),
    );
  }
  const bodies = [
    ...routes.map((base) => `${base}/:documentId`),
    "/api/tasks/:id/document",
    "/api/reports/:id/tasks/:taskId/document",
    "/api/calendar/entries/:id/document",
  ];
  for (const path of bodies) {
    app.get(path, (req, res, next) =>
      send(business(req).read(target(req)), res, next, {
        stamp: true,
        scope: target(req),
      }),
    );
    app.put(path, async (req, res, next) =>
      send(await business(req).save(target(req), req.body), res, next),
    );
    registerEventRoute(app, `${path}/events`, (req, res) => {
      const scope = documentRouteScope(req.path.slice(4, -7));
      return documentEvents.subscribe(
        req,
        res,
        documentEventKey(scope),
        (request) => business(request).read(scope, { summary: true }),
      );
    });
  }
  app.post("/api/reports/:id/documents/batch", (req, res, next) =>
    send(business(req).readBatch(req.params.id, req.body.taskIds), res, next),
  );
}
