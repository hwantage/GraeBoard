import { installLinkTitleRoute } from "./http/link-title.mjs";
import { installHttpBoundary, installHttpFallback } from "./http/http-boundary.mjs";
import { installAccessTokenRoutes } from "./auth/access-tokens.mjs";
import { installLocalAuth } from "./auth/local-auth.mjs";
import { createSqliteAccess } from "./auth/sqlite-access.mjs";
import { installControlBusinessRoutes } from "./control/control-business-routes.mjs";
import { deploymentSite } from "../shared/site/site-mode.js";
import { SqliteControlRepository } from "./storage/control/sqlite-control.mjs";
import { installTaskBusinessRoutes } from "./sheet/task-business-routes.mjs";
import { installHistoryServiceRoutes } from "./history/history-service-routes.mjs";
import { SqliteHistoryRepository } from "./storage/history/sqlite-history.mjs";
import { installSheetCloneServiceRoutes } from "./sheet-clones/sheet-clone-service-routes.mjs";
import { SqliteSheetCloneRepository } from "./storage/sheet-clones/sqlite-sheet-clones.mjs";
import { DocumentBusinessService } from "./storage/documents/document-service.mjs";
import { SqliteDocumentRepository } from "./storage/documents/sqlite-documents.mjs";
import { createDocumentImagePreparation } from "./documents/document-image-preparation.mjs";
import { installDocumentBusinessRoutes } from "./documents/document-business-routes.mjs";
import { TaskBusinessService } from "./storage/tasks/task-service.mjs";
import { SqliteTaskRepository } from "./storage/tasks/sqlite-tasks.mjs";
import { createNodeSync, installSyncRoutes } from "./sync/node.mjs";
import { installMaintenanceRoutes } from "./sync/maintenance-sqlite.mjs";
import { installRetentionContext } from "./sync/visibility.mjs";
import { installEventStreams } from "./events/event-streams.mjs";
import {
  documentImagesDirectory,
  installDocumentImageRoutes,
} from "./documents/document-images.mjs";

import { installCalendarRoutes } from "./calendar/calendar.mjs";
import { installDocumentBrowserRoutes } from "./documents/document-browser.mjs";

import { installFilterRoutes } from "./sheet/filters.mjs";

import express from "express";

import { resolve } from "node:path";

import { openDatabase, id, json } from "./db.mjs";

import { installTransferRoutes } from "./transfer/transfer.mjs";
import { installSettingsRoutes } from "./control/settings.mjs";
import { createTaskCache } from "./sheet/task-cache.mjs";
import { installResourceEvents } from "./events/resource-events.mjs";
import { createDocumentEvents } from "./events/document-events.mjs";
import { createCellEvents } from "./events/cell-events.mjs";
import { installHistoryCleanupRoutes } from "./history/history-cleanup.mjs";
import { installSystemAuditRoutes } from "./history/system-audit.mjs";

export function createApp({
  db,
  staticDir = resolve("dist"),
  allowSetup = true,
  rateLimits = true,
  linkTitleOptions,
  cellEventOptions,
  syncOptions = {},
  documentImagesDir = documentImagesDirectory(),
} = {}) {
  const site = deploymentSite(process.env, "internal");
  db ??= openDatabase();
  const app = express();
  installRetentionContext(app);
  const cachedTasks = createTaskCache(db);
  const cellEvents = createCellEvents(db, cellEventOptions);
  app.locals.db = db;
  app.locals.cellEvents = cellEvents;
  installHttpBoundary(app);
  app.get("/api/health", (_req, res) =>
    res.json({ status: "ok", version: "0.1.0", site }),
  );
  const { refreshUser, sessionHash } = installLocalAuth(app, {
    db,
    site,
    allowSetup,
    rateLimits,
  });
  installLinkTitleRoute(app, {
    privateHosts: process.env.GRAEBOARD_LINK_TITLE_PRIVATE_HOSTS,
    ...linkTitleOptions,
  });
  installAccessTokenRoutes(app, { db });
  const {
    teamAccess,
    taskAccess,
    managedTeam,
    requireSystemAdmin,
    teamUsers,
    assignableUsers,
    referencedUsers,
  } = createSqliteAccess(db);
  installHistoryCleanupRoutes(app, { db });
  installSystemAuditRoutes(app, { db });
  const tasksRepository = new SqliteTaskRepository({
    db,
    control: { teamAccess, taskAccess },
    cachedTasks,
    cellEvents,
    documentImagesDir,
  });
  app.locals.taskRepository = tasksRepository;
  const taskService = (req) =>
    new TaskBusinessService(tasksRepository, req.user);
  const documentEvents = createDocumentEvents(refreshUser);
  app.locals.documentEvents = documentEvents;
  const controlsRepository = new SqliteControlRepository({
    db,
    teamAccess,
    managedTeam,
    requireSystemAdmin,
    referencedUsers,
    documentImagesDir,
    cachedTasks,
    syncProfiles: () => sync.profiles,
  });
  app.locals.controlRepository = controlsRepository;
  const sync = createNodeSync({
    db,
    documentImagesDir,
    documentEvents,
    cellEvents,
    clearTeam: cachedTasks.clearTeam,
    options: syncOptions,
  });
  app.locals.sync = sync;
  const documentPreparation = createDocumentImagePreparation();
  app.locals.documentPreparation = documentPreparation;
  const closeSync = sync.close.bind(sync);
  sync.close = () => Promise.all([closeSync(), documentPreparation.close()]);
  app.use("/api", (req, res, next) =>
    sync.capture.withActor(req.user?.id, next),
  );
  installSyncRoutes(app, {
    db,
    teamAccess,
    managedTeam,
    requireSystemAdmin,
    refreshUser,
    sync,
  });
  installMaintenanceRoutes(app, {
    db,
    requireSystemAdmin,
    teamAccess,
    sync,
    documentImagesDir,
  });
  const documentsRepository = new SqliteDocumentRepository({
    db,
    control: { teamAccess, taskAccess },
    documentImagesDir,
    documentEvents,
    documentPreparation,
  });
  app.locals.documentRepository = documentsRepository;
  const documentService = (req) =>
    new DocumentBusinessService(documentsRepository, req.user, {
      documentEvents,
      refreshUser: () => refreshUser(req),
    });
  installControlBusinessRoutes(app, {
    site,
    repository: controlsRepository,
    documentEvents,
    refreshUser,
    cellEvents,
  });
  installDocumentBusinessRoutes(app, {
    service: documentService,
    documentEvents,
  });
  installDocumentImageRoutes(app, { refreshUser });
  const sheetClonesRepository = new SqliteSheetCloneRepository({
    db,
    teamAccess,
    referencedUsers,
    documentImagesDir,
    documentEvents,
  });
  app.locals.sheetCloneRepository = sheetClonesRepository;
  installSheetCloneServiceRoutes(app, {
    repository: sheetClonesRepository,
    documentEvents,
    refreshUser,
    cellEvents,
  });
  const historiesRepository = new SqliteHistoryRepository({
    db,
    control: { teamAccess, taskAccess, managedTeam, restoreTaskRows },
    documentEvents,
  });
  app.locals.historyRepository = historiesRepository;
  installHistoryServiceRoutes(app, { repository: historiesRepository });
  const { calendarDocumentAccess } = installCalendarRoutes(app, {
    documentEvents,
    db,
    teamAccess,
    managedTeam,
    taskAccess,
    documentImagesDir,
  });
  documentsRepository.control.calendarDocuments = calendarDocumentAccess;
  installDocumentBrowserRoutes(app, {
    db,
    teamAccess,
    taskAccess,
    teamUsers,
    referencedUsers,
  });
  installTransferRoutes(app, {
    db,
    teamAccess,
    managedTeam,
    assignableUsers,
    referencedUsers,
    documentImagesDir,
  });
  installSettingsRoutes(app, {
    db,
    managedTeam,
    documentEvents,
  });
  installFilterRoutes(app, {
    db,
    teamAccess,
    documentEvents,
  });
  installEventStreams(app);
  installResourceEvents(app, {
    db,
    documentEvents,
    teamAccess,
  });
  installTaskBusinessRoutes(app, {
    service: taskService,
    cellEvents,
    refreshUser,
    sessionHash,
  });
  function restoreTaskRows(user, versions) {
    return tasksRepository.restore(user, versions);
  }

  installHttpFallback(app, { staticDir });
  return app;
}
