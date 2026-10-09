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
  openDatabase,
  id,
  now,
  nextTaskStamp,
  json,
  parse,
  passwordHash,
  passwordMatches,
  userInfo,
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
  batchSchema,
  yearSchema,
  dateSchema,
  viewSchema,
  validateCellValue,
} from "./validation.mjs";
import {
  DEFAULT_SETTINGS,
  canEdit,
  cell,
  defaultView,
  todayKey,
  normalizeSettings,
  normalizeView,
  fieldsFor,
  propertiesFor,
  emptyPropertyValue,
  propertyValue,
} from "../shared/domain.js";
import { installTransferRoutes } from "./transfer.mjs";
import { saveSettings } from "./settings.mjs";
import { createTaskCache } from "./task-cache.mjs";
import { installReorderRoute } from "./reorder.mjs";
import { deleteTeam } from "./team-deletion.mjs";

const string = (max = 100) => z.string().trim().min(1).max(max);
const credentials = z.object({
  username: string(60).regex(/^[a-zA-Z0-9_.@-]+$/),
  password: z.string().min(10).max(128),
});
const roles = z.enum(["admin", "manager", "member", "viewer"]);
const sessionHash = (t) => createHash("sha256").update(t).digest("hex");
const admin = (u) => u.role === "admin";
const manager = (u) => ["admin", "manager"].includes(u.role);
export function createApp({
  db = openDatabase(),
  staticDir = resolve("dist"),
  allowSetup = true,
  rateLimits = true,
} = {}) {
  const app = express();
  const cachedTasks = createTaskCache(db);
  app.locals.db = db;
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
  app.use(compression());
  app.use(cookieParser());
  app.use(express.json({ limit: "5mb" }));
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
            ? normalizeSettings({
                ...DEFAULT_SETTINGS,
                propertiesVersion: 1,
                properties: [],
              })
            : DEFAULT_SETTINGS,
        ),
      );
      db.prepare(
        "INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        userId,
        data.username,
        data.name,
        passwordHash(data.password),
        "admin",
        now(),
      );
      db.prepare("INSERT INTO memberships VALUES(?,?)").run(userId, teamId);
      const user = userInfo(
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
      .object({ username: string(60), password: z.string().min(1).max(128) })
      .parse(req.body);
    const u = db
      .prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE")
      .get(username);
    const fallback = "00000000000000000000000000000000:" + "00".repeat(64);
    const valid = passwordMatches(password, u?.password || fallback);
    requireThat(
      u && u.active && valid,
      401,
      "아이디 또는 비밀번호가 올바르지 않습니다.",
    );
    issueSession(res, u.id);
    res.json({ user: userInfo(db, u) });
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
    req.user = userInfo(db, u);
    next();
  });
  function teamAccess(user, teamId) {
    requireThat(
      user.teamIds.includes(teamId),
      403,
      "이 팀에 접근할 권한이 없습니다.",
    );
    const t = db.prepare("SELECT * FROM teams WHERE id=?").get(teamId);
    requireThat(t, 404, "팀을 찾을 수 없습니다.");
    return {
      ...t,
      settings: normalizeSettings(parse(t.settings, DEFAULT_SETTINGS)),
    };
  }
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
  function teamPeople(teamId) {
    return db
      .prepare(
        "SELECT u.* FROM users u JOIN memberships m ON u.id=m.user_id WHERE m.team_id=? ORDER BY u.name",
      )
      .all(teamId)
      .map((u) => userInfo(db, u));
  }
  const context = { db, teamAccess, taskAccess, teamPeople, manager };
  installReorderRoute(app, context);
  app.post("/api/auth/logout", (req, res) => {
    db.prepare("DELETE FROM sessions WHERE token=?").run(
      sessionHash(req.cookies.weekly_session),
    );
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
  app.get("/api/bootstrap", (req, res) => {
    const teams = req.user.teamIds.map((t) => teamAccess(req.user, t));
    const people = new Map();
    teams.forEach((t) => teamPeople(t.id).forEach((u) => people.set(u.id, u)));
    const years = new Set([Number(todayKey().slice(0, 4))]);
    for (const team of teams)
      for (const t of db
        .prepare("SELECT DISTINCT years FROM tasks WHERE team_id=?")
        .all(team.id))
        parse(t.years, []).forEach((y) => years.add(y));
    res.json({
      user: req.user,
      teams,
      users: [...people.values()],
      years: [...years].sort((a, b) => b - a),
    });
  });
  app.get("/api/tasks", (req, res) => {
    const teamId = String(req.query.teamId || "");
    teamAccess(req.user, teamId);
    const year = yearSchema.parse(req.query.year);
    const deleted = req.query.deleted === "1";
    if (deleted)
      requireThat(manager(req.user), 403, "관리자만 휴지통을 볼 수 있습니다.");
    const cached = cachedTasks(teamId, year, deleted);
    res.set("ETag", cached.etag);
    res.vary("Accept-Encoding");
    if (req.get("If-None-Match") === cached.etag) return res.status(304).end();
    res.type("application/json");
    if (req.acceptsEncodings("gzip")) {
      res.set("Content-Encoding", "gzip");
      return res.send(cached.gzip);
    }
    res.send(cached.body);
  });
  app.post("/api/tasks", (req, res) => {
    const d = z
      .object({
        teamId: z.string().uuid(),
        year: yearSchema,
        fields: z.record(z.string(), z.any()).default({}),
        sourceId: z.string().uuid().optional(),
      })
      .parse(req.body);
    const team = teamAccess(req.user, d.teamId);
    requireThat(req.user.role !== "viewer", 403, "등록 권한이 없습니다.");
    const fields = {
      owner: req.user.id,
      supporters: [],
      ...Object.fromEntries(
        propertiesFor(team.settings)
          .map((p) => [
            p.id,
            p.id === "title"
              ? "새 업무"
              : p.id === "owner"
                ? req.user.id
                : p.id === "supporters"
                  ? []
                  : ["category", "type", "status"].includes(p.id) &&
                      p.kind === "option"
                    ? p.values.find((v) => !v.archived)
                      ? propertyValue(
                          p,
                          p.values.find((v) => !v.archived),
                        )
                      : ""
                    : emptyPropertyValue(p),
          ])
          .filter(([, v]) => v !== "" && (!Array.isArray(v) || v.length > 0)),
      ),
      ...d.fields,
    };
    let cells = {},
      defaultStyle = team.settings.defaultStyle;
    if (d.sourceId) {
      const source = taskAccess(req.user, d.sourceId);
      requireThat(
        source.teamId === d.teamId,
        400,
        "같은 팀의 업무만 복제할 수 있습니다.",
      );
      cells = source.cells;
      defaultStyle = source.defaultStyle;
      for (const k of new Set([
        "owner",
        "supporters",
        ...Object.keys(d.fields),
      ]))
        cells = {
          ...cells,
          [k]: { value: fields[k], style: cells[k]?.style || {} },
        };
    }
    for (const [k, v] of Object.entries(fields))
      validateCellValue(db, d.teamId, k, v, team.settings);
    if (!manager(req.user))
      requireThat(
        fields.owner === req.user.id,
        403,
        "본인 책임 업무로 등록하세요.",
      );
    const task = transaction(db, () => {
      const t = insertTask(db, {
        teamId: d.teamId,
        year: d.year,
        actorId: req.user.id,
        fields,
        cells,
        defaultStyle,
      });
      audit(db, req.user.id, d.teamId, "create", t.id, undefined, t);
      return t;
    });
    res.status(201).json({ task });
  });
  app.post("/api/cells/batch", (req, res) => {
    const d = batchSchema.parse(req.body);
    const old = db
      .prepare("SELECT * FROM operations WHERE id=?")
      .get(d.operationId);
    if (old) {
      requireThat(
        old.actor_id === req.user.id,
        403,
        "다른 사용자의 작업입니다.",
      );
      const replay = parse(old.response);
      for (const taskId of new Set(replay.cells.map((c) => c.taskId)))
        taskAccess(req.user, taskId, false, true);
      return res.json(replay);
    }
    const response = transaction(db, () => {
      const seen = new Set(),
        before = [],
        after = [];
      const taskCache = new Map(),
        teamCache = new Map();
      for (const change of d.changes) {
        const ck = `${change.taskId}:${change.key}`;
        requireThat(
          !seen.has(ck),
          400,
          "한 작업에서 같은 셀을 중복 수정할 수 없습니다.",
        );
        seen.add(ck);
        let task = taskCache.get(change.taskId);
        if (!task) {
          task = taskAccess(req.user, change.taskId, true);
          taskCache.set(task.id, task);
        }
        let team = teamCache.get(task.teamId);
        if (!team) {
          team = teamAccess(req.user, task.teamId);
          teamCache.set(team.id, team);
        }
        if (
          change.value !== undefined &&
          ["owner", "supporters"].includes(change.key)
        )
          requireThat(
            manager(req.user),
            403,
            "담당자 변경은 팀 관리자 권한이 필요합니다.",
          );
        validateCellValue(
          db,
          task.teamId,
          change.key,
          change.value,
          team.settings,
        );
        const previous = cell(task, change.key);
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
        before.push({ taskId: task.id, key: change.key, ...previous });
        after.push({
          taskId: task.id,
          key: change.key,
          value: change.value === undefined ? previous.value : change.value,
          style: change.style === undefined ? previous.style : change.style,
          version: previous.version + 1,
        });
      }
      const put = db.prepare(
        "INSERT INTO cells(task_id,key,value,style,version) VALUES(?,?,?,?,?) ON CONFLICT(task_id,key) DO UPDATE SET value=excluded.value,style=excluded.style,version=excluded.version",
      );
      for (const c of after)
        put.run(c.taskId, c.key, json(c.value), json(c.style), c.version);
      const updatedAt = {};
      for (const t of taskCache.values()) {
        updatedAt[t.id] = nextTaskStamp(t.updatedAt);
        db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(
          updatedAt[t.id],
          t.id,
        );
      }
      for (const [teamId] of teamCache) {
        const ids = new Set(
          [...taskCache.values()]
            .filter((t) => t.teamId === teamId)
            .map((t) => t.id),
        );
        audit(
          db,
          req.user.id,
          teamId,
          "cells",
          d.operationId,
          before.filter((c) => ids.has(c.taskId)),
          after.filter((c) => ids.has(c.taskId)),
        );
      }
      const result = {
        cells: after,
        before,
        operationId: d.operationId,
        savedAt: now(),
        updatedAt,
      };
      db.prepare("INSERT INTO operations VALUES(?,?,?,?)").run(
        d.operationId,
        req.user.id,
        json(result),
        now(),
      );
      return result;
    });
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
      audit(db, req.user.id, task.teamId, "task", task.id, task, after);
      return after;
    });
    res.json({ task: updated });
  });
  app.delete("/api/tasks/:id", (req, res) => {
    const task = taskAccess(req.user, req.params.id, true);
    requireThat(
      req.body.updatedAt === task.updatedAt,
      409,
      "업무가 변경되었습니다. 확인 후 다시 삭제하세요.",
    );
    transaction(db, () => {
      db.prepare("UPDATE tasks SET deleted_at=?,updated_at=? WHERE id=?").run(
        now(),
        nextTaskStamp(task.updatedAt),
        task.id,
      );
      audit(db, req.user.id, task.teamId, "delete", task.id, task, undefined);
    });
    res.json({ ok: true });
  });
  app.post("/api/tasks/:id/restore", (req, res) => {
    const task = taskAccess(req.user, req.params.id, false, true);
    requireThat(manager(req.user), 403, "관리자만 복구할 수 있습니다.");
    transaction(db, () => {
      db.prepare(
        "UPDATE tasks SET deleted_at=NULL,updated_at=? WHERE id=?",
      ).run(nextTaskStamp(task.updatedAt), task.id);
      audit(db, req.user.id, task.teamId, "restore", task.id, undefined, {
        restored: true,
      });
    });
    res.json({ task: getTask(db, task.id) });
  });
  app.get("/api/views", (req, res) => {
    const teamId = String(req.query.teamId);
    const team = teamAccess(req.user, teamId);
    const year = yearSchema.parse(req.query.year);
    res.json({
      views: db
        .prepare(
          "SELECT * FROM views WHERE user_id=? AND team_id=? AND year=? ORDER BY updated_at DESC",
        )
        .all(req.user.id, teamId, year)
        .map((v) => ({
          id: v.id,
          name: v.name,
          data: normalizeView(parse(v.data), team.settings),
          updatedAt: v.updated_at,
        })),
    });
  });
  app.put("/api/views", (req, res) => {
    const d = z
      .object({ teamId: z.string().uuid(), name: string(60), data: viewSchema })
      .parse(req.body);
    const team = teamAccess(req.user, d.teamId);
    const keys = fieldsFor(team.settings).map((f) => f.key);
    requireThat(
      d.data.visibleFields.every((k) => keys.includes(k)),
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
      Object.keys(d.data.propertyFilters || {}).every((key) =>
        propertiesFor(team.settings).some((p) => p.id === key),
      ),
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
      json(d.data),
      now(),
    );
    res.json({ ok: true });
  });
  app.delete("/api/views/:id", (req, res) => {
    db.prepare("DELETE FROM views WHERE id=? AND user_id=?").run(
      req.params.id,
      req.user.id,
    );
    res.json({ ok: true });
  });
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
        teamId: z.string().uuid(),
        year: yearSchema,
        name: string(120),
        referenceDate: dateSchema,
        view: viewSchema,
        taskIds: z.array(z.string().uuid()).max(20000),
      })
      .parse(req.body);
    teamAccess(req.user, d.teamId);
    requireThat(
      manager(req.user),
      403,
      "관리자만 보고본을 저장할 수 있습니다.",
    );
    requireThat(
      d.view.year === d.year,
      400,
      "보고 연도와 보기의 연도가 일치해야 합니다.",
    );
    const selected = new Set(d.taskIds),
      tasks = getTasks(db, d.teamId, d.year).filter((t) => selected.has(t.id));
    requireThat(
      tasks.length === selected.size,
      409,
      "일부 업무가 변경 또는 삭제되었습니다. 새로고침 후 다시 저장하세요.",
    );
    const reportId = id();
    const data = {
      tasks,
      users: teamPeople(d.teamId).map(({ id, name, color }) => ({
        id,
        name,
        color,
      })),
      view: d.view,
      settings: teamAccess(req.user, d.teamId).settings,
    };
    transaction(db, () => {
      db.prepare("INSERT INTO reports VALUES(?,?,?,?,?,?,?,?)").run(
        reportId,
        d.teamId,
        d.year,
        d.name,
        d.referenceDate,
        req.user.id,
        now(),
        json(data),
      );
      audit(db, req.user.id, d.teamId, "report", reportId, undefined, {
        name: d.name,
        count: tasks.length,
      });
    });
    res.status(201).json({ id: reportId });
  });
  app.get("/api/reports/:id", (req, res) => {
    const r = db.prepare("SELECT * FROM reports WHERE id=?").get(req.params.id);
    requireThat(r, 404, "보고본을 찾을 수 없습니다.");
    teamAccess(req.user, r.team_id);
    res.json({
      id: r.id,
      name: r.name,
      year: r.year,
      referenceDate: r.reference_date,
      createdAt: r.created_at,
      ...parse(r.data),
    });
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
    if (taskId)
      requireThat(
        taskAccess(req.user, taskId, false, true).teamId === teamId,
        403,
        "같은 팀의 업무를 선택하세요.",
      );
    const rows = db
      .prepare(
        "SELECT a.*,u.name AS actor FROM audit a JOIN users u ON a.actor_id=u.id WHERE a.team_id=? AND (? IS NULL OR a.target=? OR EXISTS(SELECT 1 FROM json_each(CASE WHEN a.action='cells' THEN a.after_json ELSE '[]' END) c WHERE json_extract(c.value,'$.taskId')=?)) ORDER BY a.created_at DESC LIMIT ?",
      )
      .all(teamId, taskId, taskId, taskId, limit);
    res.json({
      entries: rows.map((r) => ({
        id: r.id,
        actor: r.actor,
        actorId: r.actor_id,
        action: r.action,
        target: r.target,
        before: parse(r.before_json),
        after: parse(r.after_json),
        createdAt: r.created_at,
      })),
    });
  });
  app.post("/api/audit/:id/restore", (req, res) => {
    const entry = db
      .prepare("SELECT * FROM audit WHERE id=?")
      .get(req.params.id);
    requireThat(entry, 404, "이력을 찾을 수 없습니다.");
    teamAccess(req.user, entry.team_id);
    requireThat(
      manager(req.user),
      403,
      "관리자만 이전 내용을 복원할 수 있습니다.",
    );
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
      const prev = [];
      const after = [];
      for (const c of before) {
        const task = taskAccess(req.user, c.taskId, true),
          current = cell(task, c.key);
        requireThat(
          expected[`${c.taskId}:${c.key}`] === current.version,
          409,
          "복구 대상이 변경되었습니다. 최신 이력을 다시 확인하세요.",
        );
        prev.push({ taskId: c.taskId, key: c.key, ...current });
        after.push({ ...c, version: current.version + 1 });
      }
      for (const c of after) {
        db.prepare(
          "INSERT INTO cells VALUES(?,?,?,?,?) ON CONFLICT(task_id,key) DO UPDATE SET value=excluded.value,style=excluded.style,version=excluded.version",
        ).run(c.taskId, c.key, json(c.value), json(c.style), c.version);
      }
      for (const taskId of new Set(after.map((c) => c.taskId))) {
        const previous = db
          .prepare("SELECT updated_at FROM tasks WHERE id=?")
          .get(taskId).updated_at;
        db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(
          nextTaskStamp(previous),
          taskId,
        );
      }
      audit(db, req.user.id, entry.team_id, "cells", id(), prev, after);
      return after;
    });
    res.json({ cells: restored });
  });
  app.patch("/api/teams/:id/settings", (req, res) => {
    const record = admin(req.user)
      ? db.prepare("SELECT * FROM teams WHERE id=?").get(req.params.id)
      : null;
    const team = record
      ? { ...record, settings: normalizeSettings(parse(record.settings)) }
      : teamAccess(req.user, req.params.id);
    requireThat(manager(req.user), 403, "관리자 권한이 필요합니다.");
    const settings = saveSettings(db, team, req.body, req.user.id);
    res.json({ settings });
  });
  app.get("/api/admin/users", (req, res) => {
    requireThat(admin(req.user), 403, "시스템 관리자 권한이 필요합니다.");
    res.json({
      users: db
        .prepare("SELECT * FROM users ORDER BY created_at")
        .all()
        .map((u) => userInfo(db, u)),
      teams: db
        .prepare("SELECT * FROM teams ORDER BY name")
        .all()
        .map((t) => ({ ...t, settings: normalizeSettings(parse(t.settings)) })),
    });
  });
  app.post("/api/admin/users", (req, res) => {
    requireThat(admin(req.user), 403, "시스템 관리자 권한이 필요합니다.");
    const d = credentials
      .extend({
        name: string(50),
        active: z.boolean().default(true),
        role: roles,
        teamIds: z.array(z.string().uuid()).max(50),
      })
      .parse(req.body);
    requireThat(
      d.role !== "admin" || d.teamIds.length > 0,
      400,
      "시스템 관리자는 한 팀 이상에 배정하세요.",
    );
    const userId = id();
    transaction(db, () => {
      requireThat(
        !db
          .prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE")
          .get(d.username),
        409,
        "이미 사용 중인 아이디입니다.",
      );
      db.prepare(
        "INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        userId,
        d.username,
        d.name,
        passwordHash(d.password),
        d.role,
        now(),
      );
      db.prepare("UPDATE users SET active=? WHERE id=?").run(
        d.active ? 1 : 0,
        userId,
      );
      for (const t of new Set(d.teamIds)) {
        requireThat(
          db.prepare("SELECT id FROM teams WHERE id=?").get(t),
          400,
          "팀을 확인하세요.",
        );
        db.prepare("INSERT INTO memberships VALUES(?,?)").run(userId, t);
      }
      audit(db, req.user.id, null, "user-create", userId, undefined, {
        name: d.name,
        role: d.role,
      });
    });
    res.status(201).json({
      user: userInfo(
        db,
        db.prepare("SELECT * FROM users WHERE id=?").get(userId),
      ),
    });
  });
  app.patch("/api/admin/users/:id", (req, res) => {
    requireThat(admin(req.user), 403, "시스템 관리자 권한이 필요합니다.");
    const d = z
      .object({
        name: string(50),
        role: roles,
        active: z.boolean(),
        teamIds: z.array(z.string().uuid()).max(50),
        password: credentials.shape.password.optional(),
      })
      .parse(req.body);
    requireThat(
      d.role !== "admin" || d.teamIds.length > 0,
      400,
      "시스템 관리자는 한 팀 이상에 배정하세요.",
    );
    const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
    requireThat(u, 404, "사용자를 찾을 수 없습니다.");
    transaction(db, () => {
      if (u.active && u.role === "admin" && (!d.active || d.role !== "admin"))
        requireThat(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1",
            )
            .get().n > 1,
          400,
          "마지막 시스템 관리자는 해제할 수 없습니다.",
        );
      db.prepare(
        "UPDATE users SET name=?,role=?,active=?,password=? WHERE id=?",
      ).run(
        d.name,
        d.role,
        d.active ? 1 : 0,
        d.password ? passwordHash(d.password) : u.password,
        u.id,
      );
      db.prepare("DELETE FROM memberships WHERE user_id=?").run(u.id);
      for (const t of new Set(d.teamIds)) {
        requireThat(
          db.prepare("SELECT id FROM teams WHERE id=?").get(t),
          400,
          "팀을 확인하세요.",
        );
        db.prepare("INSERT INTO memberships VALUES(?,?)").run(u.id, t);
      }
      if (!d.active || d.password)
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
      audit(
        db,
        req.user.id,
        null,
        "user-update",
        u.id,
        { name: u.name, role: u.role, active: !!u.active },
        { name: d.name, role: d.role, active: d.active },
      );
    });
    res.json({ ok: true });
  });
  const teamSchema = z.object({
    name: string(80),
    memberIds: z.array(z.string().uuid()).max(1000).optional(),
    theme: z.enum(THEME_IDS).optional(),
    settingsRevision: z.number().int().nonnegative().optional(),
    templateTeamId: z.string().uuid().optional(),
  });
  function setTeamMembers(teamId, ids) {
    for (const userId of new Set(ids))
      requireThat(
        db.prepare("SELECT id FROM users WHERE id=?").get(userId),
        400,
        "등록된 팀원을 선택하세요.",
      );
    db.prepare("DELETE FROM memberships WHERE team_id=?").run(teamId);
    for (const userId of new Set(ids))
      db.prepare("INSERT INTO memberships VALUES(?,?)").run(userId, teamId);
    requireThat(
      !db
        .prepare(
          "SELECT 1 FROM users u WHERE u.role='admin' AND u.active=1 AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=u.id)",
        )
        .get(),
      400,
      "활성 시스템 관리자는 한 팀 이상에 배정되어 있어야 합니다.",
    );
  }
  app.post("/api/admin/teams", (req, res) => {
    requireThat(admin(req.user), 403, "시스템 관리자 권한이 필요합니다.");
    const d = teamSchema.parse(req.body),
      teamId = id();
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
    const initialSettings = normalizeSettings(
      template ? parse(template.settings) : DEFAULT_SETTINGS,
    );
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
      setTeamMembers(teamId, d.memberIds ?? [req.user.id]);
      audit(db, req.user.id, teamId, "team-create", teamId, undefined, d);
    });
    res.status(201).json({ id: teamId });
  });
  app.patch("/api/admin/teams/:id", (req, res) => {
    requireThat(admin(req.user), 403, "시스템 관리자 권한이 필요합니다.");
    const d = teamSchema.parse(req.body);
    const team = db
      .prepare("SELECT * FROM teams WHERE id=?")
      .get(req.params.id);
    requireThat(team, 404, "팀을 찾을 수 없습니다.");
    const settings = normalizeSettings(parse(team.settings));
    const themeChanged = d.theme !== undefined && d.theme !== settings.theme;
    if (themeChanged && d.settingsRevision !== undefined)
      requireThat(
        d.settingsRevision === (settings.revision || 0),
        409,
        "팀 설정이 변경되었습니다. 관리 화면을 다시 열어 최신 설정을 확인하세요.",
      );
    const before = {
      id: team.id,
      name: team.name,
      theme: settings.theme,
      memberIds: teamPeople(team.id).map((u) => u.id),
    };
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
      if (d.memberIds) setTeamMembers(team.id, d.memberIds);
      audit(db, req.user.id, team.id, "team-update", team.id, before, {
        ...d,
        theme: d.theme ?? settings.theme,
        memberIds: d.memberIds || before.memberIds,
      });
    });
    res.json({ ok: true });
  });
  app.delete("/api/admin/teams/:id", (req, res) => {
    requireThat(admin(req.user), 403, "시스템 관리자 권한이 필요합니다.");
    const teamId = z.string().uuid().parse(req.params.id);
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    const result = deleteTeam(db, teamId, req.user.id);
    cachedTasks.clearTeam(teamId);
    res.json(result);
  });
  installTransferRoutes(app, context);
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
        error: "입력값을 확인하세요.",
        details: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
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
