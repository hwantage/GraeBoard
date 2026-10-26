import { requireThat } from "../validation.mjs";
import { canonical, entityId } from "./protocol.mjs";
import { isExcluded } from "./retention.mjs";

// L is a serving overlay. It never changes the canonical records or the full
// application rows used by capture and explicit shared deletion commands.
export function retentionView(db, teamId) {
  const exclusions = db
    .prepare("SELECT * FROM site_retention WHERE team_id=?")
    .all(teamId);
  const years = new Set(
    exclusions
      .filter((row) => row.kind === "year")
      .map((row) => String(JSON.parse(row.entity_key)[0])),
  );
  const records = {};
  function record(entity, key) {
    const id = entityId(entity, key);
    if (Object.hasOwn(records, id)) return records[id];
    let value;
    if (entity === "task") {
      const row = db
        .prepare("SELECT years FROM tasks WHERE team_id=? AND id=?")
        .get(teamId, key[0]);
      value = row
        ? { entity, key, payload: { years: JSON.parse(row.years) } }
        : null;
    } else if (entity === "report") {
      const row = db
        .prepare("SELECT year FROM reports WHERE team_id=? AND id=?")
        .get(teamId, key[0]);
      value = row ? { entity, key, payload: { year: row.year } } : null;
    } else value = { entity, key, payload: {} };
    if (value) {
      value.generation =
        db
          .prepare(
            "SELECT generation FROM sync_entities WHERE team_id=? AND entity=? AND entity_key=?",
          )
          .get(teamId, entity, canonical(key))?.generation || "";
    }
    return (records[id] = value);
  }
  function hidden(entity, key) {
    if (!exclusions.length) return false;
    const value = record(entity, key);
    if (entity === "cell") record("task", [key[0]]);
    if (entity === "document") {
      const [kind, owner] = key;
      if (kind === "task") record("task", [owner]);
      if (kind === "report" || kind === "reportMemo") record("report", [owner]);
      if (kind === "calendar") record("calendar", [owner]);
    }
    return isExcluded(value, records, exclusions);
  }
  const documents = (docs, owner) =>
    (docs || []).filter((doc) => !hidden("document", [...owner, doc.id]));
  function task(task, reportId) {
    if (!task) return task;
    if (!exclusions.length) return task;
    if (!reportId && hidden("task", [task.id])) return null;
    const result = { ...task };
    if (!reportId && result.years)
      result.years = result.years.filter((year) => !years.has(String(year)));
    if (result.documents)
      result.documents = documents(
        result.documents,
        reportId ? ["report", reportId, task.id] : ["task", task.id],
      );
    // Summaries must not advertise a document whose body is locally excluded.
    const rows = reportId
      ? db
          .prepare(
            "SELECT document_id AS id,v.has_content AS hasContent FROM report_documents d JOIN document_versions v ON v.id=d.version_id WHERE report_id=? AND task_id=?",
          )
          .all(reportId, task.id)
      : db
          .prepare(
            "SELECT id,has_content AS hasContent FROM task_documents WHERE task_id=?",
          )
          .all(task.id);
    if (rows?.length) {
      const visible = documents(
        rows,
        reportId ? ["report", reportId, task.id] : ["task", task.id],
      );
      result.documentCount = visible.length;
      result.hasDocument = visible.some((doc) => doc.hasContent);
    }
    return result;
  }
  return {
    active: exclusions.length > 0,
    revision: exclusions.reduce((n, row) => Math.max(n, row.revision), 0),
    years,
    hidden,
    documents,
    task,
    tasks: (tasks, reportId) =>
      tasks.map((value) => task(value, reportId)).filter(Boolean),
    requireVisible(entity, key) {
      requireThat(
        !hidden(entity, key),
        409,
        "이 사이트에서 정리한 자료입니다. 설정에서 복원한 뒤 사용하세요.",
      );
    },
    preserveYears(previous, next) {
      return [
        ...new Set([
          ...next,
          ...previous.filter((year) => years.has(String(year))),
        ]),
      ];
    },
  };
}

export function installRetentionBoundary(app, { db }) {
  app.use("/api", (req, res, next) => {
    const path = req.path;
    if (/^\/(?:admin|auth)\//.test(path) || /\/sync(?:\/|$)/.test(path))
      return next();
    let teamId = req.query.teamId || req.body?.teamId;
    let reportId, taskId, documentOwner, documentId;
    let match;
    if (
      (match = path.match(/^\/tasks\/([^/]+)(?:\/|$)/)) &&
      !["delete", "restore", "reorder"].includes(match[1])
    ) {
      taskId = match[1];
      teamId = db
        .prepare("SELECT team_id FROM tasks WHERE id=?")
        .get(taskId)?.team_id;
      const doc = path.match(
        /^\/tasks\/[^/]+\/(?:documents\/([^/]+)|document)(?:\/|$)/,
      );
      documentOwner = ["task", taskId];
      if (doc && doc[1] !== "events") documentId = doc[1] || "main";
    }
    if ((match = path.match(/^\/reports\/([^/]+)(?:\/|$)/))) {
      reportId = match[1];
      teamId = db
        .prepare("SELECT team_id FROM reports WHERE id=?")
        .get(reportId)?.team_id;
      const doc = path.match(
        /^\/reports\/[^/]+\/tasks\/([^/]+)\/(?:documents(?:\/([^/]+))?|document)(?:\/|$)/,
      );
      if (doc) {
        taskId = doc[1];
        documentOwner = ["report", reportId, taskId];
        if (doc[2] && doc[2] !== "events") documentId = doc[2];
        if (path.endsWith("/document")) documentId = "main";
      }
      const memo = path.match(/^\/reports\/[^/]+\/memos(?:\/([^/]+))?/);
      if (memo) {
        documentOwner = ["reportMemo", reportId];
        if (memo[1] && !["events", "reorder"].includes(memo[1]))
          documentId = memo[1];
      }
    }
    if (
      (match = path.match(
        /^\/teams\/([^/]+)\/years\/([^/]+)\/memos(?:\/([^/]+))?/,
      ))
    ) {
      teamId = match[1];
      documentOwner = ["annual", match[2]];
      if (match[3] && !["events", "reorder"].includes(match[3]))
        documentId = match[3];
    }
    if ((match = path.match(/^\/calendar\/entries\/([^/]+)(?:\/|$)/))) {
      teamId = db
        .prepare("SELECT team_id FROM calendar_entries WHERE id=?")
        .get(match[1])?.team_id;
      if (/\/document(?:\/|$)/.test(path)) {
        documentOwner = ["calendar", match[1]];
        documentId = "main";
      }
    }
    if (!teamId || typeof teamId !== "string") return next();
    const view = retentionView(db, teamId);
    if (!view.active) return next();
    req.retention = view;
    try {
      if (reportId) view.requireVisible("report", [reportId]);
      if (taskId && !reportId) view.requireVisible("task", [taskId]);
      if (documentId)
        view.requireVisible("document", [...documentOwner, documentId]);
      const year =
        documentOwner?.[0] === "annual" ? documentOwner[1] : req.body?.year;
      if (req.method !== "GET" && year != null)
        requireThat(
          !view.years.has(String(year)),
          409,
          "이 사이트에서 정리한 연도입니다. 설정에서 복원한 뒤 사용하세요.",
        );
      if (req.body?.reportId)
        view.requireVisible("report", [req.body.reportId]);
      if (req.body?.sourceId)
        view.requireVisible("report", [req.body.sourceId]);
      const original = res.json.bind(res);
      res.json = (data) => {
        if (res.statusCode >= 400 || !data || typeof data !== "object")
          return original(data);
        let output = { ...data };
        const source =
          reportId ||
          (req.query.source && req.query.source !== "live"
            ? req.query.source
            : undefined);
        if (Array.isArray(output.tasks))
          output.tasks = view.years.has(String(req.query.year))
            ? []
            : view.tasks(output.tasks, source);
        if (output.task) output.task = view.task(output.task, source);
        if (Array.isArray(output.documents) && documentOwner)
          output.documents = view.documents(output.documents, documentOwner);
        if (Array.isArray(output.reports))
          output.reports = output.reports.filter(
            (row) => !view.years.has(String(row.year)),
          );
        if (Array.isArray(output.sources))
          output.sources = output.sources.filter((row) =>
            row.id === "live"
              ? !view.years.has(String(req.query.year))
              : !view.hidden("report", [row.id]),
          );
        if (documentOwner?.[0] === "annual" && view.years.has(documentOwner[1]))
          output.documents = [];
        return original(output);
      };
      next();
    } catch (error) {
      next(error);
    }
  });
}
