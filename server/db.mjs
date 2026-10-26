import { SQLITE_VERSION, assertSqliteHistory, migrateSqlite } from './migrations/sqlite.mjs';
import { storeDocumentVersion } from "./document-storage.mjs";
import { hasDocumentContent } from "../shared/task-documents.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createHash,
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
import {
  compactStyle,
  expandStyle,
  normalizeStyle,
  styleNormalizer,
  stringify,
  parseCompact,
} from "../shared/compact.js";

import { normalizeCellStyle } from "../shared/formatting.js";

// 백업 복구가 받아들이는 스키마 버전. 스키마가 바뀌면 올리고 복구 스크립트가 거부하게 한다.
export const SCHEMA_VERSION = SQLITE_VERSION;
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const nextTaskStamp = (previous) =>
  new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
export const json = stringify;
export const parse = (v, fallback = null) => {
  try {
    return parseCompact(v);
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
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version !== 0 && version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(
      version === 29
        ? `DB 형식 v29의 자동 변환은 지원하지 않습니다. npm run migrate -- --engine sqlite --database <DB 경로> 로 명시적 변환을 수행하세요.`
        : `DB 형식 v${version}은 지원하지 않습니다. 지원하는 변환 경로가 없으므로 원본과 호환 릴리스를 보존하세요.`,
    );
  }
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
  try {
    if (version === 0) migrateSqlite(db, { initialize: true });
    else assertSqliteHistory(db);
  } catch (error) { db.close(); throw error; }
  pruneStyles(db);
  return db;
}
export function transaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  let committed=false;
  try {
    db.syncCapture?.begin();
    const r = work();
    if (r && typeof r.then === "function") throw new Error("SQLite transaction callback must be synchronous");
    db.syncCapture?.flush();
    db.exec("COMMIT");
    committed=true;
    db.syncCapture?.committed();
    return r;
  } catch (e) {
    const failure = db.syncCapture?.failure || e;
    if(!committed)db.exec("ROLLBACK");
    db.syncCapture?.rollback();
    throw failure;
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
export function styleWriter(db) {
  const known = new Map([["{}", 0]]);
  const objects = new WeakMap();
  const insert = db.prepare(
    "INSERT INTO styles(data) VALUES(?) ON CONFLICT(data) DO NOTHING",
  );
  const find = db.prepare("SELECT id FROM styles WHERE data=?");
  return (style) => {
    if (objects.has(style)) return objects.get(style);
    const data = JSON.stringify(compactStyle(style));
    if (!known.has(data)) {
      insert.run(data);
      known.set(data, find.get(data).id);
    }
    const id = known.get(data);
    objects.set(style, id);
    return id;
  };
}

export function upsertCellStatement(db) {
  const intern = styleWriter(db);
  const put = db.prepare(
    "INSERT INTO cells(task_id,key,value,style_id,version) VALUES(?,?,?,?,?) ON CONFLICT(task_id,key) DO UPDATE SET value=excluded.value,style_id=excluded.style_id,version=excluded.version",
  );
  return {
    run(taskId, key, value, style, version) {
      return put.run(taskId, key, json(value), intern(style), version);
    },
  };
}

export function pruneStyles(db, candidates) {
  if (candidates?.length === 0) return;
  const unused =
    "id<>0 AND NOT EXISTS(SELECT 1 FROM cells WHERE style_id=styles.id) AND NOT EXISTS(SELECT 1 FROM tasks WHERE default_style=styles.id) AND NOT EXISTS(SELECT 1 FROM tasks WHERE row_style=styles.id) AND NOT EXISTS(SELECT 1 FROM format_rules WHERE style_id=styles.id)";
  if (candidates) {
    const remove = db.prepare(`DELETE FROM styles WHERE data=? AND ${unused}`);
    for (const data of new Set(
      [...new Set(candidates)].map((s) => JSON.stringify(compactStyle(s))),
    ))
      remove.run(data);
  } else db.exec(`DELETE FROM styles WHERE ${unused}`);
}
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
function readStyles(db, requested, styles) {
  const styleIds = [...new Set(requested)].filter((id) => !styles.has(id));
  for (let offset = 0; offset < styleIds.length; offset += 500) {
    const ids = styleIds.slice(offset, offset + 500);
    for (const s of db
      .prepare(
        `SELECT * FROM styles WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids))
      styles.set(s.id, expandStyle(JSON.parse(s.data)));
  }
}
export function readFormatting(db, teamId) {
  const revision =
    db.prepare("SELECT revision FROM format_states WHERE team_id=?").get(teamId)
      ?.revision ?? 0;
  const rows = db
    .prepare(
      "SELECT f.*,s.data FROM format_rules f JOIN styles s ON s.id=f.style_id WHERE f.team_id=? ORDER BY f.id",
    )
    .all(teamId);
  return {
    revision,
    rules: rows.map((r) => ({
      id: r.id,
      rows: parse(r.rows_json),
      keys: parse(r.keys_json),
      excludeKeys: parse(r.exclusions_json),
      style: expandStyle(JSON.parse(r.data)),
      orders: parse(r.orders_json, {}),
    })),
  };
}

export function writeFormatting(db, teamId, formatting) {
  const intern = styleWriter(db);
  const previous = db
    .prepare("SELECT id,style_id,orders_json FROM format_rules WHERE team_id=?")
    .all(teamId);
  const prior = new Map(previous.map((r) => [r.id, r]));
  const put = db.prepare(
    "INSERT INTO format_rules(team_id,id,selector,rows_json,keys_json,exclusions_json,style_id,orders_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(team_id,id) DO UPDATE SET style_id=excluded.style_id,orders_json=excluded.orders_json",
  );
  for (const rule of formatting.rules) {
    const rows = JSON.stringify(rule.rows),
      keys = JSON.stringify(rule.keys),
      orders = JSON.stringify(rule.orders),
      styleId = intern(rule.style);
    const old = prior.get(rule.id);
    if (!old || old.style_id !== styleId || old.orders_json !== orders)
      put.run(
        teamId,
        rule.id,
        createHash("sha256")
          .update(
            JSON.stringify([rule.rows, rule.keys, rule.excludeKeys || []]),
          )
          .digest("hex"),
        rows,
        keys,
        JSON.stringify(rule.excludeKeys || []),
        styleId,
        orders,
      );
    prior.delete(rule.id);
  }
  const remove = db.prepare(
    "DELETE FROM format_rules WHERE team_id=? AND id=?",
  );
  for (const id of prior.keys()) remove.run(teamId, id);
  db.prepare(
    "INSERT INTO format_states(team_id,revision) VALUES(?,?) ON CONFLICT(team_id) DO UPDATE SET revision=excluded.revision",
  ).run(teamId, formatting.revision);
  db.prepare("UPDATE team_revisions SET version=version+1 WHERE team_id=?").run(
    teamId,
  );
}
function hydrateTasks(db, rows) {
  if (!rows.length) return [];
  const formatting = new Map(
    [...new Set(rows.map((t) => t.team_id))].map((teamId) => [
      teamId,
      readFormatting(db, teamId),
    ]),
  );
  const styles = new Map();
  readStyles(
    db,
    rows.flatMap((t) => [t.default_style, t.row_style]),
    styles,
  );
  const map = new Map(
    rows.map((t) => [
      t.id,
      {
        id: t.id,
        teamId: t.team_id,
        years: parse(t.years, []),
        position: t.position,
        deletedAt: t.deleted_at,
        createdBy: t.created_by,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        documentCount: 0,
        cells: {},
        defaultStyle: styles.get(t.default_style),
        ...(t.row_style ? { rowStyle: styles.get(t.row_style) } : {}),
        ...(formatting.get(t.team_id).revision
          ? { formatting: formatting.get(t.team_id) }
          : {}),
      },
    ]),
  );
  for (let offset = 0; offset < rows.length; offset += 500) {
    const ids = rows.slice(offset, offset + 500).map((t) => t.id);
    for (const doc of db
      .prepare(
        `SELECT task_id,COUNT(*) AS document_count,MAX(has_content) AS has_content FROM task_documents WHERE task_id IN (${ids.map(() => "?").join(",")}) GROUP BY task_id`,
      )
      .all(...ids)) {
      const task = map.get(doc.task_id);
      task.documentCount = doc.document_count;
      if (doc.has_content) task.hasDocument = true;
    }
    const cells = db
      .prepare(
        `SELECT * FROM cells WHERE task_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids);
    readStyles(
      db,
      cells.map((c) => c.style_id),
      styles,
    );
    for (const c of cells) {
      map.get(c.task_id).cells[c.key] = {
        value: parse(c.value, ""),
        style: styles.get(c.style_id),
        version: c.version,
      };
    }
  }
  return [...map.values()];
}
export function getTasks(db, teamId, year, deleted = false) {
  const years = Array.isArray(year) ? year : [year];
  return hydrateTasks(
    db,
    db
      .prepare(
        `SELECT * FROM tasks WHERE team_id=? AND deleted_at IS ${deleted ? "NOT " : ""}NULL AND EXISTS(SELECT 1 FROM json_each(tasks.years) WHERE value IN (${years.map(() => "?").join(",")})) ORDER BY position,created_at,id`,
      )
      .all(teamId, ...years),
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
    rowStyle = {},
    documents,
  },
) {
  const n = now();
  if (position == null)
    position =
      (db
        .prepare("SELECT MAX(position) AS position FROM tasks WHERE team_id=?")
        .get(teamId).position || 0) + 100;
  db.prepare(
    "INSERT INTO tasks(id,team_id,years,position,created_by,created_at,updated_at,default_style,row_style) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    taskId,
    teamId,
    json(years),
    position,
    actorId,
    n,
    n,
    styleWriter(db)(normalizeStyle(defaultStyle)),
    styleWriter(db)(rowStyle),
  );
  const put = upsertCellStatement(db);
  const initial = {
    ...Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, { value, style: {} }]),
    ),
    ...cells,
  };
  if (Object.keys(rowStyle).length)
    for (const [key, c] of Object.entries(initial))
      initial[key] = {
        ...c,
        style: normalizeCellStyle(
          { id: taskId, defaultStyle, rowStyle, cells: {} },
          key,
          c.style || {},
        ),
      };
  for (const [key, c] of initialCells(initial, {
    ...defaultStyle,
    ...rowStyle,
  }))
    put.run(taskId, key, c.value, c.style, c.version);
  for (const [position, document] of (documents || []).entries())
    db.prepare(
      "INSERT INTO task_documents(task_id,id,title,position,version_id,has_content,revision,updated_at,actor_id) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      taskId,
      document.id,
      document.title,
      position,
      storeDocumentVersion(db, {
        teamId,
        documentId: `${taskId}:${document.id}`,
        markdown: document.markdown,
        actorId,
      }),
      Number(hasDocumentContent(document.markdown)),
      1,
      n,
      actorId,
    );
  return getTask(db, taskId);
}

// New tasks and imported snapshots share sparse initialization. Existing cells
// never use this path: clearing them must preserve their conflict versions.
export function* initialCells(cells, defaultStyle = {}) {
  const normalize = styleNormalizer();
  for (const [key, c] of Object.entries(cells)) {
    const value = c.value ?? "",
      style = normalize(c.style || {}, defaultStyle);
    if (value === "" && !Object.keys(style).length) continue;
    yield [key, { value, style, version: 1 }];
  }
}
export function audit(db, actorId, teamId, action, target, before, after) {
  const auditId = id();
  db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)").run(
    auditId,
    teamId,
    actorId,
    action,
    target,
    before === undefined ? null : json(before),
    after === undefined ? null : json(after),
    now(),
  );
  return auditId;
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
