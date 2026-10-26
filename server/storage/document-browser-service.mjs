import { z } from "zod";
import { yearSchema } from "../validation.mjs";
import {
  defaultView,
  displayValue,
  filteredTasks,
  groupValue,
  propertiesFor,
} from "../../shared/domain.js";
export const sourceSchema = z.union([z.literal("live"), z.string().uuid()]);
export const browserQuerySchema = z.object({
  teamId: z.string().uuid(),
  year: yearSchema,
  q: z.string().trim().max(200).default(""),
  source: sourceSchema.default("live"),
  taskId: z.string().uuid().optional(),
  groupBy: z.string().max(80).default(""),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

export const previewInputLength = 1024;
const previewLength = 240;
export function documentPreview(markdown) {
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

export class DocumentBrowserBusinessService {
  constructor(repository, user) {
    this.repository = repository;
    this.user = user;
  }
  query(kind, values) {
    const query = browserQuerySchema.parse(
      values instanceof URLSearchParams ? Object.fromEntries(values) : values,
    );
    if (kind === "task") z.string().uuid().parse(query.taskId);
    if (!["sources", "tasks", "task"].includes(kind))
      throw new Error("Unknown document browser command");
    return this.repository[kind](this.user, query);
  }
}
export function documentBrowserPage(tasks, settings, users, query) {
  const groupBy = propertiesFor(settings).some((p) => p.id === query.groupBy)
    ? query.groupBy
    : "";
  const ordered = filteredTasks(
    tasks,
    { ...defaultView(query.year), groupBy },
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
    if (!title.toLowerCase().includes(query.q.toLowerCase())) continue;
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
  const page = matches.slice(query.offset, query.offset + query.limit);

  return {
    tasks: page,
    groups: [...groups.values()],
    taskCount: tasks.length,
    documentCount,
    matchedTaskCount: matches.length,
    matchedDocumentCount,
    nextOffset:
      query.offset + query.limit < matches.length
        ? query.offset + query.limit
        : null,
    properties: propertiesFor(settings).map(({ id, name }) => ({ id, name })),
  };
}
