import { BROWSER_ROUTES } from "../shared/business-routes.js";
import { DocumentBrowserBusinessService } from "./storage/document-browser-service.mjs";
import { SqliteDocumentBrowserRepository } from "./storage/sqlite-document-browser.mjs";
export function installDocumentBrowserRoutes(app, options) {
  const repository = new SqliteDocumentBrowserRepository(options);
  app.locals.documentBrowserRepository = repository;
  for (const { name: kind, path } of BROWSER_ROUTES)
    app.get("/api" + path, (req, res, next) => {
      const selected = repository;
      const result = new DocumentBrowserBusinessService(
        selected,
        req.user,
      ).query(kind, req.query);
      return res.json(result);
    });
}
