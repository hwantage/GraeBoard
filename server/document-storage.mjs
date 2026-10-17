import { createHash, randomUUID } from "node:crypto";
import { hasDocumentContent } from "../shared/task-documents.js";
import { decodeReport, reportDocumentIndex } from "./reports.mjs";

// Bodies are immutable. Each sheet owns its document references and titles.
export function storeDocumentVersion(
  db,
  { teamId, documentId, markdown, actorId },
) {
  const hash = createHash("sha256").update(markdown).digest("hex");
  const previous = db
    .prepare(
      "SELECT id FROM document_versions WHERE team_id=? AND document_id=? AND content_hash=?",
    )
    .get(teamId, documentId, hash);
  if (previous) return previous.id;
  const versionId = randomUUID();
  db.prepare(
    "INSERT INTO document_versions(id,team_id,document_id,content_hash,markdown,has_content,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    versionId,
    teamId,
    documentId,
    hash,
    markdown,
    Number(hasDocumentContent(markdown)),
    new Date().toISOString(),
    actorId,
  );
  return versionId;
}

export function readDocumentVersion(db, versionId) {
  if (!versionId) return null;
  const version = db
    .prepare(
      "SELECT id,team_id AS teamId,document_id AS documentId,markdown,has_content AS hasContent,created_at AS createdAt FROM document_versions WHERE id=?",
    )
    .get(versionId);
  if (!version) throw new Error("문서 참조를 찾을 수 없습니다.");
  return version;
}

export function withTaskDocumentReferences(db, tasks) {
  const refs = new Map();
  for (let offset = 0; offset < tasks.length; offset += 500) {
    const ids = tasks.slice(offset, offset + 500).map((task) => task.id);
    for (const row of db
      .prepare(
        `SELECT task_id,id,title,version_id AS versionId,has_content AS hasContent FROM task_documents WHERE task_id IN (${ids.map(() => "?").join(",")}) ORDER BY position,id`,
      )
      .all(...ids)) {
      const { task_id, ...document } = row;
      if (!refs.has(task_id)) refs.set(task_id, []);
      refs.get(task_id).push(document);
    }
  }
  return tasks.map((task) => ({ ...task, documents: refs.get(task.id) || [] }));
}

// The relational references own the current body versions. The BLOB retains
// tab titles/order; a body autosave does not rewrite the sheet's cells.
export function withReportDocumentReferences(db, reportId, tasks, all = false) {
  if (!tasks.length) return [];
  const refs = new Map();
  const rows = db
    .prepare(
      `SELECT r.task_id,r.document_id,r.version_id AS versionId,v.has_content AS hasContent
     FROM report_documents r JOIN document_versions v ON v.id=r.version_id
     WHERE r.report_id=?${all ? "" : " AND r.task_id IN (SELECT value FROM json_each(?))"}`,
    )
    .all(
      reportId,
      ...(all ? [] : [JSON.stringify(tasks.map((task) => task.id))]),
    );
  for (const row of rows) {
    if (!refs.has(row.task_id)) refs.set(row.task_id, new Map());
    refs.get(row.task_id).set(row.document_id, row);
  }
  return tasks.map((task) => {
    const documents = (task.documents || []).map((doc) => {
      const ref = refs.get(task.id)?.get(doc.id);
      if (!ref) throw new Error("문서 참조를 찾을 수 없습니다.");
      return { ...doc, versionId: ref.versionId, hasContent: !!ref.hasContent };
    });
    return {
      ...task,
      documents,
      ...(documents.length || task.hasDocument !== undefined
        ? { hasDocument: documents.some((doc) => doc.hasContent) }
        : {}),
      documentCount: documents.length,
    };
  });
}

export function readReport(db, row) {
  const report = decodeReport(row.data);
  reportDocumentIndex(row.data, report);
  return {
    ...report,
    tasks: withReportDocumentReferences(db, row.id, report.tasks, true),
  };
}

export function reportDocumentTasks(db, row, taskIds) {
  const index = reportDocumentIndex(row.data);
  const tasks = taskIds.map((id) => index.get(id));
  if (tasks.some((task) => !task)) return null;
  return withReportDocumentReferences(db, row.id, tasks);
}

export function storeReportDocuments(db, tasks, teamId, actorId) {
  return tasks.map((task) => {
    const documents = (task.documents || []).map((doc) => {
      if (typeof doc.markdown !== "string") return doc;
      const previous = readDocumentVersion(db, doc.versionId);
      const versionId = storeDocumentVersion(db, {
        teamId,
        documentId: previous?.documentId || `${task.id}:${doc.id}`,
        markdown: doc.markdown,
        actorId,
      });
      return {
        id: doc.id,
        title: doc.title,
        versionId,
        hasContent: hasDocumentContent(doc.markdown),
      };
    });
    return {
      ...task,
      documents,
      hasDocument: documents.some((doc) => !!doc.hasContent),
      documentCount: documents.length,
    };
  });
}

// Reference cleanup is independent from the sheet's optimistic lock.
export function syncReportDocuments(db, reportId, tasks) {
  db.prepare("DELETE FROM report_documents WHERE report_id=?").run(reportId);
  const put = db.prepare(
    "INSERT INTO report_documents(report_id,task_id,document_id,version_id) VALUES(?,?,?,?)",
  );
  for (const task of tasks)
    for (const doc of task.documents || [])
      if (doc.versionId) put.run(reportId, task.id, doc.id, doc.versionId);
}

export function reportDocumentContents(db, report) {
  return {
    ...report,
    tasks: report.tasks.map((task) => ({
      ...task,
      documents: (task.documents || []).map((doc) => ({
        id: doc.id,
        title: doc.title,
        markdown: readDocumentVersion(db, doc.versionId).markdown,
      })),
    })),
  };
}

export function pruneDocumentVersions(db, teamId, versionIds) {
  if (versionIds && !versionIds.length) return;
  db.prepare(
    `DELETE FROM document_versions WHERE team_id=?
    ${versionIds ? "AND id IN (SELECT value FROM json_each(?))" : ""}
    AND NOT EXISTS(SELECT 1 FROM task_documents WHERE version_id=document_versions.id)
    AND NOT EXISTS(SELECT 1 FROM report_documents WHERE version_id=document_versions.id)`,
  ).run(teamId, ...(versionIds ? [JSON.stringify(versionIds)] : []));
}
