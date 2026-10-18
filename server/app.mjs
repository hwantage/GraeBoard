import {
  documentImagesDirectory,
  installDocumentImageRoutes,
  validateDocumentImages,
  removeTeamDocumentImages,
} from "./document-images.mjs";
import { installReportDocumentRoutes } from "./report-documents.mjs";
import { installCalendarRoutes } from "./calendar.mjs";
import { installDocumentBrowserRoutes } from "./document-browser.mjs";
import {
  withTaskDocumentReferences,
  syncReportDocuments,
  pruneDocumentVersions,
  readReport,
} from "./document-storage.mjs";
import {
  installTaskDocumentRoutes,
  withTaskDocuments,
} from "./task-documents.mjs";
import { installFilterRoutes } from "./filters.mjs";
import {
  auditSheetSql,
  deletedReportTasks,
  restoreReportTasks,
} from "./sheet-history.mjs";
import {
  installReportEditingRoutes,
  reportResponse,
  reportRevision,
} from "./report-editing.mjs";
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
import {
  normalizeCellStyle,
  copyRowFormatting,
  taskAuditSnapshot,
} from "../shared/formatting.js";
import { applyFormatting, replayFormatOperation } from "./formatting.mjs";
import { pack, unpack, styleNormalizer, sameStyle } from "../shared/compact.js";
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
  getTasksById,
  insertTask,
  transaction,
  audit,
  seedDemo,
} from "./db.mjs";
import {
  HttpError,
  requireThat,
  batchSchema,
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
import { saveSettings } from "./settings.mjs";
import { createTaskCache } from "./task-cache.mjs";
import { createCellEvents } from "./cell-events.mjs";
import { storeCellOperation, replayCellOperation } from "./cell-operations.mjs";
import {
  installHistoryCleanupRoutes,
  validateCellRequestTime,
} from "./history-cleanup.mjs";
import { installReorderRoute } from "./reorder.mjs";
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
  db = openDatabase(),
  staticDir = resolve("dist"),
  allowSetup = true,
  rateLimits = true,
  cellEventOptions,
  documentImagesDir = documentImagesDirectory(),
} = {}) {
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
        req.path !== "/api/cells/events" && compression.filter(req, res),
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
    res.json({ status: "ok", version: "0.1.0" }),
  );
  app.get("/api/setup", (_req, res) =>
    res.json({
      required: db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0,
      tokenRequired: !!process.env.SETUP_TOKEN,
    }),
  );
  function issueSession(res, userId) {
    const token = randomBytes(32).toString("hex");
    db.prepare("DELETE FROM sessions WHERE expires_at<?").run(Date.now());
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      sessionHash(token),
      userId,
      Date.now() + 8 * 60 * 60 * 1000,
    );
    res.cookie("weekly_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.COOKIE_SECURE === "1",
      maxAge: 8 * 60 * 60 * 1000,
      path: "/",
    });
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
          "SELECT u.* FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>? AND u.active=1",
        )
        .get(sessionHash(token), Date.now());
    if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
    req.user = userWithTeams(db, u);
    next();
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
  installHistoryCleanupRoutes(app, { db, requireSystemAdmin });
  installSystemAuditRoutes(app, { db, requireSystemAdmin });
  function taskAccess(user, taskId, edit = false, includeDeleted = false) {
    const t = getTask(db, taskId);
    requireThat(
      t && (!t.deletedAt || includeDeleted),
      404,
      "업무를 찾을 수 없습니다.",
    );
    teamAccess(user, t.teamId);
    if (edit)
      requireThat(canEdit(user, t), 403, "이 업무를 편집할 권한이 없습니다.");
    return t;
  }
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
  installReorderRoute(app, { db, taskAccess, teamAccess });
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
  app.patch("/api/auth/profile", (req, res) => {
    const d = z
      .object({ name: string(50).optional(), ...profileFields })
      .strict()
      .refine(
        (value) => Object.keys(value).length > 0,
        "변경할 프로필을 입력하세요.",
      )
      .parse(req.body);
    const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    const next = {
      name: d.name ?? u.name,
      color: d.color ?? u.color,
      avatarInitials: d.avatarInitials ?? u.avatar_initials,
      avatarImage: d.avatarImage ?? u.avatar_image,
    };
    transaction(db, () => {
      db.prepare(
        "UPDATE users SET name=?,color=?,avatar_initials=?,avatar_image=? WHERE id=?",
      ).run(next.name, next.color, next.avatarInitials, next.avatarImage, u.id);
      audit(
        db,
        u.id,
        null,
        "profile",
        u.id,
        {
          name: u.name,
          color: u.color,
          avatarInitials: u.avatar_initials,
          hasAvatarImage: !!u.avatar_image,
        },
        {
          name: next.name,
          color: next.color,
          avatarInitials: next.avatarInitials,
          hasAvatarImage: !!next.avatarImage,
        },
      );
    });
    res.json({
      user: userWithTeams(
        db,
        db.prepare("SELECT * FROM users WHERE id=?").get(u.id),
      ),
    });
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
  app.get("/api/bootstrap", (req, res) => {
    // 시스템 관리자는 소속이 없어도 모든 팀에 들어갈 수 있다.
    const teamIds = isSystemAdmin(req.user)
      ? db
          .prepare("SELECT id FROM teams ORDER BY name")
          .all()
          .map((t) => t.id)
      : req.user.teamIds;
    const teams = teamIds.map((t) => teamAccess(req.user, t));
    const users = new Map();
    teams.forEach((t) =>
      referencedUsers(t.id).forEach((u) => users.set(u.id, u)),
    );
    const years = new Set([Number(todayKey().slice(0, 4))]);
    for (const team of teams)
      for (const t of db
        .prepare("SELECT DISTINCT years FROM tasks WHERE team_id=?")
        .all(team.id))
        parse(t.years, []).forEach((y) => years.add(y));
    res.json({
      user: req.user,
      teams,
      users: [...users.values()],
      years: [...years].sort((a, b) => b - a),
    });
  });
  app.get("/api/tasks", (req, res) => {
    const teamId = String(req.query.teamId || "");
    teamAccess(req.user, teamId);
    const period = periodScopeSchema.parse(req.query);
    const year = periodYears(period.year, period.startMonth);
    const deleted = req.query.deleted === "1";
    if (deleted)
      requireThat(
        canManageTeam(req.user, teamId),
        403,
        "팀장만 삭제한 업무를 조회할 수 있습니다.",
      );
    const etag = cachedTasks.etag(teamId, year, deleted);
    res.set("ETag", etag);
    // The snapshot and cursor are captured synchronously in this process.
    res.set("X-Cell-Event-ID", cellEvents.cursor());
    res.vary("Accept-Encoding");
    if (req.get("If-None-Match") === etag) return res.status(304).end();
    const cached = cachedTasks(teamId, year, deleted, etag);
    res.type("application/json");
    if (req.acceptsEncodings("gzip")) {
      res.set("Content-Encoding", "gzip");
      return res.send(cached.gzip);
    }
    res.send(cached.body);
  });
  app.get("/api/cells/events", (req, res) => {
    const teamId = String(req.query.teamId || "");
    teamAccess(req.user, teamId);
    const period = periodScopeSchema.parse(req.query);
    const year = periodYears(period.year, period.startMonth);
    cellEvents.subscribe(req, res, {
      teamId,
      year,
      token: sessionHash(req.cookies.weekly_session),
    });
  });
  installTaskDocumentRoutes(app, {
    db,
    taskAccess,
    teamAccess,
    documentImagesDir,
  });
  const { calendarImageAccess } = installCalendarRoutes(app, {
    db,
    teamAccess,
    managedTeam,
    taskAccess,
    documentImagesDir,
  });
  installDocumentImageRoutes(app, {
    calendarImageAccess,
    db,
    taskAccess,
    teamAccess,
    managedTeam,
    documentImagesDir,
    refreshUser: (req) => {
      const row = db
        .prepare(
          "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires_at>? AND u.active=1",
        )
        .get(sessionHash(req.cookies.weekly_session), Date.now());
      requireThat(row, 401, "로그인이 필요합니다.");
      return userWithTeams(db, row);
    },
  });
  installReportDocumentRoutes(app, { db, teamAccess, documentImagesDir });
  installDocumentBrowserRoutes(app, {
    db,
    teamAccess,
    taskAccess,
    teamUsers,
    referencedUsers,
  });
  app.post("/api/tasks", (req, res) => {
    const d = z
      .object({
        teamId: z.string().uuid(),
        year: yearSchema,
        startMonth: z.number().int().min(1).max(12).default(1),
        fields: z.record(z.string(), z.any()).default({}),
        sourceId: z.string().uuid().optional(),
        copiedRow: copiedRowSchema.optional(),
        insertAt: z
          .object({
            taskId: z.string().uuid(),
            updatedAt: z.string(),
            placement: z.enum(["before", "after"]),
          })
          .strict()
          .optional(),
      })
      .refine((d) => !d.sourceId || !d.copiedRow, "복사할 행을 확인하세요.")
      .parse(req.body);
    const team = teamAccess(req.user, d.teamId);
    periodScopeSchema.parse(d);
    requireThat(
      canContribute(req.user, d.teamId),
      403,
      "등록 권한이 없습니다.",
    );
    // 팀에 소속되지 않은 시스템 관리자는 담당자가 될 수 없으므로 비워 둔다.
    const self = isAssignable(req.user, d.teamId) ? req.user.id : "";
    const blankCreation = !d.sourceId && !d.copiedRow;
    const blankInsertion = d.insertAt && blankCreation;
    // 신규 업무는 팀원·상태를 포함해 속성을 비운다. 명시한 값은 fields로 받는다.
    const fields = {
      ...Object.fromEntries(
        propertiesFor(team.settings)
          .map((p) => [
            p.id,
            p.id === "title"
              ? "새 업무"
              : p.id === "owner" &&
                  (d.sourceId ||
                    (d.copiedRow && !canManageTeam(req.user, d.teamId)))
                ? self
                : emptyPropertyValue(p),
          ])
          .filter(([, v]) => v !== "" && (!Array.isArray(v) || v.length > 0)),
      ),
      ...d.fields,
    };
    const defined = (key) =>
      propertiesFor(team.settings).some((p) => p.id === key);
    let cells = {},
      defaultStyle = team.settings.defaultStyle,
      rowStyle = {},
      documents;
    if (d.sourceId) {
      const source = taskAccess(req.user, d.sourceId);
      requireThat(
        source.teamId === d.teamId,
        400,
        "같은 팀의 업무만 복제할 수 있습니다.",
      );
      ({ cells, defaultStyle, rowStyle = {} } = copyRowFormatting(source));
      documents = withTaskDocuments(db, [source])[0].documents;
      // 복제본은 등록자가 담당자가 되고 지원자는 비운다.
      for (const k of new Set([
        ...["owner", "supporters"].filter(defined),
        ...Object.keys(d.fields),
      ]))
        cells = {
          ...cells,
          [k]: {
            value: k === "supporters" ? [] : (fields[k] ?? ""),
            style: cells[k]?.style || {},
          },
        };
    }
    if (d.copiedRow) {
      cells = { ...d.copiedRow.cells };
      defaultStyle = d.copiedRow.defaultStyle;
      rowStyle = d.copiedRow.rowStyle || {};
      documents = d.copiedRow.documents;
      for (const document of documents || [])
        validateDocumentImages(document.markdown, d.teamId, documentImagesDir);
      // A member may create only their own task, even when copying another row.
      if (!canManageTeam(req.user, d.teamId))
        for (const key of ["owner", "supporters"].filter(defined))
          cells[key] = {
            value: key === "owner" ? self : [],
            style: cells[key]?.style || {},
          };
      // 복사한 뒤 보관된 속성·선택값이나 팀을 떠난 담당자처럼 지금은 고를 수
      // 없는 값만 빼고 나머지 행 내용은 붙여넣는다.
      const archived = new Set(
        propertiesFor(team.settings, true)
          .filter((p) => p.archived)
          .map((p) => p.id),
      );
      for (const [key, c] of Object.entries(cells)) {
        if (archived.has(key)) {
          delete cells[key];
          continue;
        }
        requireThat(
          validCellKey(key, team.settings),
          400,
          "지원하지 않는 셀입니다.",
        );
        try {
          validateCellValue(db, d.teamId, key, c.value, team.settings);
        } catch (e) {
          if (!(e instanceof HttpError) || e.status !== 400) throw e;
          delete cells[key];
        }
      }
    }
    for (const [k, v] of Object.entries(fields))
      validateCellValue(db, d.teamId, k, v, team.settings);
    if (!canManageTeam(req.user, d.teamId))
      requireThat(
        fields.owner === req.user.id || (blankCreation && !fields.owner),
        403,
        "본인 책임 업무로 등록하세요.",
      );
    const task = transaction(db, () => {
      let position;
      if (d.insertAt) {
        const target = taskAccess(req.user, d.insertAt.taskId);
        requireThat(
          target.teamId === d.teamId &&
            target.years.some((y) =>
              periodYears(d.year, d.startMonth).includes(y),
            ),
          400,
          "같은 팀과 연도의 행을 선택하세요.",
        );
        requireThat(
          target.updatedAt === d.insertAt.updatedAt,
          409,
          "기준 행이 변경되었습니다. 새로고침 후 다시 선택하세요.",
        );
        if (blankInsertion) {
          // 빈 행 삽입은 기준 행의 서식만 상속한다. 값은 새 업무 기본값이나
          // 묶음에서 전달한 값을 유지하고, 숨긴 열·빈 주차 서식도 보존한다.
          const copied = copyRowFormatting(target);
          defaultStyle = copied.defaultStyle;
          rowStyle = copied.rowStyle || {};
          const properties = new Map(
            propertiesFor(team.settings).map((p) => [p.id, p]),
          );
          for (const [key, c] of Object.entries(copied.cells)) {
            if (
              !Object.keys(c.style).length ||
              !validCellKey(key, team.settings)
            )
              continue;
            cells[key] = {
              value: fields[key] ?? emptyPropertyValue(properties.get(key)),
              style: c.style,
            };
          }
        }
        position = insertionPosition(
          db,
          d.teamId,
          periodYears(d.year, d.startMonth),
          target.id,
          d.insertAt.placement,
        );
      }
      const t = insertTask(db, {
        teamId: d.teamId,
        year: d.year,
        actorId: req.user.id,
        fields,
        cells,
        defaultStyle,
        rowStyle,
        documents,
        position,
      });
      audit(
        db,
        req.user.id,
        d.teamId,
        "create",
        t.id,
        undefined,
        taskAuditSnapshot(t),
      );
      return t;
    });
    res.status(201).json({ task });
  });
  app.post("/api/cells/batch", (req, res) => {
    const d = batchSchema.parse(req.body);
    validateCellRequestTime(d.createdAt);
    const old = db
      .prepare("SELECT * FROM operations WHERE id=?")
      .get(d.operationId);
    if (old) {
      requireThat(
        old.actor_id === req.user.id,
        403,
        "다른 사용자의 작업입니다.",
      );
      const replay =
        parse(old.response)?.kind === "format-audit"
          ? replayFormatOperation(db, old)
          : replayCellOperation(db, old);
      if (replay.formatTeamId) teamAccess(req.user, replay.formatTeamId);
      for (const taskId of new Set(replay.cells.map((c) => c.taskId)))
        taskAccess(req.user, taskId, false, true);
      return res.json(replay);
    }
    if (d.format) {
      const team = teamAccess(req.user, d.format.teamId);
      return res.json(
        transaction(db, () => applyFormatting(db, req.user, d, team)),
      );
    }
    let eventTasks;
    const response = transaction(db, () => {
      const seen = new Set();
      for (const change of d.changes) {
        const ck = `${change.taskId}:${change.key}`;
        requireThat(
          !seen.has(ck),
          400,
          "한 작업에서 같은 셀을 중복 수정할 수 없습니다.",
        );
        seen.add(ck);
      }
      // 업무와 팀은 각각 한 번씩만 읽는다. 수천 셀 배치에서 업무마다 조회하지 않는다.
      const taskIds = [...new Set(d.changes.map((c) => c.taskId))];
      const tasks = new Map(
        getTasksById(db, taskIds)
          .filter((t) => !t.deletedAt)
          .map((t) => [t.id, t]),
      );
      eventTasks = tasks;
      requireThat(
        taskIds.every((taskId) => tasks.has(taskId)),
        404,
        "업무를 찾을 수 없습니다.",
      );
      const teams = new Map();
      for (const task of tasks.values()) {
        if (!teams.has(task.teamId))
          teams.set(task.teamId, teamAccess(req.user, task.teamId));
        requireThat(
          canEdit(req.user, task),
          403,
          "이 업무를 편집할 권한이 없습니다.",
        );
      }
      const before = [],
        after = [];
      const normalize = styleNormalizer();
      for (const change of d.changes) {
        const task = tasks.get(change.taskId),
          team = teams.get(task.teamId);
        if (
          change.value !== undefined &&
          ["owner", "supporters"].includes(change.key)
        )
          requireThat(
            canManageTeam(req.user, task.teamId),
            403,
            "담당자 변경은 팀장 권한이 필요합니다.",
          );
        const previous = task.cells[change.key] ?? {
          value: "",
          style: {},
          version: 0,
        };
        validateCellValue(
          db,
          task.teamId,
          change.key,
          change.value,
          team.settings,
          previous.value,
        );
        requireThat(
          previous.version === change.expectedVersion,
          409,
          "다른 사용자가 이 셀을 수정했습니다. 최신 내용을 확인한 뒤 다시 적용하세요.",
          {
            taskId: task.id,
            key: change.key,
            current: previous,
            attempted: change,
          },
        );
        const value =
          change.value === undefined ? previous.value : change.value;
        if (change.style !== undefined)
          requireThat(
            (change.expectedFormatRevision ?? 0) ===
              (task.formatting?.revision ?? 0),
            409,
            "공통 서식이 변경되었습니다. 최신 내용을 확인한 뒤 다시 적용하세요.",
          );
        const style =
          change.style === undefined
            ? previous.style
            : change.rawStyle
              ? change.style
              : task.formatting?.rules.length || task.rowStyle
                ? normalizeCellStyle(task, change.key, change.style)
                : normalize(change.style, task.defaultStyle);
        if (
          (value === previous.value ||
            (Array.isArray(value) &&
              Array.isArray(previous.value) &&
              value.length === previous.value.length &&
              value.every((v, i) => v === previous.value[i]))) &&
          sameStyle(style, previous.style)
        )
          continue;
        before.push({ taskId: task.id, key: change.key, ...previous });
        after.push({
          taskId: task.id,
          key: change.key,
          value,
          style,
          version: previous.version + 1,
        });
      }
      const put = upsertCellStatement(db);
      for (const c of after)
        put.run(c.taskId, c.key, c.value, c.style, c.version);
      pruneStyles(
        db,
        before.map((c) => c.style),
      );
      const updatedAt = touchTasks(db, [
        ...new Set(after.map((c) => tasks.get(c.taskId))),
      ]);
      const result = {
        cells: after,
        before,
        operationId: d.operationId,
        savedAt: now(),
        updatedAt,
        ...(tasks.size &&
        new Set([...tasks.values()].map((t) => t.teamId)).size === 1
          ? { formatRevision: [...tasks.values()][0].formatting?.revision ?? 0 }
          : {}),
      };
      storeCellOperation(db, req.user.id, result, tasks);
      return result;
    });
    // Publish only after COMMIT. A replayed operation returns above and cannot
    // emit twice. Cell records retain their versions/styles; no View is sent.
    const valueChanges = new Set(
      d.changes
        .filter((c) => c.value !== undefined)
        .map((c) => `${c.taskId}:${c.key}`),
    );
    cellEvents.publish(
      {
        ...response,
        cells: response.cells.filter((c) =>
          valueChanges.has(`${c.taskId}:${c.key}`),
        ),
      },
      eventTasks,
    );
    res.json(response);
  });
  app.patch("/api/tasks/:id", (req, res) => {
    const d = z
      .object({
        updatedAt: z.string(),
        years: z.array(yearSchema).min(1).max(101).optional(),
        position: z.number().finite().optional(),
      })
      .parse(req.body);
    const task = taskAccess(req.user, req.params.id, true);
    requireThat(
      d.updatedAt === task.updatedAt,
      409,
      "업무가 변경되었습니다. 새로고침 후 다시 시도하세요.",
    );
    const updated = transaction(db, () => {
      db.prepare(
        "UPDATE tasks SET years=?,position=?,updated_at=? WHERE id=?",
      ).run(
        json(d.years || task.years),
        d.position ?? task.position,
        nextTaskStamp(task.updatedAt),
        task.id,
      );
      const after = getTask(db, task.id);
      audit(
        db,
        req.user.id,
        task.teamId,
        "task",
        task.id,
        taskAuditSnapshot(task),
        taskAuditSnapshot(after),
      );
      return after;
    });
    res.json({ task: updated });
  });
  const taskVersionsSchema = z.object({
    tasks: z
      .array(
        z.object({
          id: z.string().uuid(),
          updatedAt: z.string().datetime(),
        }),
      )
      .min(1)
      .max(20000)
      .refine((tasks) => new Set(tasks.map((t) => t.id)).size === tasks.length),
  });
  function deleteTaskRows(user, versions) {
    return transaction(db, () => {
      const tasks = versions.map(({ id, updatedAt }) => {
        const task = taskAccess(user, id, true);
        requireThat(
          updatedAt === task.updatedAt,
          409,
          "업무가 변경되었습니다. 확인 후 다시 삭제하세요.",
        );
        return task;
      });
      requireThat(
        tasks.every((t) => t.teamId === tasks[0].teamId),
        400,
        "같은 시트의 업무를 선택하세요.",
      );
      const updatedAt = {};
      for (const task of tasks) {
        updatedAt[task.id] = nextTaskStamp(task.updatedAt);
        const deletedAt = now();
        db.prepare("UPDATE tasks SET deleted_at=?,updated_at=? WHERE id=?").run(
          deletedAt,
          updatedAt[task.id],
          task.id,
        );
        audit(
          db,
          user.id,
          task.teamId,
          "delete",
          task.id,
          taskAuditSnapshot(task),
          { deletedAt, updatedAt: updatedAt[task.id] },
        );
      }
      return { ok: true, updatedAt };
    });
  }
  function restoreTaskRows(user, versions) {
    return transaction(db, () => {
      const tasks = versions.map(({ id, updatedAt }) => {
        const task = taskAccess(user, id, false, true);
        requireThat(
          canManageTeam(user, task.teamId) || canEdit(user, task),
          403,
          "업무를 복구할 권한이 없습니다.",
        );
        requireThat(
          task.deletedAt &&
            (updatedAt === undefined || updatedAt === task.updatedAt),
          409,
          "이후 변경이 있어 되돌릴 수 없습니다. 변경 이력에서 확인하세요.",
        );
        return task;
      });
      requireThat(
        tasks.every((t) => t.teamId === tasks[0].teamId),
        400,
        "같은 시트의 업무를 선택하세요.",
      );
      for (const task of tasks) {
        db.prepare(
          "UPDATE tasks SET deleted_at=NULL,updated_at=? WHERE id=?",
        ).run(nextTaskStamp(task.updatedAt), task.id);
        audit(db, user.id, task.teamId, "restore", task.id, undefined, {
          restored: true,
        });
      }
      return { tasks: tasks.map((task) => getTask(db, task.id)) };
    });
  }
  app.post("/api/tasks/delete", (req, res) => {
    res.json(
      deleteTaskRows(req.user, taskVersionsSchema.parse(req.body).tasks),
    );
  });
  app.post("/api/tasks/restore", (req, res) => {
    res.json(
      restoreTaskRows(req.user, taskVersionsSchema.parse(req.body).tasks),
    );
  });
  app.delete("/api/tasks/:id", (req, res) => {
    const result = deleteTaskRows(req.user, [
      { id: req.params.id, updatedAt: req.body.updatedAt },
    ]);
    res.json({ ok: true, updatedAt: result.updatedAt[req.params.id] });
  });
  app.post("/api/tasks/:id/restore", (req, res) => {
    const { updatedAt } = z
      .object({ updatedAt: z.string().datetime().optional() })
      .parse(req.body ?? {});
    const result = restoreTaskRows(req.user, [
      { id: req.params.id, updatedAt },
    ]);
    res.json({ task: result.tasks[0] });
  });
  app.get("/api/views", (req, res) => {
    const teamId = String(req.query.teamId);
    const team = teamAccess(req.user, teamId);
    const year = yearSchema.parse(req.query.year);
    res.json({
      views: db
        .prepare(
          "SELECT * FROM views WHERE user_id=? AND team_id=? AND name='__current' AND year=?",
        )
        .all(req.user.id, teamId, year)
        .map((v) => ({
          id: v.id,
          name: v.name,
          data: viewLayout(normalizeView(parse(v.data), team.settings)),
          updatedAt: v.updated_at,
        })),
    });
  });
  app.put("/api/views", (req, res) => {
    const d = z
      .object({
        teamId: z.string().uuid(),
        name: z.literal("__current"),
        data: viewSchema,
      })
      .parse(req.body);
    const team = teamAccess(req.user, d.teamId);
    const keys = fieldsFor(team.settings).map((f) => f.key);
    requireThat(
      (d.data.visibleFields || []).every((k) => keys.includes(k)),
      400,
      "이 팀의 표시 열을 선택하세요.",
    );
    requireThat(
      !d.data.groupBy ||
        propertiesFor(team.settings).some((p) => p.id === d.data.groupBy),
      400,
      "이 팀의 묶음 속성을 선택하세요.",
    );
    requireThat(
      [
        ...Object.keys(d.data.propertyFilters || {}),
        ...Object.keys(d.data.propertyFilterModes || {}),
      ].every((key) => propertiesFor(team.settings).some((p) => p.id === key)),
      400,
      "이 팀의 속성 필터를 선택하세요.",
    );
    db.prepare(
      "INSERT INTO views VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,team_id,year,name) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
    ).run(
      id(),
      req.user.id,
      d.teamId,
      d.data.year,
      d.name,
      json(viewLayout(d.data)),
      now(),
    );
    res.json({ ok: true });
  });
  installFilterRoutes(app, { db, teamAccess });
  installReportEditingRoutes(app, { db, teamAccess, documentImagesDir });
  app.get("/api/reports", (req, res) => {
    const teamId = String(req.query.teamId);
    teamAccess(req.user, teamId);
    res.json({
      reports: db
        .prepare(
          "SELECT r.id,r.name,r.year,r.reference_date AS referenceDate,r.created_at AS createdAt,u.name AS author FROM reports r JOIN users u ON r.created_by=u.id WHERE r.team_id=? ORDER BY r.created_at DESC",
        )
        .all(teamId),
    });
  });
  app.post("/api/reports", (req, res) => {
    const d = z
      .object({
        id: z.string().uuid().optional(),
        teamId: z.string().uuid(),
        year: yearSchema,
        name: reportNameSchema,
        sourceId: z.string().uuid().optional(),
        referenceDate: dateSchema,
        view: viewSchema,
        taskIds: z.array(z.string().uuid()).max(20000),
      })
      .parse(req.body);
    const team = teamAccess(req.user, d.teamId);
    requireThat(
      canContribute(req.user, d.teamId),
      403,
      "사본을 만들 권한이 없습니다.",
    );
    const reportId = d.id || id();
    const requestHash = createHash("sha256")
      .update(JSON.stringify(d))
      .digest("hex");
    const replay = () => {
      const existing = db
        .prepare("SELECT * FROM reports WHERE id=?")
        .get(reportId);
      if (existing) {
        const last = db
          .prepare(
            "SELECT after_json FROM audit WHERE action='report' AND target=? AND actor_id=?",
          )
          .get(reportId, req.user.id);
        requireThat(
          existing.team_id === d.teamId &&
            existing.created_by === req.user.id &&
            parse(last?.after_json)?.requestHash === requestHash,
          409,
          "사본 생성 요청이 변경되었습니다. 새 이름으로 다시 시도하세요.",
        );
        return true;
      }
      return false;
    };
    if (replay()) return res.status(201).json({ id: reportId });
    requireThat(
      d.view.year === d.year,
      400,
      "보고 연도와 보기의 연도가 일치해야 합니다.",
    );
    const selected = new Set(d.sourceId ? [] : d.taskIds),
      tasks = getTasks(
        db,
        d.teamId,
        periodYears(d.year, d.view.startMonth),
      ).filter((t) => selected.has(t.id));
    requireThat(
      tasks.length === selected.size,
      409,
      "일부 업무가 변경 또는 삭제되었습니다. 새로고침 후 다시 저장하세요.",
    );
    const source = d.sourceId
      ? db
          .prepare("SELECT * FROM reports WHERE id=? AND team_id=?")
          .get(d.sourceId, d.teamId)
      : null;
    requireThat(!d.sourceId || source, 404, "사본을 찾을 수 없습니다.");
    const data = source
      ? readReport(db, source)
      : {
          tasks: withTaskDocumentReferences(db, tasks),
          users: referencedUsers(d.teamId),
          view: d.view,
          settings: team.settings,
        };
    transaction(db, () => {
      if (replay()) return;
      requireUniqueReportName(db, d.teamId, d.name);
      db.prepare("INSERT INTO reports VALUES(?,?,?,?,?,?,?,?)").run(
        reportId,
        d.teamId,
        source ? source.year : d.year,
        d.name,
        d.referenceDate,
        req.user.id,
        now(),
        encodeReport(data),
      );
      syncReportDocuments(db, reportId, data.tasks);
      audit(db, req.user.id, d.teamId, "report", reportId, undefined, {
        name: d.name,
        count: data.tasks.length,
        requestHash,
      });
    });
    res.status(201).json({ id: reportId });
  });
  app.patch("/api/reports/:id/name", (req, res) => {
    const data = z
      .object({ name: reportNameSchema, expectedName: z.string().max(120) })
      .strict()
      .parse(req.body);
    res.json(
      transaction(db, () => {
        const row = db
          .prepare("SELECT * FROM reports WHERE id=?")
          .get(req.params.id);
        requireThat(row, 404, "사본을 찾을 수 없습니다.");
        teamAccess(req.user, row.team_id);
        requireThat(
          canContribute(req.user, row.team_id),
          403,
          "사본 이름을 바꿀 권한이 없습니다.",
        );
        requireThat(
          row.name === data.expectedName || row.name === data.name,
          409,
          "사본 이름이 변경되었습니다. 목록을 다시 불러오세요.",
        );
        if (row.name !== data.name)
          requireUniqueReportName(db, row.team_id, data.name);
        db.prepare("UPDATE reports SET name=? WHERE id=?").run(
          data.name,
          row.id,
        );
        audit(
          db,
          req.user.id,
          row.team_id,
          "report-rename",
          row.id,
          { name: row.name },
          { name: data.name },
        );
        return { id: row.id, name: data.name };
      }),
    );
  });
  app.get("/api/reports/:id", (req, res) => {
    const r = db.prepare("SELECT * FROM reports WHERE id=?").get(req.params.id);
    requireThat(r, 404, "사본을 찾을 수 없습니다.");
    teamAccess(req.user, r.team_id);
    res.json(reportResponse(db, r));
  });
  app.delete("/api/reports", (req, res) => {
    const d = z
      .object({
        teamId: z.string().uuid(),
        ids: z.array(z.string().uuid()).min(1).max(20000),
      })
      .strict()
      .parse(req.body);
    teamAccess(req.user, d.teamId);
    requireThat(
      canContribute(req.user, d.teamId),
      403,
      "사본을 삭제할 권한이 없습니다.",
    );
    const ids = [...new Set(d.ids)];
    transaction(db, () => {
      const rows = db
        .prepare(
          `SELECT id,name,reference_date AS referenceDate FROM reports WHERE team_id=? AND id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(d.teamId, ...ids);
      requireThat(
        rows.length === ids.length,
        404,
        "일부 사본을 찾을 수 없습니다. 목록을 새로 열어 확인하세요.",
      );
      const remove = db.prepare("DELETE FROM reports WHERE id=? AND team_id=?");
      for (const row of rows) {
        remove.run(row.id, d.teamId);
        audit(db, req.user.id, d.teamId, "report-delete", row.id, {
          name: row.name,
          referenceDate: row.referenceDate,
        });
      }
      pruneDocumentVersions(db, d.teamId);
    });
    res.json({ ok: true });
  });
  app.get("/api/audit", (req, res) => {
    const teamId = String(req.query.teamId);
    teamAccess(req.user, teamId);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(req.query.limit || 100);
    const taskId = req.query.taskId
      ? z.string().uuid().parse(req.query.taskId)
      : null;
    const sheetId =
      req.query.sheetId === undefined
        ? null
        : z
            .union([z.literal("original"), z.string().uuid()])
            .parse(req.query.sheetId);
    if (sheetId && sheetId !== "original")
      requireThat(
        db
          .prepare("SELECT id FROM reports WHERE id=? AND team_id=?")
          .get(sheetId, teamId),
        404,
        "사본을 찾을 수 없습니다.",
      );
    if (taskId && (!sheetId || sheetId === "original"))
      requireThat(
        taskAccess(req.user, taskId, false, true).teamId === teamId,
        403,
        "같은 팀의 업무를 선택하세요.",
      );
    const rows = db
      .prepare(
        `SELECT a.*,u.name AS actor, ${auditSheetSql} AS report_id FROM audit a JOIN users u ON a.actor_id=u.id WHERE a.team_id=?
          AND (? IS NULL OR COALESCE(${auditSheetSql},'original')=?)
          AND (? IS NULL OR a.target=? OR EXISTS(SELECT 1 FROM json_each(CASE WHEN a.action='cells' THEN COALESCE(json_extract(a.after_json,'$.$data'),a.after_json) ELSE '[]' END) c WHERE json_extract(c.value,'$.taskId')=?) OR (a.action='format' AND EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(a.after_json,'$.$data.taskIds'),json_extract(a.after_json,'$.taskIds'),'[]')) t WHERE t.value=?))) ORDER BY a.created_at DESC,a.rowid DESC LIMIT ?`,
      )
      .all(teamId, sheetId, sheetId, taskId, taskId, taskId, taskId, limit);
    const reports = new Map();
    const reportSnapshots = new Map();
    for (const row of rows) {
      if (!row.report_id || reports.has(row.report_id)) continue;
      reports.set(
        row.report_id,
        db
          .prepare("SELECT * FROM reports WHERE id=? AND team_id=?")
          .get(row.report_id, teamId),
      );
    }
    res.json({
      entries: rows.map((r) => {
        const before = parse(r.before_json),
          after = parse(r.after_json);
        const report = reports.get(r.report_id);
        if (before?.deletedTasks && report && !reportSnapshots.has(report.id))
          reportSnapshots.set(report.id, decodeReport(report.data));
        const task =
          r.action === "delete" &&
          db
            .prepare("SELECT deleted_at AS deletedAt FROM tasks WHERE id=?")
            .get(r.target);
        const latestDeletion =
          task?.deletedAt &&
          db
            .prepare(
              "SELECT id FROM audit WHERE team_id=? AND action='delete' AND target=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
            )
            .get(teamId, r.target);
        return {
          id: r.id,
          actor: r.actor,
          actorId: r.actor_id,
          action: r.action,
          target: r.target,
          before,
          after,
          sheet: {
            id: r.report_id || "original",
            name: r.report_id
              ? report?.name || after?.name || before?.name || "삭제된 사본"
              : "원본",
          },
          restorableTaskIds:
            r.action === "delete" && latestDeletion?.id === r.id
              ? [r.target]
              : r.action === "report-edit" && before?.deletedTasks && report
                ? deletedReportTasks(db, r, reportSnapshots.get(report.id)).map(
                    (t) => t.id,
                  )
                : [],
          createdAt: r.created_at,
        };
      }),
    });
  });
  app.post("/api/audit/:id/restore", (req, res) => {
    const entry = db
      .prepare("SELECT * FROM audit WHERE id=?")
      .get(req.params.id);
    requireThat(entry, 404, "이력을 찾을 수 없습니다.");
    if (entry.action === "report-edit") {
      teamAccess(req.user, entry.team_id);
      return res.json(
        restoreReportTasks(db, req.user, entry, req.body.revision),
      );
    }
    const team = managedTeam(
      req.user,
      entry.team_id,
      "팀장만 이전 내용을 복원할 수 있습니다.",
    );
    if (entry.action === "delete") {
      const latest = db
        .prepare(
          "SELECT id FROM audit WHERE team_id=? AND action='delete' AND target=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .get(entry.team_id, entry.target);
      requireThat(
        latest?.id === entry.id,
        409,
        "이후 삭제 이력이 있습니다. 최신 이력에서 복구하세요.",
      );
      const task = taskAccess(req.user, entry.target, false, true);
      return res.json(
        restoreTaskRows(req.user, [
          {
            id: task.id,
            updatedAt: parse(entry.after_json)?.updatedAt || task.updatedAt,
          },
        ]),
      );
    }
    if (entry.action === "format") {
      const expectedRevision = z
        .number()
        .int()
        .nonnegative()
        .parse(req.body.formatRevision);
      const expectedCells = z
        .record(z.string(), z.number().int().nonnegative())
        .parse(req.body.versions);
      const request = {
        operationId: id(),
        createdAt: now(),
        format: {
          teamId: entry.team_id,
          expectedRevision,
          restore: entry.target,
          expectedCells,
        },
      };
      return res.json(
        transaction(db, () =>
          applyFormatting(db, req.user, request, team, entry),
        ),
      );
    }
    requireThat(
      entry.action === "cells",
      400,
      "셀 변경 이력만 이 화면에서 복원할 수 있습니다.",
    );
    const expected = z
      .record(z.string(), z.number().int())
      .parse(req.body.versions);
    const before = parse(entry.before_json, []);
    const restored = transaction(db, () => {
      const prev = [],
        after = [],
        tasks = new Map();
      for (const c of before) {
        if (!tasks.has(c.taskId))
          tasks.set(c.taskId, taskAccess(req.user, c.taskId, true));
        const task = tasks.get(c.taskId);
        const current = task.cells[c.key] ?? {
          value: "",
          style: {},
          version: 0,
        };
        requireThat(
          expected[`${c.taskId}:${c.key}`] === current.version,
          409,
          "복구 대상이 변경되었습니다. 최신 이력을 다시 확인하세요.",
        );
        prev.push({ taskId: c.taskId, key: c.key, ...current });
        after.push({
          ...c,
          version: current.version + 1,
        });
      }
      const put = upsertCellStatement(db);
      for (const c of after)
        put.run(c.taskId, c.key, c.value, c.style, c.version);
      pruneStyles(
        db,
        prev.map((c) => c.style),
      );
      touchTasks(db, [...tasks.values()]);
      audit(db, req.user.id, entry.team_id, "cells", id(), prev, after);
      return after;
    });
    res.json({ cells: restored });
  });
  app.patch("/api/teams/:id/settings", (req, res) => {
    const team = managedTeam(req.user, req.params.id);
    const settings = saveSettings(db, team, req.body, req.user.id);
    res.json({ settings });
  });
  app.get("/api/admin/users", (req, res) => {
    requireSystemAdmin(req.user);
    res.json({
      users: usersWithTeams(
        db,
        db.prepare("SELECT * FROM users ORDER BY created_at").all(),
      ),
      teams: db
        .prepare("SELECT * FROM teams ORDER BY name")
        .all()
        .map((t) => ({ ...t, settings: teamSettings(t) })),
    });
  });
  function setUserMemberships(userId, memberships) {
    for (const m of memberships)
      requireThat(
        db.prepare("SELECT id FROM teams WHERE id=?").get(m.teamId),
        400,
        "팀을 확인하세요.",
      );
    replaceUserMemberships(db, userId, memberships);
  }
  app.post("/api/admin/users", (req, res) => {
    requireSystemAdmin(req.user);
    const d = credentials
      .extend({
        name: string(50),
        ...profileFields,
        active: z.boolean().default(true),
        systemRole: systemRoles.default("user"),
        memberships: userMembershipRowsSchema.default([]),
      })
      .parse(req.body);
    const userId = id();
    transaction(db, () => {
      requireThat(
        !db
          .prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE")
          .get(d.username),
        409,
        "이미 사용 중인 아이디(이메일)입니다.",
      );
      db.prepare(
        "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        userId,
        d.username,
        d.name,
        passwordHash(d.password),
        d.systemRole,
        now(),
      );
      db.prepare(
        "UPDATE users SET active=?,color=?,avatar_initials=?,avatar_image=? WHERE id=?",
      ).run(
        d.active ? 1 : 0,
        d.color || "#177b70",
        d.avatarInitials || "",
        d.avatarImage || "",
        userId,
      );
      setUserMemberships(userId, d.memberships);
      audit(db, req.user.id, null, "user-create", userId, undefined, {
        name: d.name,
        systemRole: d.systemRole,
        memberships: d.memberships,
      });
    });
    res.status(201).json({
      user: userWithTeams(
        db,
        db.prepare("SELECT * FROM users WHERE id=?").get(userId),
      ),
    });
  });
  app.patch("/api/admin/users/:id", (req, res) => {
    requireSystemAdmin(req.user);
    const d = z
      .object({
        name: string(50),
        ...profileFields,
        // 생략한 시스템 권한·팀 소속은 그대로 둔다.
        systemRole: systemRoles.optional(),
        active: z.boolean(),
        memberships: userMembershipRowsSchema.optional(),
        // 생략하면 아이디를 유지한다. 기존 비이메일 아이디도 이메일로 바꿀 수 있다.
        username: loginId.optional(),
        password: credentials.shape.password.optional(),
      })
      .parse(req.body);
    const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
    requireThat(u, 404, "사용자를 찾을 수 없습니다.");
    const before = userWithTeams(db, u);
    const systemRole = d.systemRole ?? before.systemRole;
    transaction(db, () => {
      if (
        u.active &&
        u.system_role === "admin" &&
        (!d.active || systemRole !== "admin")
      )
        requireThat(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM users WHERE system_role='admin' AND active=1",
            )
            .get().n > 1,
          400,
          "마지막 시스템 관리자는 해제할 수 없습니다.",
        );
      if (d.username && d.username !== u.username.toLowerCase()) {
        requireThat(
          !db
            .prepare(
              "SELECT id FROM users WHERE username=? COLLATE NOCASE AND id<>?",
            )
            .get(d.username, u.id),
          409,
          "이미 사용 중인 아이디(이메일)입니다.",
        );
        db.prepare("UPDATE users SET username=? WHERE id=?").run(
          d.username,
          u.id,
        );
      }
      db.prepare(
        "UPDATE users SET name=?,system_role=?,active=?,password=?,color=?,avatar_initials=?,avatar_image=? WHERE id=?",
      ).run(
        d.name,
        systemRole,
        d.active ? 1 : 0,
        d.password ? passwordHash(d.password) : u.password,
        d.color ?? u.color,
        d.avatarInitials ?? u.avatar_initials,
        d.avatarImage ?? u.avatar_image,
        u.id,
      );
      if (d.memberships) setUserMemberships(u.id, d.memberships);
      if (!d.active || d.password)
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
      audit(
        db,
        req.user.id,
        null,
        "user-update",
        u.id,
        {
          username: before.username,
          name: before.name,
          systemRole: before.systemRole,
          active: before.active,
          teamRoles: before.teamRoles,
        },
        {
          username: d.username ?? before.username,
          name: d.name,
          systemRole,
          active: d.active,
          teamRoles: d.memberships
            ? Object.fromEntries(d.memberships.map((m) => [m.teamId, m.role]))
            : before.teamRoles,
        },
      );
    });
    res.json({ ok: true });
  });
  function teamMembers(teamId) {
    return db
      .prepare(
        "SELECT user_id AS userId,role FROM memberships WHERE team_id=? ORDER BY rowid",
      )
      .all(teamId);
  }
  function setTeamMembers(teamId, members) {
    const current = new Set(teamMembers(teamId).map((m) => m.userId));
    for (const m of members) {
      const u = db.prepare("SELECT active FROM users WHERE id=?").get(m.userId);
      requireThat(u, 400, "등록된 사용자를 선택하세요.");
      // 이미 소속된 비활성 사용자는 남겨 둘 수 있지만 새로 추가할 수는 없다.
      requireThat(
        u.active || current.has(m.userId),
        400,
        "비활성 사용자는 팀에 추가할 수 없습니다.",
      );
    }
    replaceTeamMembers(db, teamId, members);
  }
  app.get("/api/teams/:id/members", (req, res) => {
    const team = managedTeam(req.user, req.params.id);
    // 팀장은 기존 사용자를 팀에 추가할 수 있으므로 전체 사용자 목록이 필요하다.
    // 다른 팀 소속이나 시스템 권한은 시스템 관리자 화면에서만 보여 준다.
    res.json({
      members: teamMembers(team.id),
      users: db
        .prepare("SELECT * FROM users ORDER BY name")
        .all()
        .map((u) => ({
          id: u.id,
          username: u.username,
          name: u.name,
          active: !!u.active,
          color: u.color,
          avatarInitials: u.avatar_initials || "",
          avatarImage: u.avatar_image || "",
        })),
    });
  });
  app.put("/api/teams/:id/members", (req, res) => {
    const team = managedTeam(req.user, req.params.id);
    const d = z
      .object({
        members: teamMemberRowsSchema,
        // 화면이 보고 있던 목록. 그 사이 다른 사람이 바꿨으면 덮어쓰지 않는다.
        previous: teamMemberRowsSchema.optional(),
      })
      .strict()
      .parse(req.body);
    const key = (list) =>
      list
        .map((m) => `${m.userId}:${m.role}`)
        .sort()
        .join(",");
    transaction(db, () => {
      const before = teamMembers(team.id);
      requireThat(
        !d.previous || key(d.previous) === key(before),
        409,
        "다른 사용자가 구성원을 변경했습니다. 최신 목록을 확인한 뒤 다시 시도하세요.",
      );
      setTeamMembers(team.id, d.members);
      audit(
        db,
        req.user.id,
        team.id,
        "team-members",
        team.id,
        before,
        d.members,
      );
    });
    res.json({ members: teamMembers(team.id) });
  });
  const teamSchema = z.object({
    name: string(80),
    theme: z.enum(THEME_IDS).optional(),
  });
  app.post("/api/admin/teams", (req, res) => {
    requireSystemAdmin(req.user);
    const d = teamSchema
      .extend({
        templateTeamId: z.string().uuid().optional(),
        members: teamMemberRowsSchema.default([]),
      })
      .parse(req.body);
    const teamId = id();
    const template = d.templateTeamId
      ? db
          .prepare("SELECT settings FROM teams WHERE id=?")
          .get(d.templateTeamId)
      : null;
    requireThat(
      !d.templateTeamId || template,
      404,
      "복사할 팀 양식을 찾을 수 없습니다.",
    );
    const initialSettings = template
      ? teamSettings(template)
      : DEFAULT_SETTINGS;
    transaction(db, () => {
      db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
        teamId,
        d.name,
        json({
          ...initialSettings,
          theme: d.theme ?? initialSettings.theme,
          revision: 0,
        }),
      );
      setTeamMembers(teamId, d.members);
      audit(db, req.user.id, teamId, "team-create", teamId, undefined, d);
    });
    res.status(201).json({ id: teamId });
  });
  app.patch("/api/teams/:id", (req, res) => {
    const team = managedTeam(req.user, req.params.id);
    const d = teamSchema
      .extend({ settingsRevision: z.number().int().nonnegative().optional() })
      .parse(req.body);
    const settings = team.settings;
    const themeChanged = d.theme !== undefined && d.theme !== settings.theme;
    if (themeChanged && d.settingsRevision !== undefined)
      requireThat(
        d.settingsRevision === (settings.revision || 0),
        409,
        "팀 설정이 변경되었습니다. 관리 화면을 다시 열어 최신 설정을 확인하세요.",
      );
    transaction(db, () => {
      db.prepare("UPDATE teams SET name=? WHERE id=?").run(d.name, team.id);
      if (themeChanged)
        db.prepare("UPDATE teams SET settings=? WHERE id=?").run(
          json({
            ...settings,
            theme: d.theme,
            revision: (settings.revision || 0) + 1,
          }),
          team.id,
        );
      audit(
        db,
        req.user.id,
        team.id,
        "team-update",
        team.id,
        { id: team.id, name: team.name, theme: settings.theme },
        { ...d, theme: d.theme ?? settings.theme },
      );
    });
    res.json({ ok: true });
  });
  app.delete("/api/admin/teams/:id", (req, res) => {
    requireSystemAdmin(req.user);
    const teamId = z.string().uuid().parse(req.params.id);
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    const result = deleteTeam(db, teamId, req.user.id);
    removeTeamDocumentImages(documentImagesDir, teamId);
    cachedTasks.clearTeam(teamId);
    res.json(result);
  });
  installTransferRoutes(app, {
    db,
    teamAccess,
    managedTeam,
    assignableUsers,
    referencedUsers,
    documentImagesDir,
  });
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
