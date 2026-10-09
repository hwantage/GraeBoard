import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  randomUUID,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { DEFAULT_SETTINGS, weeksForYear, todayKey } from "../shared/domain.js";

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
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,color TEXT NOT NULL DEFAULT '#177b70',created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships(user_id TEXT NOT NULL REFERENCES users(id),team_id TEXT NOT NULL REFERENCES teams(id),PRIMARY KEY(user_id,team_id));
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),years TEXT NOT NULL,position REAL NOT NULL,deleted_at TEXT,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cells(task_id TEXT NOT NULL REFERENCES tasks(id),key TEXT NOT NULL,value TEXT NOT NULL,style TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(task_id,key));
    CREATE INDEX IF NOT EXISTS tasks_team_idx ON tasks(team_id,deleted_at,position);
    CREATE TABLE IF NOT EXISTS views(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),team_id TEXT NOT NULL REFERENCES teams(id),year INTEGER NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(user_id,team_id,year,name));
    CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),year INTEGER NOT NULL,name TEXT NOT NULL,reference_date TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,team_id TEXT REFERENCES teams(id),actor_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,target TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS audit_team_idx ON audit(team_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES users(id),response TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),actor_id TEXT NOT NULL REFERENCES users(id),filename TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,applied_at TEXT,result TEXT);
    CREATE TABLE IF NOT EXISTS team_revisions(team_id TEXT PRIMARY KEY REFERENCES teams(id),version INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO team_revisions(team_id) SELECT id FROM teams;
    CREATE TRIGGER IF NOT EXISTS revision_team_insert AFTER INSERT ON teams BEGIN INSERT OR IGNORE INTO team_revisions(team_id) VALUES(NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS revision_task_insert AFTER INSERT ON tasks BEGIN UPDATE team_revisions SET version=version+1 WHERE team_id=NEW.team_id; END;
    CREATE TRIGGER IF NOT EXISTS revision_task_update AFTER UPDATE ON tasks BEGIN UPDATE team_revisions SET version=version+1 WHERE team_id=NEW.team_id; END;
    CREATE TRIGGER IF NOT EXISTS revision_task_delete AFTER DELETE ON tasks BEGIN UPDATE team_revisions SET version=version+1 WHERE team_id=OLD.team_id; END;
    CREATE TRIGGER IF NOT EXISTS revision_cell_insert AFTER INSERT ON cells BEGIN UPDATE team_revisions SET version=version+1 WHERE team_id=(SELECT team_id FROM tasks WHERE id=NEW.task_id); END;
    CREATE TRIGGER IF NOT EXISTS revision_cell_update AFTER UPDATE ON cells BEGIN UPDATE team_revisions SET version=version+1 WHERE team_id=(SELECT team_id FROM tasks WHERE id=NEW.task_id); END;
    CREATE TRIGGER IF NOT EXISTS revision_cell_delete AFTER DELETE ON cells BEGIN UPDATE team_revisions SET version=version+1 WHERE team_id=(SELECT team_id FROM tasks WHERE id=OLD.task_id); END;
  `);
  if (
    !db
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .some((c) => c.name === "default_style")
  )
    db.exec(
      "ALTER TABLE tasks ADD COLUMN default_style TEXT NOT NULL DEFAULT '{}'",
    );
  db.exec("PRAGMA user_version=2");
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
export function userInfo(db, u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    active: !!u.active,
    color: u.color,
    teamIds: db
      .prepare("SELECT team_id FROM memberships WHERE user_id=?")
      .all(u.id)
      .map((t) => t.team_id),
  };
}
export function getTask(db, taskId) {
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
  return t ? hydrateTasks(db, [t])[0] : null;
}
export function hydrateTasks(db, rows) {
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
  const add = db.prepare(
    "INSERT INTO cells(task_id,key,value,style,version) VALUES(?,?,?,?,1)",
  );
  for (const [key, val] of Object.entries(fields))
    add.run(taskId, key, json(val), "{}");
  for (const [key, c] of Object.entries(cells))
    db.prepare(
      "INSERT INTO cells(task_id,key,value,style,version) VALUES(?,?,?,?,1) ON CONFLICT(task_id,key) DO UPDATE SET value=excluded.value,style=excluded.style",
    ).run(taskId, key, json(c.value ?? ""), json(c.style || {}));
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
  const people = [user];
  for (const [name, color] of [
    ["서연", "#9b73bc"],
    ["민준", "#397ca6"],
  ]) {
    const u = {
      id: id(),
      name,
      username: `example-${id().slice(0, 8)}`,
      role: "member",
      color,
      active: 0,
    };
    db.prepare(
      "INSERT INTO users(id,username,name,password,role,active,color,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      u.id,
      u.username,
      name,
      passwordHash(randomBytes(32).toString("hex")),
      u.role,
      0,
      color,
      now(),
    );
    db.prepare("INSERT INTO memberships VALUES(?,?)").run(u.id, teamId);
    people.push(u);
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
    const owner = people[i % people.length],
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
        category: i < 8 ? "UX 개선" : "차별화",
        type: ["기획", "디자인", "검토", "개발"][i % 4],
        owner: owner.id,
        supporters: i % 3 === 0 ? [people[(i + 1) % 3].id] : [],
        status: ["진행 중", "예정", "검토 중", "완료"][i % 4],
        progress: [50, 0, 80, 100][i % 4],
        deadline: weeks[Math.min(start + 3, weeks.length - 1)].date,
        score: 5 + (i % 4) * 5,
        current: i % 4 === 3 ? 10 : 0,
      },
      cells,
    });
  });
}
