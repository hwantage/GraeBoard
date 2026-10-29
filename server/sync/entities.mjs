import { channel } from "node:diagnostics_channel";
import { splitReportRecord, applicationEntities } from "./versions.mjs";
import { expandStyle } from "../../shared/compact.js";
import {
  parse,
  teamSettings,
  readFormatting,
  styleWriter,
  writeFormatting,
  nextTaskStamp,
  json,
} from "../db.mjs";
import {
  readReport,
  withReportDocumentReferences,
  reportDocumentContents,
  storeDocumentVersion,
  syncReportDocuments,
  storeReportDocuments,
} from "../document-storage.mjs";
import { encodeReport, decodeReport } from "../reports.mjs";
import { hasDocumentContent } from "../../shared/task-documents.js";
import { entityId, initialToken, equal } from "./protocol.mjs";

const reportDecoded = channel("graeboard.sync.report.decode");
const one = (db, sql, ...args) => db.prepare(sql).get(...args);
const rows = (db, sql, ...args) => db.prepare(sql).all(...args);
const style = (db, id, cache) => {
  if (cache?.has(id)) return cache.get(id);
  const value = expandStyle(
    JSON.parse(one(db, "SELECT data FROM styles WHERE id=?", id)?.data || "{}"),
  );
  cache?.set(id, value);
  return value;
};
// One immutable report snapshot per capture phase. Before and after phases
// own separate maps, so a changed BLOB can never reuse an earlier decoded body.
function reportSnapshot(db, teamId, reportId, cache) {
  const key = teamId + ":" + reportId;
  if (cache?.has(key)) return cache.get(key);
  const row = one(
    db,
    "SELECT * FROM reports WHERE team_id=? AND id=?",
    teamId,
    reportId,
  );
  if (!row) {
    cache?.set(key, null);
    return null;
  }
  const data = decodeReport(row.data),
    tasks = new Map(),
    documents = new Map();
  reportDecoded.publish({ teamId, reportId });
  for (const task of data.tasks) {
    tasks.set(task.id, task);
    for (const [position, document] of (task.documents || []).entries())
      documents.set(JSON.stringify([task.id, document.id]), {
        ...document,
        position,
      });
  }
  const bodies = new Map(
    rows(
      db,
      "SELECT d.task_id,d.document_id,v.markdown FROM report_documents d JOIN document_versions v ON v.id=d.version_id WHERE d.report_id=?",
      reportId,
    ).map((entry) => [
      JSON.stringify([entry.task_id, entry.document_id]),
      entry.markdown,
    ]),
  );
  const result = { row, data, tasks, documents, bodies };
  cache?.set(key, result);
  return result;
}
export function readEntity(db, teamId, entity, key, { styles, reports } = {}) {
  let r, p;
  const [a, b, c, d] = key;
  switch (entity) {
    case "team":
      r = one(db, "SELECT * FROM teams WHERE id=?", teamId);
      if (r) {
        const settings = teamSettings(r);
        delete settings.revision;
        p = { name: r.name, settings };
      }
      break;
    case "person":
      r = one(db, "SELECT name FROM users WHERE id=?", a);
      if (r) p = { name: r.name };
      break;
    case "task":
      r = one(db, "SELECT * FROM tasks WHERE id=? AND team_id=?", a, teamId);
      if (r)
        p = {
          years: parse(r.years),
          position: r.position,
          defaultStyle: style(db, r.default_style, styles),
          rowStyle: style(db, r.row_style, styles),
          createdBy: r.created_by,
          createdAt: r.created_at,
          deletedAt: r.deleted_at,
        };
      break;
    case "cell":
      r = one(
        db,
        "SELECT c.* FROM cells c JOIN tasks t ON t.id=c.task_id WHERE t.team_id=? AND c.task_id=? AND c.key=?",
        teamId,
        a,
        b,
      );
      if (r)
        p = { value: parse(r.value, ""), style: style(db, r.style_id, styles) };
      break;
    case "formats":
      p = { rules: readFormatting(db, teamId).rules };
      break;
    case "document": {
      if (a === "task")
        r = one(
          db,
          "SELECT d.*,v.markdown FROM task_documents d JOIN tasks t ON t.id=d.task_id JOIN document_versions v ON v.id=d.version_id WHERE t.team_id=? AND d.task_id=? AND d.id=?",
          teamId,
          b,
          c,
        );
      if (a === "annual")
        r = one(
          db,
          "SELECT d.*,v.markdown FROM annual_memos d JOIN document_versions v ON v.id=d.version_id WHERE d.team_id=? AND d.year=? AND d.id=?",
          teamId,
          Number(b),
          c,
        );
      if (a === "reportMemo")
        r = one(
          db,
          "SELECT d.*,v.markdown FROM report_memos d JOIN reports t ON t.id=d.report_id JOIN document_versions v ON v.id=d.version_id WHERE t.team_id=? AND d.report_id=? AND d.id=?",
          teamId,
          b,
          c,
        );
      if (a === "calendar")
        r = one(
          db,
          "SELECT e.title,0 AS position,COALESCE(v.markdown,'') AS markdown FROM calendar_entries e LEFT JOIN document_versions v ON v.id=e.version_id WHERE e.team_id=? AND e.id=?",
          teamId,
          b,
        );
      if (a === "report") {
        const snapshot = reportSnapshot(db, teamId, b, reports),
          id = JSON.stringify([c, d]),
          document = snapshot?.documents.get(id);
        if (document && snapshot.bodies.has(id))
          r = {
            title: document.title,
            position: document.position,
            markdown: snapshot.bodies.get(id),
          };
      }
      if (r) p = { title: r.title, position: r.position, markdown: r.markdown };
      break;
    }
    case "report": {
      const snapshot = reportSnapshot(db, teamId, a, reports);
      if (snapshot) {
        const r = snapshot.row,
          data = {
            ...snapshot.data,
            tasks: withReportDocumentReferences(
              db,
              r.id,
              snapshot.data.tasks,
              true,
            ).map((t) => ({
              ...t,
              documents: (t.documents || []).map((doc) => ({
                id: doc.id,
                title: doc.title,
              })),
            })),
          };
        p = {
          year: r.year,
          name: r.name,
          referenceDate: r.reference_date,
          createdBy: r.created_by,
          createdAt: r.created_at,
          data,
        };
      }
      break;
    }
    case "calendar":
      r = one(
        db,
        "SELECT * FROM calendar_entries WHERE team_id=? AND id=?",
        teamId,
        a,
      );
      if (r)
        p = {
          userId: r.user_id,
          date: r.date,
          endDate: r.end_date,
          lane: r.lane,
          title: r.title,
          deletedAt: r.deleted_at,
          tags: rows(
            db,
            "SELECT tag_id AS id,checked FROM calendar_entry_tags WHERE entry_id=? ORDER BY position",
            a,
          ).map((x) => ({ ...x, checked: !!x.checked })),
        };
      break;
    case "tag":
      r = one(
        db,
        "SELECT * FROM calendar_tags WHERE team_id=? AND id=?",
        teamId,
        a,
      );
      if (r)
        p = { userId: r.user_id, name: r.name, color: r.color, kind: r.kind };
      break;
    case "rule":
      r = one(db, "SELECT * FROM calendar_rules WHERE team_id=?", teamId);
      if (r)
        p = {
          propertyId: r.property_id,
          values: parse(r.filter_values),
          mode: r.filter_mode,
        };
      break;
    case "weekly":
      r = one(
        db,
        "SELECT title FROM calendar_weekly_items WHERE team_id=? AND user_id=? AND week_start=? AND task_id=?",
        teamId,
        a,
        b,
        c,
      );
      if (r) p = { title: r.title };
      break;
    case "filter":
      r = one(
        db,
        "SELECT name,data FROM saved_filters WHERE team_id=? AND id=? AND scope='team'",
        teamId,
        a,
      );
      if (r) p = { name: r.name, data: parse(r.data) };
      break;
    default:
      throw new Error("Unknown sync entity");
  }
  return p === undefined
    ? null
    : {
        entity,
        key,
        payload: p,
        deleted: ["task", "calendar"].includes(entity) && !!p.deletedAt,
      };
}
function allEntityKeys(db, teamId, reports) {
  const keys = [
    ["team", []],
    ["formats", []],
  ];
  const add = (type, key) => keys.push([type, key]);
  for (const r of rows(db, "SELECT * FROM tasks WHERE team_id=?", teamId)) {
    add("task", [r.id]);
    for (const x of rows(db, "SELECT key FROM cells WHERE task_id=?", r.id))
      add("cell", [r.id, x.key]);
    for (const x of rows(
      db,
      "SELECT id FROM task_documents WHERE task_id=?",
      r.id,
    ))
      add("document", ["task", r.id, x.id]);
  }
  for (const r of rows(
    db,
    "SELECT * FROM annual_memos WHERE team_id=?",
    teamId,
  ))
    add("document", ["annual", String(r.year), r.id]);
  for (const r of rows(db, "SELECT * FROM reports WHERE team_id=?", teamId)) {
    add("report", [r.id]);
    for (const t of reportSnapshot(db, teamId, r.id, reports).data.tasks)
      for (const d of t.documents || [])
        add("document", ["report", r.id, t.id, d.id]);
    for (const m of rows(
      db,
      "SELECT id FROM report_memos WHERE report_id=?",
      r.id,
    ))
      add("document", ["reportMemo", r.id, m.id]);
  }
  for (const r of rows(
    db,
    "SELECT id FROM calendar_entries WHERE team_id=?",
    teamId,
  )) {
    add("calendar", [r.id]);
    add("document", ["calendar", r.id, "main"]);
  }
  for (const r of rows(
    db,
    "SELECT id FROM calendar_tags WHERE team_id=?",
    teamId,
  ))
    add("tag", [r.id]);
  if (one(db, "SELECT team_id FROM calendar_rules WHERE team_id=?", teamId))
    add("rule", []);
  for (const r of rows(
    db,
    "SELECT * FROM calendar_weekly_items WHERE team_id=?",
    teamId,
  ))
    add("weekly", [r.user_id, r.week_start, r.task_id]);
  for (const r of rows(
    db,
    "SELECT id FROM saved_filters WHERE team_id=? AND scope='team'",
    teamId,
  ))
    add("filter", [r.id]);
  // Display references, never passwords, activation or membership permissions.
  const people = new Set(
    rows(db, "SELECT user_id FROM memberships WHERE team_id=?", teamId).map(
      (r) => r.user_id,
    ),
  );
  // Values are visited once. The complete entity pass below also gathers
  // historical/non-member display references without a users×cells scan.
  for (const id of people) add("person", [id]);
  return keys;
}
export function allEntities(db, link) {
  const result = {},
    reports = new Map(),
    styles = new Map(),
    people = new Set(),
    known = new Set(rows(db, "SELECT id FROM users").map((row) => row.id));
  const remember = (value) => {
    if (typeof value === "string") {
      if (known.has(value)) people.add(value);
    } else if (Array.isArray(value)) value.forEach(remember);
    else if (value && typeof value === "object")
      Object.values(value).forEach(remember);
  };
  const add = (entity, key) => {
    const record = readEntity(db, link.team_id, entity, key, {
      reports,
      styles,
    });
    if (!record) return;
    const token = initialToken(link.bootstrap_id, entity, key);
    result[entityId(entity, key)] = {
      ...record,
      generation: token,
      version: token,
    };
    if (entity === "weekly") remember(key[0]);
    remember(record.payload);
  };
  for (const [entity, key] of allEntityKeys(db, link.team_id, reports))
    add(entity, key);
  for (const id of people)
    if (!result[entityId("person", [id])]) add("person", [id]);
  const marker = one(
    db,
    "SELECT generation,version,payload,deleted FROM sync_entities WHERE team_id=? AND entity='protocol' AND entity_key='[]'",
    link.team_id,
  );
  if (marker && JSON.parse(marker.payload).version === 2) {
    const expanded = {};
    for (const record of Object.values(result))
      for (const child of splitReportRecord(record)) {
        const token = initialToken(link.bootstrap_id, child.entity, child.key);
        expanded[entityId(child.entity, child.key)] = {
          ...child,
          generation: token,
          version: token,
        };
      }
    expanded[entityId("protocol", [])] = {
      entity: "protocol",
      key: [],
      generation: marker.generation,
      version: marker.version,
      payload: JSON.parse(marker.payload),
      deleted: !!marker.deleted,
    };
    return expanded;
  }
  return result;
}
function documentTarget(key) {
  const [type, a, b, c] = key;
  if (type === "task")
    return {
      table: "task_documents",
      where: "task_id=? AND id=?",
      args: [a, b],
      columns: ["task_id", "id"],
    };
  if (type === "annual")
    return {
      table: "annual_memos",
      where: "team_id=? AND year=? AND id=?",
      args: [null, Number(a), b],
      columns: ["team_id", "year", "id"],
    };
  if (type === "reportMemo")
    return {
      table: "report_memos",
      where: "report_id=? AND id=?",
      args: [a, b],
      columns: ["report_id", "id"],
    };
  return null;
}
export function materializeEntity(
  db,
  teamId,
  e,
  { actorId, stamp = new Date().toISOString() } = {},
) {
  const [a, b, c, d] = e.key,
    p = e.payload,
    dead = e.deleted;
  let sql, args, r;
  const ownedTables = {
    task: "tasks",
    report: "reports",
    calendar: "calendar_entries",
    tag: "calendar_tags",
    filter: "saved_filters",
  };
  const ownedTable = ownedTables[e.entity];
  if (ownedTable) {
    const owner = one(db, `SELECT team_id FROM ${ownedTable} WHERE id=?`, a);
    if (owner && owner.team_id !== teamId)
      throw new Error("Foreign team entity identity collision");
  }

  if (e.entity === "person") {
    db.prepare(
      "INSERT INTO users(id,username,name,password,active,created_at) VALUES(?,?,?,'!',0,?) ON CONFLICT(id) DO NOTHING",
    ).run(a, "sync-" + a + "@invalid.local", p.name, stamp);
    db.prepare(
      "INSERT INTO sync_person_refs(team_id,person_id,profile,local_user_id) VALUES(?,?,?,?) ON CONFLICT(team_id,person_id) DO UPDATE SET profile=excluded.profile",
    ).run(teamId, a, JSON.stringify(p), a);
    return;
  }
  actorId ||= p?.createdBy || one(db, "SELECT id FROM users LIMIT 1")?.id;
  if (e.entity === "team") {
    if (dead) throw new Error("Remote team deletion forbidden");
    r = one(db, "SELECT settings FROM teams WHERE id=?", teamId);
    const settings = {
      ...p.settings,
      revision: (r ? teamSettings(r).revision || 0 : 0) + 1,
    };
    db.prepare("UPDATE teams SET name=?,settings=? WHERE id=?").run(
      p.name,
      json(settings),
      teamId,
    );
    return;
  }
  if (e.entity === "task") {
    r = one(
      db,
      "SELECT updated_at FROM tasks WHERE team_id=? AND id=?",
      teamId,
      a,
    );
    const write = styleWriter(db);
    db.prepare(
      "INSERT INTO tasks(id,team_id,years,position,deleted_at,default_style,row_style,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET years=excluded.years,position=excluded.position,deleted_at=excluded.deleted_at,default_style=excluded.default_style,row_style=excluded.row_style,updated_at=excluded.updated_at",
    ).run(
      a,
      teamId,
      json(p.years),
      p.position,
      dead ? p.deletedAt || stamp : null,
      write(p.defaultStyle),
      write(p.rowStyle),
      p.createdBy,
      p.createdAt,
      r ? nextTaskStamp(r.updated_at) : stamp,
    );
    return;
  }
  if (e.entity === "cell") {
    r = one(db, "SELECT version FROM cells WHERE task_id=? AND key=?", a, b);
    const high =
      one(
        db,
        "SELECT revision FROM site_entity_revisions WHERE team_id=? AND entity=? AND entity_key=?",
        teamId,
        "cell",
        JSON.stringify(e.key),
      )?.revision || 0;
    db.prepare(
      "INSERT INTO cells(task_id,key,value,style_id,version) VALUES(?,?,?,?,?) ON CONFLICT(task_id,key) DO UPDATE SET value=excluded.value,style_id=excluded.style_id,version=excluded.version",
    ).run(
      a,
      b,
      json(dead ? "" : p.value),
      styleWriter(db)(dead ? {} : p.style),
      Math.max(r?.version || 0, high) + 1,
    );
    return;
  }
  if (e.entity === "formats") {
    writeFormatting(db, teamId, {
      rules: dead ? [] : p.rules,
      revision: readFormatting(db, teamId).revision + 1,
    });
    return;
  }
  if (e.entity === "report") {
    if (dead) {
      db.prepare("DELETE FROM reports WHERE team_id=? AND id=?").run(teamId, a);
      return;
    }
    const bodies = new Map(
      rows(
        db,
        "SELECT d.task_id,d.document_id,v.markdown FROM report_documents d JOIN document_versions v ON v.id=d.version_id WHERE d.report_id=?",
        a,
      ).map((row) => [
        JSON.stringify([row.task_id, row.document_id]),
        row.markdown,
      ]),
    );
    const data = {
      ...p.data,
      tasks: p.data.tasks.map((t) => ({
        ...t,
        documents: (t.documents || []).map((doc) => ({
          ...doc,
          markdown: bodies.get(JSON.stringify([t.id, doc.id])) || "",
        })),
      })),
    };
    data.tasks = storeReportDocuments(db, data.tasks, teamId, actorId);
    db.prepare(
      "INSERT INTO reports VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET year=excluded.year,name=excluded.name,reference_date=excluded.reference_date,data=excluded.data",
    ).run(
      a,
      teamId,
      p.year,
      p.name,
      p.referenceDate,
      p.createdBy,
      p.createdAt,
      encodeReport(data),
    );
    syncReportDocuments(db, a, data.tasks);
    return;
  }
  if (e.entity === "document") {
    const target = documentTarget(e.key);
    if (target) {
      if (a === "annual") target.args[0] = teamId;
      r = one(
        db,
        `SELECT revision FROM ${target.table} WHERE ${target.where}`,
        ...target.args,
      );
      if (dead) {
        db.prepare(`DELETE FROM ${target.table} WHERE ${target.where}`).run(
          ...target.args,
        );
        return;
      }
      const high =
        one(
          db,
          "SELECT revision FROM site_entity_revisions WHERE team_id=? AND entity=? AND entity_key=?",
          teamId,
          "document",
          JSON.stringify(e.key),
        )?.revision || 0;
      const version = storeDocumentVersion(db, {
        teamId,
        documentId: JSON.stringify(e.key),
        markdown: p.markdown,
        actorId,
      });
      const cols = [
        ...target.columns,
        "title",
        "position",
        "version_id",
        "has_content",
        "revision",
        "updated_at",
        "actor_id",
      ];
      db.prepare(
        `INSERT INTO ${target.table}(${cols}) VALUES(${cols.map(() => "?")}) ON CONFLICT(${target.columns}) DO UPDATE SET title=excluded.title,position=excluded.position,version_id=excluded.version_id,has_content=excluded.has_content,revision=excluded.revision,updated_at=excluded.updated_at,actor_id=excluded.actor_id,operation_id=NULL,request_hash=NULL`,
      ).run(
        ...target.args,
        p.title,
        p.position,
        version,
        Number(hasDocumentContent(p.markdown)),
        Math.max(r?.revision || 0, high) + 1,
        stamp,
        actorId,
      );
      return;
    }
    if (a === "calendar") {
      if (dead) return;
      const v = storeDocumentVersion(db, {
        teamId,
        documentId: JSON.stringify(e.key),
        markdown: p.markdown,
        actorId,
      });
      db.prepare(
        "UPDATE calendar_entries SET version_id=?,revision=revision+1,preview=?,updated_at=?,actor_id=?,operation_id=NULL,request_hash=NULL WHERE team_id=? AND id=?",
      ).run(v, p.markdown.slice(0, 200), stamp, actorId, teamId, b);
      return;
    }
    if (a === "report") {
      if (dead) {
        db.prepare(
          "DELETE FROM report_documents WHERE report_id=? AND task_id=? AND document_id=?",
        ).run(b, c, d);
        return;
      }
      const v = storeDocumentVersion(db, {
        teamId,
        documentId: JSON.stringify(e.key),
        markdown: p.markdown,
        actorId,
      });
      db.prepare(
        "INSERT INTO report_documents VALUES(?,?,?,?) ON CONFLICT(report_id,task_id,document_id) DO UPDATE SET version_id=excluded.version_id",
      ).run(b, c, d, v);
      return;
    }
  }
  if (e.entity === "calendar") {
    db.prepare(
      "INSERT INTO calendar_entries(id,team_id,user_id,date,end_date,lane,title,updated_at,actor_id,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,date=excluded.date,end_date=excluded.end_date,lane=excluded.lane,title=excluded.title,deleted_at=excluded.deleted_at,updated_at=excluded.updated_at,actor_id=excluded.actor_id,revision=calendar_entries.revision+1",
    ).run(
      a,
      teamId,
      p.userId,
      p.date,
      p.endDate,
      p.lane,
      p.title,
      stamp,
      actorId,
      dead ? p.deletedAt || stamp : null,
    );
    db.prepare("DELETE FROM calendar_entry_tags WHERE entry_id=?").run(a);
    for (const [i, t] of (p.tags || []).entries())
      db.prepare("INSERT INTO calendar_entry_tags VALUES(?,?,?,?)").run(
        a,
        t.id,
        i,
        Number(t.checked),
      );
    return;
  }
  if (e.entity === "tag") {
    if (dead) {
      db.prepare("DELETE FROM calendar_tags WHERE team_id=? AND id=?").run(
        teamId,
        a,
      );
      return;
    }
    db.prepare(
      "INSERT INTO calendar_tags VALUES(?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,kind=excluded.kind,revision=calendar_tags.revision+1",
    ).run(a, teamId, p.userId, p.name, p.color, p.kind);
    return;
  }
  if (e.entity === "rule") {
    if (dead) {
      db.prepare("DELETE FROM calendar_rules WHERE team_id=?").run(teamId);
      return;
    }
    db.prepare(
      "INSERT INTO calendar_rules VALUES(?,?,?,?,1) ON CONFLICT(team_id) DO UPDATE SET property_id=excluded.property_id,filter_values=excluded.filter_values,filter_mode=excluded.filter_mode,revision=calendar_rules.revision+1",
    ).run(teamId, p.propertyId, json(p.values), p.mode);
    return;
  }
  if (e.entity === "weekly") {
    if (dead)
      db.prepare(
        "DELETE FROM calendar_weekly_items WHERE team_id=? AND user_id=? AND week_start=? AND task_id=?",
      ).run(teamId, a, b, c);
    else
      db.prepare(
        "INSERT INTO calendar_weekly_items VALUES(?,?,?,?,?,?) ON CONFLICT(team_id,user_id,week_start,task_id) DO UPDATE SET title=excluded.title",
      ).run(teamId, a, b, c, p.title, stamp);
    return;
  }
  if (e.entity === "filter") {
    if (dead)
      db.prepare(
        "DELETE FROM saved_filters WHERE team_id=? AND id=? AND scope='team'",
      ).run(teamId, a);
    else
      db.prepare(
        "INSERT INTO saved_filters VALUES(?,?,'team',NULL,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,updated_at=excluded.updated_at",
      ).run(a, teamId, p.name, json(p.data), stamp);
    return;
  }
  throw new Error("Unsupported materialization " + e.entity);
}
export function materialize(db, teamId, entities, previous = {}, options = {}) {
  entities = applicationEntities(entities);
  previous = applicationEntities(previous);
  const retiredKeys = new Set(options.retiredKeys || []);
  const order = [
    "person",
    "team",
    "task",
    "tag",
    "formats",
    "report",
    "calendar",
    "cell",
    "document",
    "rule",
    "weekly",
    "filter",
  ];
  const changes = Object.entries(entities).filter(
    ([k, e]) =>
      !equal(e.payload, previous[k]?.payload) ||
      e.deleted !== previous[k]?.deleted,
  );
  changes.sort(
    ([aKey, a], [bKey, b]) =>
      (retiredKeys.has(aKey)
        ? -100 - order.indexOf(a.entity)
        : a.deleted && !["task", "calendar"].includes(a.entity)
          ? 100 - order.indexOf(a.entity)
          : order.indexOf(a.entity)) -
      (retiredKeys.has(bKey)
        ? -100 - order.indexOf(b.entity)
        : b.deleted && !["task", "calendar"].includes(b.entity)
          ? 100 - order.indexOf(b.entity)
          : order.indexOf(b.entity)),
  );
  for (const [, e] of changes) materializeEntity(db, teamId, e, options);
  return changes.map(([key]) => key);
}
