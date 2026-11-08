import { registerEventRoute } from "./event-streams.mjs";
import { hasDocumentContent } from "../shared/documents/task-documents.js";
import { requireThat } from "../shared/validation.js";

// Publish invalidations only after successful mutations. Bodies stay on their
// existing authorized GET routes; cells retain their compact delta stream.
export function installResourceEvents(
  app,
  { db, documentEvents, teamAccess, taskRequestsHandled },
) {
  registerEventRoute(app, "/api/teams/:id/events", (req, res) =>
    documentEvents.watch(req, res, `team:${req.params.id}`, (request) =>
      teamAccess(request.user, request.params.id),
    ),
  );
  registerEventRoute(app, "/api/sheet-clones/:id/events", (req, res) =>
    documentEvents.watch(
      req,
      res,
      `sheet-clone:${req.params.id}`,
      (request) => {
        const row = db
          .prepare("SELECT team_id FROM sheet_clones WHERE id=?")
          .get(request.params.id);
        requireThat(row, 404, "사본을 찾을 수 없습니다.");
        teamAccess(request.user, row.team_id);
      },
    ),
  );
  app.use((req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    const path = req.path;
    if (
      (path.startsWith("/api/tasks") || path === "/api/cells/batch") &&
      taskRequestsHandled?.(req)
    )
      return next();
    const keys = new Set();
    const team = (id) => {
      if (typeof id === "string") keys.add(`team:${id}`);
    };
    const task = (id) => {
      if (typeof id === "string")
        team(
          db.prepare("SELECT team_id FROM tasks WHERE id=?").get(id)?.team_id,
        );
    };
    const sheetClone = path.match(/^\/api\/sheet-clones\/([^/]+)/)?.[1];
    if (sheetClone) {
      keys.add(`sheet-clone:${sheetClone}`);
      if (path.endsWith("/name"))
        team(
          db
            .prepare("SELECT team_id FROM sheet_clones WHERE id=?")
            .get(sheetClone)?.team_id,
        );
    } else if (path === "/api/sheet-clones") {
      team(req.body?.teamId);
      if (req.method === "DELETE")
        for (const id of Array.isArray(req.body?.ids) ? req.body.ids : [])
          if (typeof id === "string") keys.add(`sheet-clone:${id}`);
    } else if (path.startsWith("/api/tasks")) {
      team(req.body?.teamId);
      task(path.split("/")[3]);
      task(req.body?.targetId);
      for (const item of Array.isArray(req.body?.tasks) ? req.body.tasks : [])
        task(item?.id);
    } else if (path === "/api/cells/batch" && req.body?.format) {
      team(req.body.format.teamId);
    } else if (/^\/api\/teams\//.test(path)) team(path.split("/")[3]);
    else if (path.startsWith("/api/calendar/")) {
      team(req.body?.teamId);
      const entry = path.match(/^\/api\/calendar\/entries\/([^/]+)/)?.[1];
      if (entry)
        team(
          db
            .prepare("SELECT team_id FROM calendar_entries WHERE id=?")
            .get(entry)?.team_id,
        );
      const tag = path.match(/^\/api\/calendar\/tags\/([^/]+)/)?.[1];
      if (tag)
        team(
          db.prepare("SELECT team_id FROM calendar_tags WHERE id=?").get(tag)
            ?.team_id,
        );
      const scope = path.match(/^\/api\/calendar\/teams\/([^/]+)/)?.[1];
      team(scope);
    } else if (/^\/api\/(audit|import)\//.test(path)) {
      const id = path.split("/")[3];
      const table = path.startsWith("/api/audit/") ? "audit" : "imports";
      if (table === "audit")
        team(
          db.prepare("SELECT team_id FROM audit WHERE id=?").get(id)?.team_id,
        );
      else {
        if (req.body?.sheetCloneId)
          keys.add(`sheet-clone:${req.body.sheetCloneId}`);
        else
          team(
            db.prepare("SELECT team_id FROM imports WHERE id=?").get(id)
              ?.team_id,
          );
      }
    }
    // The collection stream covers page add/rename/reorder/delete independently
    // of the document body stream and its revision type.
    const collection = path.match(
      /^(\/api\/(?:tasks\/[^/]+\/documents|sheet-clones\/[^/]+\/tasks\/[^/]+\/documents|sheet-clones\/[^/]+\/memos|teams\/[^/]+\/years\/[^/]+\/memos))(?:\/.*)?$/,
    )?.[1];
    if (collection && req.method !== "PUT") keys.add(`list:${collection}`);
    // Body streams already deliver ordinary typing. Only presence changes need
    // to invalidate a large task sheet's document indicator.
    const taskDocument = path.match(
      /^\/api\/tasks\/([^/]+)\/(?:document|documents\/([^/]+))$/,
    );
    if (
      req.method === "PUT" &&
      taskDocument &&
      typeof req.body?.markdown === "string"
    ) {
      const previous = db
        .prepare(
          "SELECT has_content FROM task_documents WHERE task_id=? AND id=?",
        )
        .get(taskDocument[1], taskDocument[2] || "main");
      if (!!previous?.has_content === hasDocumentContent(req.body.markdown))
        keys.clear();
      else keys.add(`list:/api/tasks/${taskDocument[1]}/documents`);
    }
    const sheetCloneDocument = path.match(
      /^\/api\/sheet-clones\/([^/]+)\/tasks\/([^/]+)\/(?:document|documents\/([^/]+))$/,
    );
    if (
      req.method === "PUT" &&
      sheetCloneDocument &&
      typeof req.body?.markdown === "string"
    ) {
      const previous = db
        .prepare(
          "SELECT v.has_content FROM sheet_clone_documents d JOIN document_versions v ON v.id=d.version_id WHERE d.sheet_clone_id=? AND d.task_id=? AND d.document_id=?",
        )
        .get(
          sheetCloneDocument[1],
          sheetCloneDocument[2],
          sheetCloneDocument[3] || "main",
        );
      if (!!previous?.has_content === hasDocumentContent(req.body.markdown))
        keys.clear();
      else
        keys.add(
          `list:/api/sheet-clones/${sheetCloneDocument[1]}/tasks/${sheetCloneDocument[2]}/documents`,
        );
    }
    if (req.method === "PUT" && /\/memos\/[^/]+$/.test(path)) keys.clear();
    const bodyKey = taskDocument
      ? `task:${taskDocument[1]}:${taskDocument[2] || "main"}`
      : null;
    res.once("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        for (const key of keys)
          documentEvents.invalidate(key, req.get("X-Client-ID")?.slice(0, 64));
        if (req.method === "DELETE" && bodyKey) documentEvents.notify(bodyKey);
      }
    });
    next();
  });
}
