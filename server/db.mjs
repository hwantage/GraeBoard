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
export const SCHEMA_VERSION = 27;
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
      `DB 형식 v${version}은 지원하지 않습니다. v${SCHEMA_VERSION}용 새 DB를 사용하세요.`,
    );
  }
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
  transaction(db, () => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY,name TEXT NOT NULL,settings TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,password TEXT NOT NULL,system_role TEXT NOT NULL DEFAULT 'user',active INTEGER NOT NULL DEFAULT 1,color TEXT NOT NULL DEFAULT '#177b70',avatar_initials TEXT NOT NULL DEFAULT '',avatar_image TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships(user_id TEXT NOT NULL REFERENCES users(id),team_id TEXT NOT NULL REFERENCES teams(id),role TEXT NOT NULL DEFAULT 'member',PRIMARY KEY(user_id,team_id));
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS styles(id INTEGER PRIMARY KEY,data TEXT NOT NULL UNIQUE);
      INSERT OR IGNORE INTO styles(id,data) VALUES(0,'{}');
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),years TEXT NOT NULL,position REAL NOT NULL,deleted_at TEXT,default_style INTEGER NOT NULL DEFAULT 0 REFERENCES styles(id),row_style INTEGER NOT NULL DEFAULT 0 REFERENCES styles(id),created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cells(task_id TEXT NOT NULL REFERENCES tasks(id),key TEXT NOT NULL,value TEXT NOT NULL,style_id INTEGER NOT NULL DEFAULT 0 REFERENCES styles(id),version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(task_id,key));
      CREATE INDEX IF NOT EXISTS cells_style_idx ON cells(style_id);
      CREATE INDEX IF NOT EXISTS tasks_style_idx ON tasks(default_style);
      CREATE INDEX IF NOT EXISTS tasks_row_style_idx ON tasks(row_style);
    CREATE TABLE IF NOT EXISTS document_versions(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,document_id TEXT NOT NULL,content_hash TEXT NOT NULL,markdown TEXT NOT NULL,has_content INTEGER NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),UNIQUE(team_id,document_id,content_hash));
    CREATE TABLE IF NOT EXISTS task_documents(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,id TEXT NOT NULL DEFAULT 'main',title TEXT NOT NULL DEFAULT '문서 1',position INTEGER NOT NULL DEFAULT 0,version_id TEXT NOT NULL REFERENCES document_versions(id),has_content INTEGER NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),operation_id TEXT,request_hash TEXT,PRIMARY KEY(task_id,id));
    CREATE INDEX IF NOT EXISTS task_documents_version_idx ON task_documents(version_id);
    CREATE INDEX IF NOT EXISTS task_documents_summary_idx ON task_documents(task_id,has_content);
    CREATE TABLE IF NOT EXISTS format_states(team_id TEXT PRIMARY KEY REFERENCES teams(id),revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS format_rules(team_id TEXT NOT NULL REFERENCES teams(id),id TEXT NOT NULL,selector TEXT NOT NULL,rows_json TEXT,keys_json TEXT,exclusions_json TEXT NOT NULL,style_id INTEGER NOT NULL REFERENCES styles(id),orders_json TEXT NOT NULL,PRIMARY KEY(team_id,id),UNIQUE(team_id,selector));
    CREATE INDEX IF NOT EXISTS format_styles_idx ON format_rules(style_id);
    CREATE INDEX IF NOT EXISTS tasks_team_idx ON tasks(team_id,deleted_at,position);
    CREATE TABLE IF NOT EXISTS views(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),team_id TEXT NOT NULL REFERENCES teams(id),year INTEGER NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(user_id,team_id,year,name));
    CREATE TABLE IF NOT EXISTS saved_filters(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),scope TEXT NOT NULL CHECK(scope IN ('team','personal')),owner_id TEXT REFERENCES users(id),name TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,CHECK((scope='team' AND owner_id IS NULL) OR (scope='personal' AND owner_id IS NOT NULL)));
    CREATE UNIQUE INDEX IF NOT EXISTS saved_filters_team_name ON saved_filters(team_id,name) WHERE scope='team';
    CREATE UNIQUE INDEX IF NOT EXISTS saved_filters_personal_name ON saved_filters(team_id,owner_id,name) WHERE scope='personal';
    CREATE TABLE IF NOT EXISTS filter_states(user_id TEXT NOT NULL REFERENCES users(id),team_id TEXT NOT NULL REFERENCES teams(id),selected_id TEXT REFERENCES saved_filters(id) ON DELETE SET NULL,data TEXT NOT NULL,PRIMARY KEY(user_id,team_id));
    CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),year INTEGER NOT NULL,name TEXT NOT NULL,reference_date TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,data BLOB NOT NULL CHECK(typeof(data)='blob'));
    CREATE TABLE IF NOT EXISTS report_documents(report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,task_id TEXT NOT NULL,document_id TEXT NOT NULL,version_id TEXT NOT NULL REFERENCES document_versions(id),PRIMARY KEY(report_id,task_id,document_id));
    CREATE INDEX IF NOT EXISTS report_documents_version_idx ON report_documents(version_id);
    CREATE TABLE IF NOT EXISTS calendar_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,weekdays TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS calendar_rules(team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,property_id TEXT NOT NULL,filter_values TEXT NOT NULL,filter_mode TEXT NOT NULL DEFAULT 'include' CHECK(filter_mode IN ('include','exclude')),revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS calendar_entries(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,user_id TEXT REFERENCES users(id),date TEXT NOT NULL,end_date TEXT NOT NULL CHECK(end_date>=date),lane INTEGER NOT NULL DEFAULT 0 CHECK(lane>=0),title TEXT NOT NULL,preview TEXT NOT NULL DEFAULT '',version_id TEXT REFERENCES document_versions(id),revision INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),operation_id TEXT,request_hash TEXT,deleted_at TEXT,deletion_id TEXT);
    CREATE INDEX IF NOT EXISTS calendar_entries_scope_idx ON calendar_entries(team_id,date,user_id);
    CREATE INDEX IF NOT EXISTS calendar_entries_owner_idx ON calendar_entries(team_id,user_id);
    CREATE INDEX IF NOT EXISTS calendar_entries_layout_start_idx ON calendar_entries(team_id,user_id,date,end_date) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS calendar_entries_layout_end_idx ON calendar_entries(team_id,user_id,end_date,date) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS calendar_entries_version_idx ON calendar_entries(version_id);
    CREATE TABLE IF NOT EXISTS calendar_tags(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,user_id TEXT REFERENCES users(id),name TEXT NOT NULL COLLATE NOCASE,color TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'label' CHECK(kind IN ('label','check')),revision INTEGER NOT NULL DEFAULT 1);
    CREATE UNIQUE INDEX IF NOT EXISTS calendar_tags_personal_name_idx ON calendar_tags(team_id,user_id,name) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS calendar_tags_shared_name_idx ON calendar_tags(team_id,name) WHERE user_id IS NULL;
    CREATE TABLE IF NOT EXISTS calendar_entry_tags(entry_id TEXT NOT NULL REFERENCES calendar_entries(id) ON DELETE CASCADE,tag_id TEXT NOT NULL REFERENCES calendar_tags(id) ON DELETE CASCADE,position INTEGER NOT NULL,checked INTEGER NOT NULL DEFAULT 0 CHECK(checked IN (0,1)),PRIMARY KEY(entry_id,tag_id),UNIQUE(entry_id,position));
    CREATE INDEX IF NOT EXISTS calendar_entry_tags_tag_idx ON calendar_entry_tags(tag_id);
    CREATE TABLE IF NOT EXISTS calendar_weekly_items(team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),week_start TEXT NOT NULL,task_id TEXT NOT NULL,title TEXT NOT NULL,imported_at TEXT NOT NULL,PRIMARY KEY(team_id,user_id,week_start,task_id));
    CREATE INDEX IF NOT EXISTS calendar_weekly_scope_idx ON calendar_weekly_items(team_id,week_start,user_id);
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,team_id TEXT REFERENCES teams(id),actor_id TEXT NOT NULL REFERENCES users(id),action TEXT NOT NULL,target TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS audit_team_idx ON audit(team_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_system_idx ON audit(team_id,created_at DESC,id DESC) WHERE team_id IS NULL;
    DROP INDEX IF EXISTS audit_created_idx;
    DROP INDEX IF EXISTS audit_cleanup_idx;
    CREATE INDEX IF NOT EXISTS audit_cleanup_team_idx ON audit(team_id,created_at DESC,id DESC) WHERE action='history-cleanup';
    CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES users(id),response TEXT NOT NULL,created_at TEXT NOT NULL);
    DROP INDEX IF EXISTS operations_cell_created_idx;
    CREATE INDEX IF NOT EXISTS operations_cell_team_created_idx ON operations((CASE WHEN json_array_length(response,'$.refs')=1 THEN json_extract(response,'$.refs[0].teamId') ELSE NULL END),created_at,id) WHERE json_extract(response,'$.kind') IN ('cell-audit','format-audit');
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
  });
  pruneStyles(db);
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
