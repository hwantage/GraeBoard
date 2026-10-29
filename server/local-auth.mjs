import { rateLimit } from "express-rate-limit";
import { randomBytes, createHash } from "node:crypto";

import { z } from "zod";

import {
  id,
  now,
  json,
  passwordHash,
  passwordMatches,
  userWithTeams,
  addMembership,
  transaction,
  audit,
  seedDemo,
} from "./db.mjs";
import { requireThat } from "../shared/validation.js";
import {
  DEFAULT_SETTINGS,
  todayKey,
  sampleProperties,
} from "../shared/domain.js";

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
const sessionHash = (t) => createHash("sha256").update(t).digest("hex");
export function installLocalAuth(app, { db, site, allowSetup, rateLimits }) {
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
    next();
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

  const refreshUser = (req) => {
    const row = db
      .prepare(
        "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires_at>? AND u.active=1",
      )
      .get(sessionHash(req.cookies.weekly_session), Date.now());
    requireThat(row, 401, "로그인이 필요합니다.");
    return userWithTeams(db, row);
  };
  return { refreshUser, sessionHash };
}
