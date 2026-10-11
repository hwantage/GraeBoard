import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  randomUUID,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  weeksForYear,
  todayKey,
} from "../shared/domain.js";

// 백업 복구가 받아들이는 스키마 버전. 스키마가 바뀌면 올리고 복구 스크립트가 거부하게 한다.
export const SCHEMA_VERSION = 5;
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const nextTaskStamp = (previous) =>
  new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
export const json = (v) => JSON.stringify(v);
export const parse = (v, fallback = null) => {
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};
// 팀 행의 settings JSON을 현재 형식으로 읽는다. 손상된 JSON은 기본값으로 대체한다.
export const teamSettings = (row) =>
  normalizeSettings(parse(row.settings, DEFAULT_SETTINGS));
export function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function passwordMatches(password, hash) {
  try {
    const [salt, key] = hash.split(":");
    return timingSafeEqual(
      Buffer.from(key, "hex"),
      scryptSync(password, salt, 64),
    );
  } catch {
    return false;
  }
}
export function openDatabase(
  path = process.env.DB_PATH || resolve("data/weekly-plan.sqlite"),
) {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY,name TEXT NOT NULL,settings TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,password TEXT NOT NULL,system_role TEXT NOT NULL DEFAULT 'user',active INTEGER NOT NULL DEFAULT 1,color TEXT NOT NULL DEFAULT '#177b70',avatar_initials TEXT NOT NULL DEFAULT '',avatar_image TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships(user_id TEXT NOT NULL REFERENCES users(id),team_id TEXT NOT NULL REFERENCES teams(id),role TEXT NOT NULL DEFAULT 'member',PRIMARY KEY(user_id,team_id));
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),years TEXT NOT NULL,position REAL NOT NULL,deleted_at TEXT,default_style TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cells(task_id TEXT NOT NULL REFERENCES tasks(id),key TEXT NOT NULL,value TEXT NOT NULL,style TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(task_id,key));
    CREATE INDEX IF NOT EXISTS tasks_team_idx ON tasks(team_id,deleted_at,position);
    CREATE TABLE IF NOT EXISTS views(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),team_id TEXT NOT NULL REFERENCES teams(id),year INTEGER NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(user_id,team_id,year,name));
    CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),year INTEGER NOT NULL,name TEXT NOT NULL,reference_date TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,team_id TEXT REFERENCES teams(id),actor_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,target TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS audit_team_idx ON audit(team_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES users(id),response TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),actor_id TEXT NOT NULL REFERENCES users(id),filename TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,applied_at TEXT,result TEXT);
    CREATE TABLE IF NOT EXISTS team_revisions(team_id TEXT PRIMARY KEY REFERENCES teams(id),version INTEGER NOT NULL DEFAULT 0);
    CREATE TRIGGER IF NOT EXISTS revision_team_insert AFTER INSERT ON teams BEGIN INSERT OR IGNORE INTO team_revisions(team_id) VALUES(NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS revision_task_insert AFTER INSERT ON tasks BEGIN UPDATE team_revisions SET version=version+1 WHERE team_id=NEW.team_id; END;
    CREATE TRIGGER IF NOT EXISTS revision_task_update AFTER UPDATE ON tasks BEGIN UPDATE team_revisions SET version=version+1 WHERE team_id=NEW.team_id; END;
    CREATE TRIGGER IF NOT EXISTS revision_task_delete AFTER DELETE ON tasks BEGIN UPDATE team_revisions SET version=version+1 WHERE team_id=OLD.team_id; END;
    CREATE TRIGGER IF NOT EXISTS revision_cell_insert AFTER INSERT ON cells BEGIN UPDATE team_revisions SET version=version+1 WHERE team_id=(SELECT team_id FROM tasks WHERE id=NEW.task_id); END;
    CREATE TRIGGER IF NOT EXISTS revision_cell_update AFTER UPDATE ON cells BEGIN UPDATE team_revisions SET version=version+1 WHERE team_id=(SELECT team_id FROM tasks WHERE id=NEW.task_id); END;
    CREATE TRIGGER IF NOT EXISTS revision_cell_delete AFTER DELETE ON cells BEGIN UPDATE team_revisions SET version=version+1 WHERE team_id=(SELECT team_id FROM tasks WHERE id=OLD.task_id); END;
    PRAGMA user_version=${SCHEMA_VERSION};
  `);
  return db;
}
export function transaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = work();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
// API에 내보내는 사용자 객체: 프로필과 함께 소속 팀·팀 내 권한을 담는다.
export function userWithTeams(db, u) {
  if (!u) return null;
  return usersWithTeams(db, [u])[0];
}
// 사용자 행 여러 개를 한 번에 변환한다. 소속은 한 번의 조회로 모아 읽어
// 사용자 수만큼 조회가 늘어나지 않게 한다.
export function usersWithTeams(db, rows) {
  if (!rows.length) return [];
  const memberships = new Map(rows.map((u) => [u.id, []]));
  for (let offset = 0; offset < rows.length; offset += 500) {
    const ids = rows.slice(offset, offset + 500).map((u) => u.id);
    for (const m of db
      .prepare(
        `SELECT user_id,team_id,role FROM memberships WHERE user_id IN (${ids.map(() => "?").join(",")}) ORDER BY rowid`,
      )
      .all(...ids))
      memberships.get(m.user_id).push(m);
  }
  return rows.map((u) => {
    const mine = memberships.get(u.id);
    return {
      id: u.id,
      username: u.username,
      name: u.name,
      systemRole: u.system_role,
      active: !!u.active,
      color: u.color,
      avatarInitials: u.avatar_initials || "",
      avatarImage: u.avatar_image || "",
      teamIds: mine.map((m) => m.team_id),
      teamRoles: Object.fromEntries(mine.map((m) => [m.team_id, m.role])),
    };
  });
}
const INSERT_MEMBERSHIP =
  "INSERT INTO memberships(user_id,team_id,role) VALUES(?,?,?)";
export function addMembership(db, userId, teamId, role) {
  db.prepare(INSERT_MEMBERSHIP).run(userId, teamId, role);
}
// 한 사용자의 소속을 통째로 바꾼다. rows: [{teamId, role}]
export function replaceUserMemberships(db, userId, rows) {
  db.prepare("DELETE FROM memberships WHERE user_id=?").run(userId);
  const add = db.prepare(INSERT_MEMBERSHIP);
  for (const m of rows) add.run(userId, m.teamId, m.role);
}
// 한 팀의 구성원을 통째로 바꾼다. rows: [{userId, role}]
export function replaceTeamMembers(db, teamId, rows) {
  db.prepare("DELETE FROM memberships WHERE team_id=?").run(teamId);
  const add = db.prepare(INSERT_MEMBERSHIP);
  for (const m of rows) add.run(m.userId, teamId, m.role);
}
export const upsertCellStatement = (db) =>
  db.prepare(
    "INSERT INTO cells(task_id,key,value,style,version) VALUES(?,?,?,?,?) ON CONFLICT(task_id,key) DO UPDATE SET value=excluded.value,style=excluded.style,version=excluded.version",
  );
// 업무의 수정 시각을 이전 값보다 뒤로 올린다. 같은 밀리초에 바뀌어도 값이 달라진다.
export function touchTasks(db, tasks) {
  const put = db.prepare("UPDATE tasks SET updated_at=? WHERE id=?");
  const stamps = {};
  for (const t of tasks) {
    stamps[t.id] = nextTaskStamp(t.updatedAt);
    put.run(stamps[t.id], t.id);
  }
  return stamps;
}
export function getTask(db, taskId) {
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
  return t ? hydrateTasks(db, [t])[0] : null;
}
export function getTasksById(db, ids) {
  const rows = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    rows.push(
      ...db
        .prepare(
          `SELECT * FROM tasks WHERE id IN (${chunk.map(() => "?").join(",")})`,
        )
        .all(...chunk),
    );
  }
  return hydrateTasks(db, rows);
}
function hydrateTasks(db, rows) {
  if (!rows.length) return [];
  const map = new Map(
    rows.map((t) => [
      t.id,
      {
        id: t.id,
        teamId: t.team_id,
        years: parse(t.years, []),
        position: t.position,
        deletedAt: t.deleted_at,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        cells: {},
        defaultStyle: parse(t.default_style, {}),
      },
    ]),
  );
  for (let offset = 0; offset < rows.length; offset += 500) {
    const ids = rows.slice(offset, offset + 500).map((t) => t.id);
    for (const c of db
      .prepare(
        `SELECT * FROM cells WHERE task_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids))
      map.get(c.task_id).cells[c.key] = {
        value: parse(c.value, ""),
        style: parse(c.style, {}),
        version: c.version,
      };
  }
  return [...map.values()];
}
export function getTasks(db, teamId, year, deleted = false) {
  return hydrateTasks(
    db,
    db
      .prepare(
        `SELECT * FROM tasks WHERE team_id=? AND deleted_at IS ${deleted ? "NOT " : ""}NULL AND EXISTS(SELECT 1 FROM json_each(tasks.years) WHERE value=?) ORDER BY position,created_at`,
      )
      .all(teamId, year),
  );
}
export function insertTask(
  db,
  {
    taskId = id(),
    teamId,
    year,
    years = [year],
    actorId,
    fields = {},
    cells = {},
    position,
    defaultStyle = {},
  },
) {
  const n = now();
  if (position == null)
    position =
      (db
        .prepare("SELECT MAX(position) AS position FROM tasks WHERE team_id=?")
        .get(teamId).position || 0) + 100;
  db.prepare(
    "INSERT INTO tasks(id,team_id,years,position,created_by,created_at,updated_at,default_style) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    taskId,
    teamId,
    json(years),
    position,
    actorId,
    n,
    n,
    json(defaultStyle),
  );
  const put = upsertCellStatement(db);
  for (const [key, val] of Object.entries(fields))
    put.run(taskId, key, json(val), "{}", 1);
  for (const [key, c] of Object.entries(cells))
    put.run(taskId, key, json(c.value ?? ""), json(c.style || {}), 1);
  return getTask(db, taskId);
}
export function audit(db, actorId, teamId, action, target, before, after) {
  db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)").run(
    id(),
    teamId,
    actorId,
    action,
    target,
    before === undefined ? null : json(before),
    after === undefined ? null : json(after),
    now(),
  );
}
export function seedDemo(db, user, teamId, year) {
  const users = [user];
  for (const [name, color] of [
    ["서연", "#9b73bc"],
    ["민준", "#397ca6"],
  ]) {
    const u = {
      id: id(),
      name,
      username: `example-${id().slice(0, 8)}`,
      color,
      active: 0,
    };
    db.prepare(
      "INSERT INTO users(id,username,name,password,active,color,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      u.id,
      u.username,
      name,
      passwordHash(randomBytes(32).toString("hex")),
      0,
      color,
      now(),
    );
    addMembership(db, u.id, teamId, "member");
    users.push(u);
  }
  const titles = [
    "디자인 시스템 컴포넌트 가이드 정리",
    "관리자 대시보드 사용성 개선",
    "검색 결과 화면 정보 구조 설계",
    "서비스 온보딩 흐름 점검",
    "접근성 기준 및 키보드 탐색 검토",
    "설정 화면 오류 메시지 개선",
    "모바일 화면 반응형 규칙 정리",
    "공통 아이콘 및 컬러 토큰 검토",
    "주간 사용자 피드백 분석",
    "권한 관리 화면 프로토타입",
    "제품 도움말 구조 개편",
    "연말 개선 과제 우선순위 검토",
  ];
  const weeks = weeksForYear(year),
    today = todayKey();
  let center = weeks.findIndex((w) => w.key <= today && w.end >= today);
  if (center < 0) center = 5;
  titles.forEach((title, i) => {
    const owner = users[i % users.length],
      start = Math.max(0, center - 3 + (i % 6));
    const cells = {};
    for (let j = 0; j < 3 + (i % 3) && start + j < weeks.length; j++) {
      cells[weeks[start + j].key] = {
        value: j === 0 ? "착수" : j === 2 ? "검토" : "",
        style: {
          backgroundColor:
            i % 3 === 0 ? "#d1eee6" : i % 3 === 1 ? "#e5effc" : "#ede8fa",
        },
      };
    }
    insertTask(db, {
      teamId,
      year,
      actorId: user.id,
      fields: {
        title,
        description:
          "예시 데이터입니다. 실제 업무를 등록하거나 파일을 가져와 시작하세요.",
        category: i < 8 ? "category-ux" : "category-new",
        type: ["type-plan", "type-design", "type-review", "type-dev"][i % 4],
        owner: owner.id,
        supporters: i % 3 === 0 ? [users[(i + 1) % 3].id] : [],
        status: [
          "status-progress",
          "status-planned",
          "status-review",
          "status-completed",
        ][i % 4],
        progress: ["50%", "0%", "80%", "100%"][i % 4],
        deadline: weeks[Math.min(start + 3, weeks.length - 1)].date,
        score: 5 + (i % 4) * 5,
        current: i % 4 === 3 ? 10 : 0,
      },
      cells,
    });
  });
}
