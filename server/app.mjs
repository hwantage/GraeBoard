import { installHttpBoundary, installHttpFallback } from "./http-boundary.mjs";
import { installLocalAuth } from "./local-auth.mjs";
import { createSqliteAccess } from "./sqlite-access.mjs";
import { installControlBusinessRoutes } from "./control-business-routes.mjs";
import { deploymentSite } from "../shared/site-mode.js";
import { SqliteControlRepository } from "./storage/sqlite-control.mjs";
import { installTaskBusinessRoutes } from "./task-business-routes.mjs";
import { installHistoryServiceRoutes } from "./history-service-routes.mjs";
import { SqliteHistoryRepository } from "./storage/sqlite-history.mjs";
import { installReportServiceRoutes } from "./report-service-routes.mjs";
import { SqliteReportRepository } from "./storage/sqlite-reports.mjs";
import { DocumentBusinessService } from "./storage/document-service.mjs";
import { SqliteDocumentRepository } from "./storage/sqlite-documents.mjs";
import { createDocumentImagePreparation } from "./document-image-preparation.mjs";
import { installDocumentBusinessRoutes } from "./document-business-routes.mjs";
import { TaskBusinessService } from "./storage/task-service.mjs";
import { SqliteTaskRepository } from "./storage/sqlite-tasks.mjs";
import { createNodeSync, installSyncRoutes } from "./sync/node.mjs";
import { installMaintenanceRoutes } from "./sync/maintenance-sqlite.mjs";
import { installRetentionContext } from "./sync/visibility.mjs";
import { installEventStreams } from "./event-streams.mjs";
import {
  documentImagesDirectory,
  installDocumentImageRoutes,
} from "./document-images.mjs";

import { installCalendarRoutes } from "./calendar.mjs";
import { installDocumentBrowserRoutes } from "./document-browser.mjs";

import { installFilterRoutes } from "./filters.mjs";

import express from "express";

import { resolve } from "node:path";

import { openDatabase, id, json } from "./db.mjs";

import { installTransferRoutes } from "./transfer.mjs";
import { installSettingsRoutes } from "./settings.mjs";
import { createTaskCache } from "./task-cache.mjs";
import { installResourceEvents } from "./resource-events.mjs";
import { createDocumentEvents } from "./document-events.mjs";
import { createCellEvents } from "./cell-events.mjs";
import { installHistoryCleanupRoutes } from "./history-cleanup.mjs";
import { installSystemAuditRoutes } from "./system-audit.mjs";

export function createApp({
  db,
  staticDir = resolve("dist"),
  allowSetup = true,
  rateLimits = true,
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
  const reportsRepository = new SqliteReportRepository({
    db,
    teamAccess,
    referencedUsers,
    documentImagesDir,
    documentEvents,
  });
  app.locals.reportRepository = reportsRepository;
  installReportServiceRoutes(app, {
    repository: reportsRepository,
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
