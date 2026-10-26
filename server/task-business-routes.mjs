// Keep the HTTP envelopes while selecting a server-configured ordinary storage repository.
export function installTaskBusinessRoutes(app, { service }) {
  const send = (
    value,
    res,
    next,
    { status = 200, transform = (x) => x } = {},
  ) =>
    value?.then
      ? value.then((data) => res.status(status).json(transform(data)), next)
      : res.status(status).json(transform(value));
  app.post("/api/tasks", (req, res, next) =>
    send(service(req).create(req.body), res, next, { status: 201 }),
  );
  app.patch("/api/tasks/:id", (req, res, next) =>
    send(service(req).update(req.params.id, req.body), res, next),
  );
  app.post("/api/tasks/reorder", (req, res, next) =>
    send(service(req).reorder(req.body), res, next),
  );
  app.post("/api/tasks/delete", (req, res, next) =>
    send(service(req).remove(req.body), res, next),
  );
  app.post("/api/tasks/restore", (req, res, next) =>
    send(service(req).restore(req.body), res, next),
  );
  app.delete("/api/tasks/:id", (req, res, next) =>
    send(service(req).removeOne(req.params.id, req.body), res, next, {
      transform: (result) => ({
        ok: true,
        updatedAt: result.updatedAt[req.params.id],
      }),
    }),
  );
  app.post("/api/tasks/:id/restore", (req, res, next) =>
    send(service(req).restoreOne(req.params.id, req.body), res, next, {
      transform: (result) => ({ task: result.tasks[0] }),
    }),
  );
  app.get("/api/views", (req, res, next) =>
    send(service(req).readViews(req.query), res, next),
  );
  app.put("/api/views", (req, res, next) =>
    send(service(req).saveView(req.body), res, next),
  );
}
