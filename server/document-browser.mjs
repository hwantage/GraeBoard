import { retentionView } from "./sync/visibility.mjs";
import { z } from "zod";
import { parse } from "./db.mjs";
import { yearSchema, requireThat } from "./validation.mjs";
import {
  defaultView,
  displayValue,
  filteredTasks,
  groupValue,
  propertiesFor,
} from "../shared/domain.js";
import { reportBrowseIndex, reportUsersWithAvatars } from "./reports.mjs";
import { readReport } from "./document-storage.mjs";
import { reportRevision } from "./report-editing.mjs";

const sourceSchema = z.union([z.literal("live"), z.string().uuid()]);
const querySchema = z.object({
  teamId: z.string().uuid(),
  year: yearSchema,
  q: z.string().trim().max(200).default(""),
  source: sourceSchema.optional(),
  groupBy: z.string().max(80).default(""),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

const previewInputLength = 1024;
const previewLength = 240;
function documentPreview(markdown) {
  const text = markdown
    .slice(0, previewInputLength)
    .replace(/^[ \t]*(?:`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/!\[([^\]\n]*)\]\([^)]*\)/g, (_, alt) => alt || "이미지")
    .replace(/\[([^\]\n]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\n]+>/g, "")
    .replace(/^[ \t]*(?:#{1,6}|>|[-+*]|\d+[.)])(?:[ \t]+|$)/gm, "")
    .replace(/^[ \t]*\[[ xX]\][ \t]*/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(text);
  return characters.length > previewLength ||
    markdown.length > previewInputLength
    ? `${characters
        .slice(0, previewLength - 1)
        .join("")
        .trimEnd()}…`
    : text;
}

// Only persisted tabs count. The virtual blank "main" tab is never registered.
export function installDocumentBrowserRoutes(
  app,
  { db, teamAccess, taskAccess, teamUsers, referencedUsers },
) {
  function scope(req) {
    const query = querySchema.parse(req.query);
    const team = teamAccess(req.user, query.teamId);
    return { ...query, team };
  }
  const liveWhere = `t.team_id=? AND t.deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM json_each(t.years) WHERE value=?)`;
  function reportRow(id, teamId) {
    const row = db
      .prepare("SELECT * FROM reports WHERE id=? AND team_id=?")
      .get(id, teamId);
    requireThat(row, 404, "사본을 찾을 수 없습니다.");
    return row;
  }
  app.get("/api/document-browser/sources", (req, res) => {
    const s = scope(req);
    const live = db
      .prepare(
        `SELECT COUNT(DISTINCT t.id) AS taskCount, COUNT(*) AS documentCount
      FROM tasks t JOIN task_documents d ON d.task_id=t.id WHERE ${liveWhere}`,
      )
      .get(s.teamId, s.year);
    const reports = db
      .prepare(
        `SELECT r.id,r.name,COUNT(DISTINCT d.task_id) AS taskCount,COUNT(d.document_id) AS documentCount
      FROM reports r LEFT JOIN report_documents d ON d.report_id=r.id
      WHERE r.team_id=? AND r.year=? GROUP BY r.id ORDER BY r.created_at DESC,r.id`,
      )
      .all(s.teamId, s.year);
    const visibility = retentionView(db, s.teamId);
    if (visibility.active) {
      // Keep the source badges consistent with the filtered document pages.
      // The usual path retains its aggregate-only queries when L is empty.
      const counts = new Map([
        ["live", { tasks: new Set(), documents: 0 }],
        ...reports.map((report) => [
          report.id,
          { tasks: new Set(), documents: 0 },
        ]),
      ]);
      for (const row of db
        .prepare(
          `SELECT t.id AS taskId,d.id AS documentId FROM tasks t
         JOIN task_documents d ON d.task_id=t.id WHERE ${liveWhere}`,
        )
        .all(s.teamId, s.year)) {
        if (visibility.hidden("document", ["task", row.taskId, row.documentId]))
          continue;
        const count = counts.get("live");
        count.tasks.add(row.taskId);
        count.documents++;
      }
      for (const row of db
        .prepare(
          `SELECT d.report_id AS reportId,d.task_id AS taskId,d.document_id AS documentId
         FROM report_documents d JOIN reports r ON r.id=d.report_id
         WHERE r.team_id=? AND r.year=?`,
        )
        .all(s.teamId, s.year)) {
        if (
          visibility.hidden("document", [
            "report",
            row.reportId,
            row.taskId,
            row.documentId,
          ])
        )
          continue;
        const count = counts.get(row.reportId);
        count.tasks.add(row.taskId);
        count.documents++;
      }
      const liveCount = counts.get("live");
      live.taskCount = liveCount.tasks.size;
      live.documentCount = liveCount.documents;
      for (const report of reports) {
        const count = counts.get(report.id);
        report.taskCount = count.tasks.size;
        report.documentCount = count.documents;
      }
    }
    res.json({ sources: [{ id: "live", name: "원본", ...live }, ...reports] });
  });
  app.get("/api/document-browser/tasks", (req, res) => {
    const s = scope(req);
    const source = sourceSchema.parse(s.source);
    let tasks, settings, users;
    // Search task names only; document bodies are read for page-sized previews.
    const needle = s.q.toLowerCase();
    if (source === "live") {
      settings = s.team.settings;
      users = referencedUsers(s.teamId);
      tasks = db
        .prepare(
          `SELECT t.id,t.position,t.created_at AS createdAt FROM tasks t
        WHERE ${liveWhere} AND EXISTS(SELECT 1 FROM task_documents d WHERE d.task_id=t.id)`,
        )
        .all(s.teamId, s.year);
      const byId = new Map(
        tasks.map((task) => [
          task.id,
          Object.assign(task, { cells: {}, documents: [] }),
        ]),
      );
      const ids = JSON.stringify(tasks.map((task) => task.id));
      for (const c of db
        .prepare(
          `SELECT task_id,key,value FROM cells WHERE task_id IN (SELECT value FROM json_each(?))
        AND key IN (SELECT value FROM json_each(?))`,
        )
        .all(
          ids,
          JSON.stringify(propertiesFor(settings, true).map((p) => p.id)),
        ))
        byId.get(c.task_id).cells[c.key] = { value: parse(c.value, "") };
      for (const d of db
        .prepare(
          `SELECT d.task_id,d.id,d.title,d.has_content AS hasContent
        FROM task_documents d
        WHERE d.task_id IN (SELECT value FROM json_each(?)) ORDER BY d.position,d.id`,
        )
        .all(ids)) {
        const { task_id, ...doc } = d;
        byId.get(task_id).documents.push(doc);
      }
    } else {
      const row = reportRow(source, s.teamId);
      requireThat(row.year === s.year, 404, "선택한 연도의 사본이 아닙니다.");
      const index = reportBrowseIndex(row.data);
      settings = index.settings;
      users = index.users;
      // Current versions live in report_documents, independently of the BLOB.
      const refs = new Map(
        db
          .prepare(
            `SELECT d.task_id,d.document_id,v.has_content AS hasContent
        FROM report_documents d JOIN document_versions v ON v.id=d.version_id WHERE d.report_id=?`,
          )
          .all(source)
          .map((d) => [`${d.task_id}:${d.document_id}`, d]),
      );
      tasks = [...index.tasks.values()]
        .filter((task) => task.documents.length)
        .map((task) => ({
          ...task,
          documents: task.documents.map((doc) => {
            const ref = refs.get(`${task.id}:${doc.id}`);
            return {
              id: doc.id,
              title: doc.title,
              hasContent: !!ref?.hasContent,
            };
          }),
        }));
    }
    const visibility = retentionView(db, s.teamId);
    tasks = visibility.years.has(String(s.year))
      ? []
      : visibility.tasks(tasks, source === "live" ? undefined : source);
    tasks = tasks.filter((task) => task.documents.length);
    const groupBy = propertiesFor(settings).some((p) => p.id === s.groupBy)
      ? s.groupBy
      : "";
    const ordered = filteredTasks(
      tasks,
      { ...defaultView(s.year), groupBy },
      settings,
      users,
    );
    const groups = new Map();
    const matches = [];
    let documentCount = 0,
      matchedDocumentCount = 0;
    for (const task of ordered) {
      const key = groupBy ? groupValue(task, groupBy) : "";
      const label = groupBy
        ? displayValue(task, groupBy, users, settings) || "미입력"
        : "전체";
      if (!groups.has(key))
        groups.set(key, {
          key,
          label,
          taskCount: 0,
          documentCount: 0,
          matchedTaskCount: 0,
          matchedDocumentCount: 0,
        });
      const group = groups.get(key);
      group.taskCount++;
      group.documentCount += task.documents.length;
      documentCount += task.documents.length;
      const title = String(task.cells.title?.value || "제목 없는 업무");
      if (!title.toLowerCase().includes(needle)) continue;
      const documents = task.documents;
      group.matchedTaskCount++;
      group.matchedDocumentCount += documents.length;
      matchedDocumentCount += documents.length;
      matches.push({
        id: task.id,
        title,
        ownerId: String(task.cells.owner?.value || ""),
        documentCount: task.documents.length,
        documents,
        groupKey: key,
      });
    }
    const page = matches.slice(s.offset, s.offset + s.limit);
    const documents = page.flatMap((task) =>
      task.documents
        .filter((doc) => doc.hasContent)
        .map((doc) => [task.id, doc.id]),
    );
    const previews = new Map(
      documents.length
        ? db
            .prepare(
              `SELECT d.task_id,d.${source === "live" ? "id" : "document_id"} AS document_id,
              substr(v.markdown,1,${previewInputLength + 1}) AS excerpt
              FROM json_each(?) requested
              JOIN ${source === "live" ? "task_documents" : "report_documents"} d
                ON d.task_id=json_extract(requested.value,'$[0]')
                AND d.${source === "live" ? "id" : "document_id"}=json_extract(requested.value,'$[1]')
              JOIN document_versions v ON v.id=d.version_id
              ${source === "live" ? "" : "WHERE d.report_id=?"}`,
            )
            .all(
              JSON.stringify(documents),
              ...(source === "live" ? [] : [source]),
            )
            .map((doc) => [
              `${doc.task_id}:${doc.document_id}`,
              documentPreview(doc.excerpt),
            ])
        : [],
    );
    for (const task of page)
      for (const doc of task.documents)
        doc.preview = previews.get(`${task.id}:${doc.id}`) || "";
    // Send each visible owner's profile once per page, never once per task.
    const ownerIds = new Set(page.map((task) => task.ownerId).filter(Boolean));
    const pageUsers = [...ownerIds].map(
      (id) => users.find((user) => user.id === id) || { id, name: id },
    );
    const profiles =
      source === "live" ? pageUsers : reportUsersWithAvatars(db, pageUsers);
    res.json({
      tasks: page,
      owners: Object.fromEntries(
        profiles.map(({ id, name, color, avatarInitials, avatarImage }) => [
          id,
          { id, name, color, avatarInitials, avatarImage },
        ]),
      ),
      groups: [...groups.values()],
      taskCount: tasks.length,
      documentCount,
      matchedTaskCount: matches.length,
      matchedDocumentCount,
      nextOffset:
        s.offset + s.limit < matches.length ? s.offset + s.limit : null,
      properties: propertiesFor(settings).map(({ id, name }) => ({ id, name })),
    });
  });
  app.get("/api/document-browser/task", (req, res) => {
    const s = scope(req);
    const taskId = z.string().uuid().parse(req.query.taskId);
    const source = sourceSchema.parse(s.source);
    if (source === "live") {
      const task = taskAccess(req.user, taskId);
      requireThat(task.teamId === s.teamId, 404, "업무를 찾을 수 없습니다.");
      return res.json({
        task,
        settings: s.team.settings,
        users: referencedUsers(s.teamId),
      });
    }
    const row = reportRow(source, s.teamId);
    const report = readReport(db, row);
    const task = report.tasks.find((task) => task.id === taskId);
    requireThat(task, 404, "사본에서 해당 업무를 찾지 못했습니다.");
    const { documents, ...metadata } = task;
    const people = new Map(teamUsers(s.teamId).map((user) => [user.id, user]));
    for (const user of report.users)
      people.set(user.id, { ...people.get(user.id), ...user });
    res.json({
      task: metadata,
      settings: report.settings,
      users: [...people.values()],
      revision: reportRevision(row.data, report),
    });
  });
}
