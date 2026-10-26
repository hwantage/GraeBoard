import { DocumentBrowserBusinessService } from "./storage/document-browser-service.mjs";
import { SqliteDocumentBrowserRepository } from "./storage/sqlite-document-browser.mjs";
export function installDocumentBrowserRoutes(app, options) {
  const repository =
    options.repository || new SqliteDocumentBrowserRepository(options);
  app.locals.documentBrowserRepository = repository;
  for (const kind of ["sources", "tasks", "task"])
    app.get(`/api/document-browser/${kind}`, (req, res, next) => {
      const selected =
        typeof repository === "function"
          ? repository(req.user, req)
          : repository;
      const result = new DocumentBrowserBusinessService(
        selected,
        req.user,
      ).query(kind, req.query);
      return result?.then
        ? result.then((value) => res.json(value), next)
        : res.json(result);
    });
}
