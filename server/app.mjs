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
import { installRetentionBoundary, retentionView } from "./sync/visibility.mjs";
import { installEventStreams, registerEventRoute } from "./event-streams.mjs";
import {
  documentImagesDirectory,
  installDocumentImageRoutes,
  validateDocumentImages,
  removeTeamDocumentImages,
} from "./document-images.mjs";
import { copyReportMemos } from "./memo-storage.mjs";
import { installCalendarRoutes } from "./calendar.mjs";
import { installDocumentBrowserRoutes } from "./document-browser.mjs";
import {
  withTaskDocumentReferences,
  syncReportDocuments,
  pruneDocumentVersions,
  readReport,
} from "./document-storage.mjs";
import { withTaskDocuments } from "./task-documents.mjs";
import { installFilterRoutes } from "./filters.mjs";
import {
  auditSheetSql,
  deletedReportTasks,
  restoreReportTasks,
} from "./sheet-history.mjs";
import { reportResponse, reportRevision } from "./report-editing.mjs";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { randomBytes, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { THEME_IDS } from "../shared/themes.js";
import { copyRowFormatting, taskAuditSnapshot } from "../shared/formatting.js";
import { applyFormatting } from "./formatting.mjs";
import { pack, unpack } from "../shared/compact.js";
import {
  openDatabase,
  id,
  now,
  nextTaskStamp,
  json,
  parse,
  passwordHash,
  passwordMatches,
  userWithTeams,
  usersWithTeams,
  teamSettings,
  addMembership,
  replaceUserMemberships,
  replaceTeamMembers,
  upsertCellStatement,
  pruneStyles,
  touchTasks,
  getTask,
  getTasks,
  insertTask,
  transaction,
  audit,
  seedDemo,
} from "./db.mjs";
import {
  HttpError,
  requireThat,
  yearSchema,
  periodScopeSchema,
  dateSchema,
  viewSchema,
  reportNameSchema,
  validateCellValue,
  copiedRowSchema,
  validCellKey,
} from "./validation.mjs";
import {
  DEFAULT_SETTINGS,
  TEAM_ROLES,
  canEdit,
  canContribute,
  canManageTeam,
  isAssignable,
  isSystemAdmin,
  cell,
  todayKey,
  sampleProperties,
  normalizeView,
  viewLayout,
  fieldsFor,
  propertiesFor,
  emptyPropertyValue,
  periodYears,
} from "../shared/domain.js";
import { installTransferRoutes } from "./transfer.mjs";
import { installSettingsRoutes } from "./settings.mjs";
import { createTaskCache } from "./task-cache.mjs";
import { installResourceEvents } from "./resource-events.mjs";
import { createDocumentEvents } from "./document-events.mjs";
import { createCellEvents } from "./cell-events.mjs";
import { installHistoryCleanupRoutes } from "./history-cleanup.mjs";
import { installSystemAuditRoutes } from "./system-audit.mjs";
import { insertionPosition } from "./task-position.mjs";
import { deleteTeam } from "./team-deletion.mjs";
import { profileFields } from "./profiles.mjs";
import {
  encodeReport,
  decodeReport,
  requireUniqueReportName,
} from "./reports.mjs";

const string = (max = 100) => z.string().trim().min(1).max(max);
// 아이디는 이메일 주소다. 대소문자를 구분하지 않으므로 소문자로 저장한다.
// 이메일 이전에 만든 기존 아이디는 로그인만 그대로 허용한다.
const loginId = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine(
    (v) => z.email().safeParse(v).success,
    "아이디는 이메일 주소로 입력하세요.",
  );
const credentials = z.object({
  username: loginId,
  password: z.string().min(10).max(128),
});
const systemRoles = z.enum(["admin", "user"]);
const teamMemberRowsSchema = z
  .array(
    z.object({ userId: z.string().uuid(), role: z.enum(TEAM_ROLES) }).strict(),
  )
  .max(1000)
  .refine(
    (members) => new Set(members.map((m) => m.userId)).size === members.length,
    "같은 사용자를 중복으로 추가할 수 없습니다.",
  );
const userMembershipRowsSchema = z
  .array(
    z.object({ teamId: z.string().uuid(), role: z.enum(TEAM_ROLES) }).strict(),
  )
  .max(50)
  .refine(
    (items) => new Set(items.map((m) => m.teamId)).size === items.length,
    "같은 팀을 중복으로 선택할 수 없습니다.",
  );
const sessionHash = (t) => createHash("sha256").update(t).digest("hex");
export function createApp({
  db,
  staticDir = resolve("dist"),
  allowSetup = true,
  rateLimits = true,
  cellEventOptions,
  storage = {},
  controlRepository,
  taskRepository,
  adminHistoryRepository,
  reportRepository,
  calendarRepository,
  settingsRepository,
  filterRepository,
  documentRepository,
  historyRepository,
  browserRepository,
  transferRepository,
  syncOptions = {},
  documentImagesDir = documentImagesDirectory(),
} = {}) {
  const site = deploymentSite(process.env, "internal");
  db ??= openDatabase();
  // Repository factories are server configuration, never request input.
  controlRepository ??= storage.control;
  taskRepository ??= storage.tasks;
  reportRepository ??= storage.reports;
  calendarRepository ??= storage.calendar;
  settingsRepository ??= storage.settings;
  filterRepository ??= storage.filters;
  documentRepository ??= storage.documents;
  historyRepository ??= storage.history;
  browserRepository ??= storage.browser;
  transferRepository ??= storage.transfer;
  adminHistoryRepository ??= storage.adminHistory;
  if (controlRepository && controlRepository.authenticationMode !== "password")
    throw new TypeError(
      "Node password authentication requires a matching SQLite control repository; PostgreSQL Access control belongs to the Worker host",
    );
  const app = express();
  const cachedTasks = createTaskCache(db);
  const cellEvents = createCellEvents(db, cellEventOptions);
  app.locals.db = db;
  app.locals.cellEvents = cellEvents;
  app.disable("x-powered-by");
  if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          fontSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(
    compression({
      filter: (req, res) =>
        !req.path.endsWith("/events") && compression.filter(req, res),
    }),
  );
  app.use(cookieParser());
  app.use((req, res, next) => {
    const respond = res.json.bind(res);
    res.json = (data) => respond(pack(data));
    next();
  });
  app.use("/api/cells/batch", express.json({ limit: "32mb" }));
  app.use("/api/reports", express.json({ limit: "32mb" }));
  app.use(express.json({ limit: "5mb" }));
  app.use((req, res, next) => {
    try {
      req.body = unpack(req.body, { maxStyles: 50001 });
      next();
    } catch (error) {
      next(new HttpError(400, error.message));
    }
  });
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (req.get("X-Requested-With") !== "WeeklyPlan")
        return res
          .status(403)
          .json({ error: "요청 출처를 확인할 수 없습니다." });
      const origin = req.get("Origin");
      if (origin && !URL.canParse(origin))
        return res.status(403).json({ error: "허용되지 않은 출처입니다." });
      if (
        origin &&
        new URL(origin).host !== req.get("Host") &&
        origin !== process.env.APP_ORIGIN
      )
        return res.status(403).json({ error: "허용되지 않은 출처입니다." });
      if (req.get("Sec-Fetch-Site") === "cross-site")
        return res
          .status(403)
          .json({ error: "외부 사이트의 요청은 허용되지 않습니다." });
    }
    next();
  });
  app.get("/api/health", (_req, res) =>
    res.json({ status: "ok", version: "0.1.0", site }),
  );
  app.get("/api/setup", (_req, res) =>
    res.json({
      site,
      required: db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0,
      tokenRequired: !!process.env.SETUP_TOKEN,
    }),
  );
  const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
  const sessionRenewInterval = 24 * 60 * 60 * 1000;
  function sessionCookie(res, token) {
    res.cookie("weekly_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.COOKIE_SECURE === "1",
      maxAge: sessionLifetime,
      path: "/",
    });
  }
  function issueSession(res, userId) {
    const token = randomBytes(32).toString("hex");
    db.prepare("DELETE FROM sessions WHERE expires_at<?").run(Date.now());
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      sessionHash(token),
      userId,
      Date.now() + sessionLifetime,
    );
    sessionCookie(res, token);
  }
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "로그인 시도가 많습니다. 잠시 후 다시 시도하세요." },
  });
  if (rateLimits) app.use("/api/auth", loginLimiter);
  app.post("/api/auth/setup", (req, res) => {
    const data = credentials
      .extend({
        name: string(50),
        teamName: string(80),
        sample: z.boolean().default(false),
        token: z.string().optional(),
      })
      .parse(req.body);
    requireThat(allowSetup, 403, "초기 설정이 비활성화되어 있습니다.");
    requireThat(
      !process.env.SETUP_TOKEN || data.token === process.env.SETUP_TOKEN,
      403,
      "초기 설정 키를 확인하세요.",
    );
    const u = transaction(db, () => {
      requireThat(
        db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0,
        409,
        "초기 설정이 이미 완료되었습니다.",
      );
      const userId = id(),
        teamId = id();
      db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
        teamId,
        data.teamName,
        json(
          data.sample
            ? { ...DEFAULT_SETTINGS, properties: sampleProperties() }
            : DEFAULT_SETTINGS,
        ),
      );
      db.prepare(
        "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        userId,
        data.username,
        data.name,
        passwordHash(data.password),
        "admin",
        now(),
      );
      addMembership(db, userId, teamId, "lead");
      const user = userWithTeams(
        db,
        db.prepare("SELECT * FROM users WHERE id=?").get(userId),
      );
      if (data.sample)
        seedDemo(db, user, teamId, Number(todayKey().slice(0, 4)));
      audit(db, userId, teamId, "setup", teamId, undefined, {
        teamName: data.teamName,
      });
      return user;
    });
    issueSession(res, u.id);
    res.status(201).json({ user: u });
  });
  app.post("/api/auth/login", (req, res) => {
    const { username, password } = z
      .object({ username: string(254), password: z.string().min(1).max(128) })
      .parse(req.body);
    const u = db
      .prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE")
      .get(username);
    const fallback = "00000000000000000000000000000000:" + "00".repeat(64);
    const valid = passwordMatches(password, u?.password || fallback);
    requireThat(
      u && u.active && valid,
      401,
      "아이디(이메일) 또는 비밀번호가 올바르지 않습니다.",
    );
    transaction(db, () => {
      audit(db, u.id, null, "login", u.id, undefined, {
        name: u.name,
        username: u.username,
      });
      issueSession(res, u.id);
    });
    res.json({ user: userWithTeams(db, u) });
  });
  app.use("/api", (req, res, next) => {
    const token = req.cookies.weekly_session;
    const u =
      token &&
      db
        .prepare(
          "SELECT u.*, s.expires_at AS sessionExpiresAt FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>? AND u.active=1",
        )
        .get(sessionHash(token), Date.now());
    if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
    // Renew the existing session at most once a day, including valid sessions
    // issued before this release. Expired or revoked tokens never reach here.
    if (
      !["/auth/logout", "/auth/password"].includes(req.path) &&
      u.sessionExpiresAt < Date.now() + sessionLifetime - sessionRenewInterval
    ) {
      db.prepare("UPDATE sessions SET expires_at=? WHERE token=?").run(
        Date.now() + sessionLifetime,
        sessionHash(token),
      );
      sessionCookie(res, token);
    }
    req.user = userWithTeams(db, u);
    if (!controlRepository) return next();
    try {
      const selected =
        typeof controlRepository === "function"
          ? controlRepository(req.user, req)
          : controlRepository;
      const resolved = selected.resolveUser
        ? selected.resolveUser(req.user.id)
        : req.user;
      if (resolved && typeof resolved.then === "function")
        return resolved.then((user) => {
          req.user = user;
          next();
        }, next);
      req.user = resolved;
      next();
    } catch (error) {
      next(error);
    }
  });
  function teamAccess(user, teamId) {
    requireThat(
      isSystemAdmin(user) || user.teamIds.includes(teamId),
      403,
      "이 팀에 접근할 권한이 없습니다.",
    );
    const t = db.prepare("SELECT * FROM teams WHERE id=?").get(teamId);
    requireThat(t, 404, "팀을 찾을 수 없습니다.");
    return { ...t, settings: teamSettings(t) };
  }
  // 팀장(또는 시스템 관리자)만 할 수 있는 작업의 팀 조회.
  function managedTeam(user, teamId, message = "팀장 권한이 필요합니다.") {
    const team = teamAccess(user, teamId);
    requireThat(canManageTeam(user, teamId), 403, message);
    return team;
  }
  function requireSystemAdmin(user) {
    requireThat(isSystemAdmin(user), 403, "시스템 관리자 권한이 필요합니다.");
  }
  installHistoryCleanupRoutes(app, { db, repository: adminHistoryRepository });
  installSystemAuditRoutes(app, { db, repository: adminHistoryRepository });
  function taskAccess(user, taskId, edit = false, includeDeleted = false) {
    const t = getTask(db, taskId);
    requireThat(
      t && (!t.deletedAt || includeDeleted),
      404,
      "업무를 찾을 수 없습니다.",
    );
    teamAccess(user, t.teamId);
    retentionView(db, t.teamId).requireVisible("task", [taskId]);
    if (edit)
      requireThat(canEdit(user, t), 403, "이 업무를 편집할 권한이 없습니다.");
    return t;
  }
  const sqliteTasksRepository = new SqliteTaskRepository({
    db,
    control: { teamAccess, taskAccess },
    cachedTasks,
    cellEvents,
    documentImagesDir,
  });
  const tasksRepository = taskRepository || sqliteTasksRepository;
  app.locals.taskRepository = tasksRepository;
  const configuredTaskServices = taskRepository ? new WeakMap() : null;
  const taskService = (req) => {
    if (configuredTaskServices?.has(req))
      return configuredTaskServices.get(req);
    const service = new TaskBusinessService(
      typeof taskRepository === "function"
        ? taskRepository(req.user, req)
        : tasksRepository,
      req.user,
      taskRepository
        ? { documentEvents, clientId: req.get("X-Client-ID")?.slice(0, 64) }
        : undefined,
    );
    configuredTaskServices?.set(req, service);
    return service;
  };
  function teamUsers(teamId) {
    return usersWithTeams(
      db,
      db
        .prepare(
          "SELECT u.* FROM users u JOIN memberships m ON u.id=m.user_id WHERE m.team_id=? ORDER BY u.name",
        )
        .all(teamId),
    );
  }
  // 담당자로 고를 수 있는 사람: 그 팀의 팀장·팀원.
  function assignableUsers(teamId) {
    return teamUsers(teamId).filter((u) => isAssignable(u, teamId));
  }
  // 표시용 목록: 현재 구성원(열람자 포함)과, 팀을 떠났지만 아직 셀에 남아 있는
  // 과거 담당자까지 포함해 기존 셀의 이름이 사라지지 않게 한다.
  function referencedUsers(teamId) {
    const users = teamUsers(teamId);
    const settings = teamSettings(
      db.prepare("SELECT settings FROM teams WHERE id=?").get(teamId),
    );
    const keys = [
      ...new Set([
        "owner",
        "supporters",
        ...propertiesFor(settings, true)
          .filter((p) => p.kind === "member")
          .map((p) => p.id),
      ]),
    ];
    const referenced = db
      .prepare(
        // Deduplicate IDs before reading profiles: avatars can be much larger
        // than the member references repeated across thousands of cells.
        "SELECT u.* FROM users u WHERE u.id IN (SELECT DISTINCT v.value FROM tasks t JOIN cells c ON c.task_id=t.id JOIN json_each(c.value) v WHERE t.team_id=? AND c.key IN (SELECT value FROM json_each(?)))",
      )
      .all(teamId, json(keys));
    const current = new Set(users.map((u) => u.id));
    return [
      ...users,
      ...usersWithTeams(
        db,
        referenced.filter((u) => !current.has(u.id)),
      ),
    ];
  }
  const refreshUser = (req) => {
    const row = db
      .prepare(
        "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires_at>? AND u.active=1",
      )
      .get(sessionHash(req.cookies.weekly_session), Date.now());
    requireThat(row, 401, "로그인이 필요합니다.");
    const identity = userWithTeams(db, row);
    if (!controlRepository) return identity;
    const selected =
      typeof controlRepository === "function"
        ? controlRepository(identity, req)
        : controlRepository;
    return selected.resolveUser ? selected.resolveUser(identity.id) : identity;
  };
  const documentEvents = createDocumentEvents(refreshUser);
  app.locals.documentEvents = documentEvents;
  storage.configure?.({
    db,
    teamAccess,
    taskAccess,
    managedTeam,
    requireSystemAdmin,
    referencedUsers,
    documentImagesDir,
    cachedTasks,
    documentEvents,
  });
  const controlsRepository =
    controlRepository ||
    new SqliteControlRepository({
      db,
      teamAccess,
      managedTeam,
      requireSystemAdmin,
      referencedUsers,
      documentImagesDir,
      cachedTasks,
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
  const documentsRepository =
    documentRepository ||
    new SqliteDocumentRepository({
      db,
      control: { teamAccess, taskAccess },
      documentImagesDir,
      documentEvents,
      documentPreparation,
    });
  app.locals.documentRepository = documentsRepository;
  const documentService = (req) =>
    new DocumentBusinessService(
      typeof documentRepository === "function"
        ? documentRepository(req.user, req)
        : documentsRepository,
      req.user,
      { documentEvents, refreshUser: () => refreshUser(req) },
    );
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
  const reportsRepository =
    reportRepository ||
    new SqliteReportRepository({
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
  const historiesRepository =
    historyRepository ||
    new SqliteHistoryRepository({
      db,
      control: { teamAccess, taskAccess, managedTeam, restoreTaskRows },
      documentEvents,
    });
  app.locals.historyRepository = historiesRepository;
  installHistoryServiceRoutes(app, { repository: historiesRepository });
  const { calendarImageAccess, calendarDocumentAccess } = installCalendarRoutes(
    app,
    {
      repository: calendarRepository,
      documentEvents,
      db,
      teamAccess,
      managedTeam,
      taskAccess,
      documentImagesDir,
    },
  );
  if (documentsRepository instanceof SqliteDocumentRepository)
    documentsRepository.control.calendarDocuments = calendarDocumentAccess;
  installDocumentBrowserRoutes(app, {
    repository: browserRepository,
    db,
    teamAccess,
    taskAccess,
    teamUsers,
    referencedUsers,
  });
  installTransferRoutes(app, {
    repository: transferRepository,
    db,
    teamAccess,
    managedTeam,
    assignableUsers,
    referencedUsers,
    documentImagesDir,
  });
  installSettingsRoutes(app, {
    repository: settingsRepository,
    db,
    managedTeam,
    documentEvents,
  });
  installFilterRoutes(app, {
    repository: filterRepository,
    db,
    teamAccess,
    documentEvents,
  });
  installRetentionBoundary(app, { db, taskRequestsHandled: true });
  installEventStreams(app);
  installResourceEvents(app, {
    db,
    documentEvents,
    teamAccess,
    taskRequestsHandled: (req) =>
      !!taskRepository && !!taskService(req).repository.resourceChanges,
  });
  app.post("/api/auth/logout", (req, res) => {
    transaction(db, () => {
      db.prepare("DELETE FROM sessions WHERE token=?").run(
        sessionHash(req.cookies.weekly_session),
      );
      audit(db, req.user.id, null, "logout", req.user.id, undefined, {
        name: req.user.name,
        username: req.user.username,
      });
    });
    res.clearCookie("weekly_session", { path: "/" });
    res.json({ ok: true });
  });

  app.post("/api/auth/password", (req, res) => {
    const d = z
      .object({
        currentPassword: z.string().max(128),
        password: credentials.shape.password,
      })
      .parse(req.body);
    const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    requireThat(
      passwordMatches(d.currentPassword, u.password),
      403,
      "현재 비밀번호를 확인하세요.",
    );
    transaction(db, () => {
      db.prepare("UPDATE users SET password=? WHERE id=?").run(
        passwordHash(d.password),
        u.id,
      );
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
      audit(db, u.id, null, "password", u.id, undefined, { changed: true });
    });
    issueSession(res, u.id);
    res.json({ ok: true });
  });

  app.get("/api/tasks", (req, res, next) => {
    const send = (result) => {
      res.set("ETag", result.etag);
      res.set("X-Cell-Event-ID", result.cellEventId);
      res.vary("Accept-Encoding");
      if (result.notModified) return res.status(304).end();
      if (result.data) return res.json(result.data);
      const cached = result.encoded;
      if (req.retention?.active)
        return res.json(unpack(JSON.parse(cached.body.toString("utf8"))));
      res.type("application/json");
      if (req.acceptsEncodings("gzip")) {
        res.set("Content-Encoding", "gzip");
        return res.send(cached.gzip);
      }
      return res.send(cached.body);
    };
    const result = taskService(req).query(req.query, {
      ifNoneMatch: req.get("If-None-Match"),
    });
    if (result?.then) return result.then(send, next);
    send(result);
  });
  registerEventRoute(app, "/api/cells/events", (req, res) => {
    return taskService(req).subscribe(req.query, {
      request: req,
      response: res,
      token: sessionHash(req.cookies.weekly_session),
      refreshUser: () => refreshUser(req),
      register: cellEvents.registerExternal,
    });
  });

  installTaskBusinessRoutes(app, { service: taskService });
  app.post("/api/cells/batch", (req, res, next) => {
    const result = taskService(req).saveBatch(req.body);
    if (result?.then) return result.then((value) => res.json(value), next);
    res.json(result);
  });
  function restoreTaskRows(user, versions) {
    return sqliteTasksRepository.restore(user, versions);
  }

  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "요청한 API를 찾을 수 없습니다." }),
  );
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir, { maxAge: 0 }));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(resolve(staticDir, "index.html")),
    );
  }
  app.use((err, req, res, _next) => {
    // Changing worker subscriptions cancels the previous read-only POST,
    // sometimes before its JSON body has finished arriving.
    if (req.path === "/api/events" && err.type === "request.aborted") return;
    if (err.type === "entity.parse.failed")
      return res.status(400).json({ error: "JSON 입력 형식을 확인하세요." });
    if (err instanceof z.ZodError)
      return res.status(400).json({
        // 직접 정의한 검증 문구가 있으면 그대로 보여 준다.
        error:
          err.issues.find((i) => i.code === "custom")?.message ||
          "입력값을 확인하세요.",
        details: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    if (process.env.DEBUG_HTTP)
      console.error(
        "DEBUG_HTTP",
        req.method,
        req.path,
        err.message,
        JSON.stringify(err.issues?.slice(0, 3) ?? err.details ?? null),
      );
    if (err instanceof HttpError)
      return res
        .status(err.status)
        .json({ error: err.message, details: err.details });
    if (err.code === "LIMIT_FILE_SIZE")
      return res
        .status(413)
        .json({ error: "파일은 25MB까지 가져올 수 있습니다." });
    if (err.type === "entity.too.large")
      return res.status(413).json({
        error: "요청 크기가 너무 큽니다. 범위를 줄여 다시 시도하세요.",
      });
    console.error(`[${now()}] ${req.method} ${req.path}:`, err.message);
    res.status(500).json({
      error: "서버에서 처리하지 못했습니다. 입력을 보존한 뒤 다시 시도하세요.",
    });
  });
  return app;
}
