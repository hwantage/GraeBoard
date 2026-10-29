import { AsyncLocalStorage } from "node:async_hooks";
import { requireThat } from "../validation.mjs";
import { canonical, digest } from "./protocol.mjs";

// A request may consult several repositories. Reuse its team overlay until any
// local or other-connection write changes the database; never retain it across
// requests or across an asynchronous document preparation race.
const contexts = new AsyncLocalStorage();
export function installRetentionContext(app) {
  app.use("/api", (_req, _res, next) => contexts.run(new WeakMap(), next));
}
export function withRetentionViews(work) {
  return contexts.run(new WeakMap(), work);
}
export function retentionView(db, teamId) {
  const scope = contexts.getStore();
  if (!scope) return createRetentionView(db, teamId);
  let teams = scope.get(db);
  if (!teams) scope.set(db, (teams = new Map()));
  const stamp = `${db.prepare("SELECT total_changes() n").get().n}:${db.prepare("PRAGMA data_version").get().data_version}`;
  const existing = teams.get(teamId);
  if (existing?.stamp === stamp) return existing.view;
  const view = createRetentionView(db, teamId);
  teams.set(teamId, { stamp, view });
  return view;
}

// L only changes serving. Canonical records, pending operations and application
// rows remain complete. Active overlays load metadata in sets instead of issuing
// task/document/generation queries for every row in an annual response.
function createRetentionView(db, teamId) {
  const exclusions = db
    .prepare("SELECT * FROM site_retention WHERE team_id=?")
    .all(teamId);
  const years = new Set(
    exclusions
      .filter((row) => row.kind === "year")
      .map((row) => String(JSON.parse(row.entity_key)[0])),
  );
  const documentExclusions = new Set(
    exclusions
      .filter((row) => row.kind === "document")
      .map((row) => canonical([JSON.parse(row.entity_key), row.generation])),
  );
  let taskYears, reportYears, generations, taskDocuments;
  const reportDocuments = new Map();
  function ownerYears(entity, id) {
    if (entity === "task") {
      taskYears ||= new Map(
        db
          .prepare("SELECT id,years FROM tasks WHERE team_id=?")
          .all(teamId)
          .map((row) => [row.id, JSON.parse(row.years)]),
      );
      return taskYears.get(id);
    }
    reportYears ||= new Map(
      db
        .prepare("SELECT id,year FROM reports WHERE team_id=?")
        .all(teamId)
        .map((row) => [row.id, row.year]),
    );
    return reportYears.get(id);
  }
  function hidden(entity, key) {
    if (!exclusions.length) return false;
    if (entity === "task") {
      const values = ownerYears(entity, key[0]);
      return (
        !!values?.length && values.every((year) => years.has(String(year)))
      );
    }
    if (entity === "report")
      return years.has(String(ownerYears(entity, key[0])));
    if (entity === "cell") return hidden("task", [key[0]]);
    if (entity !== "document") return false;
    if (documentExclusions.size) {
      generations ||= new Map(
        db
          .prepare(
            "SELECT entity_key,generation FROM sync_entities WHERE team_id=? AND entity='document'",
          )
          .all(teamId)
          .map((row) => [row.entity_key, row.generation]),
      );
      if (
        documentExclusions.has(
          canonical([key, generations.get(canonical(key)) || ""]),
        )
      )
        return true;
    }
    const [owner, id] = key;
    if (owner === "annual") return years.has(String(id));
    if (owner === "task") return hidden("task", [id]);
    if (owner.startsWith("report")) return hidden("report", [id]);
    return false;
  }
  const documents = (docs, owner) =>
    (docs || []).filter((doc) => !hidden("document", [...owner, doc.id]));
  const groupDocuments = (rows) => {
    const byTask = new Map();
    for (const row of rows) {
      if (!byTask.has(row.taskId)) byTask.set(row.taskId, []);
      byTask.get(row.taskId).push({ id: row.id, hasContent: !!row.hasContent });
    }
    return byTask;
  };
  function summaries(taskId, reportId) {
    if (reportId) {
      if (!reportDocuments.has(reportId))
        reportDocuments.set(
          reportId,
          groupDocuments(
            db
              .prepare(
                "SELECT d.task_id AS taskId,d.document_id AS id,v.has_content AS hasContent FROM report_documents d JOIN reports r ON r.id=d.report_id JOIN document_versions v ON v.id=d.version_id WHERE r.team_id=? AND d.report_id=?",
              )
              .all(teamId, reportId),
          ),
        );
      return reportDocuments.get(reportId).get(taskId) || [];
    }
    taskDocuments ||= groupDocuments(
      db
        .prepare(
          "SELECT d.task_id AS taskId,d.id,d.has_content AS hasContent FROM task_documents d JOIN tasks t ON t.id=d.task_id WHERE t.team_id=?",
        )
        .all(teamId),
    );
    return taskDocuments.get(taskId) || [];
  }
  function task(value, reportId) {
    if (!value || !exclusions.length) return value;
    if (!reportId && hidden("task", [value.id])) return null;
    const result = { ...value };
    if (!reportId && result.years)
      result.years = result.years.filter((year) => !years.has(String(year)));
    const owner = reportId
      ? ["report", reportId, value.id]
      : ["task", value.id];
    if (result.documents) result.documents = documents(result.documents, owner);
    const rows = summaries(value.id, reportId);
    if (rows.length) {
      const visible = documents(rows, owner);
      result.documentCount = visible.length;
      result.hasDocument = visible.some((doc) => doc.hasContent);
    }
    return result;
  }
  return {
    active: exclusions.length > 0,
    revision: exclusions.reduce((n, row) => Math.max(n, row.revision), 0),
    // Include the complete exclusion set: removing one of two rows with the
    // same maximum revision must also invalidate the filtered representation.
    cacheKey: exclusions.length
      ? digest(
          exclusions
            .map((row) => [
              row.kind,
              row.entity_key,
              row.generation,
              row.revision,
            ])
            .sort((a, b) => canonical(a).localeCompare(canonical(b))),
        )
      : "",
    years,
    hidden,
    documents,
    task,
    tasks: (values, reportId) =>
      values.map((value) => task(value, reportId)).filter(Boolean),
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
