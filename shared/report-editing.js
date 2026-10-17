import { hasDocumentContent } from "./task-documents.js";
import { emptyPropertyValue, propertiesFor } from "./domain.js";
import { STYLE_KEYS } from "./compact.js";
import {
  copyRowFormatting,
  normalizeCellStyle,
  scopeKey,
  scopeMatches,
} from "./formatting.js";

export class ReportEditError extends Error {}

// Both the draft and the server operate only on the report's own task objects.
// No live task IDs are resolved through the database here.
export function applyReportOperation(tasks, operation, context) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const get = (id) => {
    const task = byId.get(id);
    if (!task)
      throw new ReportEditError("사본에서 해당 업무를 찾지 못했습니다.");
    return task;
  };
  const stamp = operation.at;
  if (operation.kind === "restore") {
    // Sheet undo never rolls back independently edited documents of live rows.
    const removed = new Set(operation.removeIds || []);
    const restored = operation.tasks.map((task) => ({
      ...task,
      teamId: context.teamId,
      updatedAt: stamp,
      ...(byId.has(task.id)
        ? {
            documents: byId.get(task.id).documents,
            hasDocument: byId.get(task.id).hasDocument,
            documentCount: byId.get(task.id).documentCount,
          }
        : {}),
    }));
    for (const task of restored) byId.set(task.id, task);
    return [...byId.values()].filter((task) => !removed.has(task.id));
  }
  if (operation.kind === "cells") {
    for (const change of operation.changes) {
      const task = get(change.taskId);
      const previous = task.cells[change.key] || {
        value: "",
        style: {},
        version: 0,
      };
      byId.set(task.id, {
        ...task,
        updatedAt: stamp,
        cells: {
          ...task.cells,
          [change.key]: {
            value: change.value === undefined ? previous.value : change.value,
            style:
              change.style === undefined
                ? previous.style
                : normalizeCellStyle(task, change.key, change.style),
            version: previous.version + 1,
          },
        },
      });
    }
    return tasks.map((task) => byId.get(task.id));
  }
  if (operation.kind === "format") {
    for (const scope of operation.scopes)
      for (const id of scope.rows || []) get(id);
    return tasks.map((task) => {
      const scopes = operation.scopes.filter((scope) =>
        scopeMatches(scope, task.id),
      );
      if (!scopes.length) return task;
      const current = task.formatting || { revision: 0, rules: [] };
      const revision = current.revision + 1;
      const rules = new Map(
        current.rules.map((rule) => [scopeKey(rule), rule]),
      );
      const cells = { ...task.cells };
      for (const [index, scope] of scopes.entries()) {
        const key = scopeKey(scope),
          old = rules.get(key);
        const names = scope.reset
          ? Object.keys(STYLE_KEYS)
          : Object.keys(scope.style);
        rules.set(key, {
          id: old?.id || `${operation.id}:${index}`,
          rows: scope.rows,
          keys: scope.keys,
          excludeKeys: scope.excludeKeys || [],
          style: scope.reset ? scope.style : { ...old?.style, ...scope.style },
          orders: {
            ...old?.orders,
            ...Object.fromEntries(names.map((name) => [name, revision])),
          },
        });
        for (const [key, previous] of Object.entries(cells)) {
          if (!scopeMatches(scope, task.id, key)) continue;
          const style = { ...previous.style };
          for (const name of names) delete style[name];
          cells[key] = { ...previous, style, version: previous.version + 1 };
        }
      }
      return {
        ...task,
        cells,
        updatedAt: stamp,
        formatting: { revision, rules: [...rules.values()] },
      };
    });
  }
  if (operation.kind === "create") {
    if (byId.has(operation.taskId))
      throw new ReportEditError("이미 추가된 사본 업무입니다.");
    if (tasks.length >= 20000)
      throw new ReportEditError(
        "사본에는 업무를 20,000개까지 저장할 수 있습니다.",
      );
    const source = operation.sourceId ? get(operation.sourceId) : null;
    const target = operation.insertAt ? get(operation.insertAt.taskId) : null;
    const copied =
      operation.copiedRow ||
      (source || target ? copyRowFormatting(source || target) : null);
    const copyValues = !!source || !!operation.copiedRow;
    const fields = Object.fromEntries(
      propertiesFor(context.settings).map((p) => [p.id, emptyPropertyValue(p)]),
    );
    const cells = Object.fromEntries(
      Object.entries(copied?.cells || {}).map(([key, c]) => [
        key,
        {
          value: copyValues ? c.value : (fields[key] ?? ""),
          style: c.style,
          version: 1,
        },
      ]),
    );
    for (const [key, value] of Object.entries({
      ...fields,
      ...(copyValues
        ? Object.fromEntries(
            Object.entries(copied.cells).map(([k, c]) => [k, c.value]),
          )
        : {}),
      ...operation.fields,
    }))
      cells[key] = { value, style: cells[key]?.style || {}, version: 1 };
    const task = {
      id: operation.taskId,
      teamId: context.teamId,
      years: [context.year],
      position: Math.max(0, ...tasks.map((t) => t.position)) + 100,
      createdBy: context.actorId,
      createdAt: stamp,
      updatedAt: stamp,
      cells,
      ...(copyValues && copied?.documents
        ? {
            documents: copied.documents.map((doc) => ({ ...doc })),
            documentCount: copied.documents.length,
            hasDocument: copied.documents.some((doc) =>
              doc.markdown === undefined
                ? !!doc.hasContent
                : hasDocumentContent(doc.markdown),
            ),
          }
        : {}),
      defaultStyle: copied?.defaultStyle || context.settings.defaultStyle || {},
      ...(copied?.rowStyle ? { rowStyle: copied.rowStyle } : {}),
    };
    if (!target) return [...tasks, task];
    const ordered = [...tasks].sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((t) => t.id === target.id);
    ordered.splice(
      index + (operation.insertAt.placement === "after" ? 1 : 0),
      0,
      task,
    );
    return ordered.map((t, i) => ({ ...t, position: (i + 1) * 100 }));
  }
  if (operation.kind === "delete") {
    operation.taskIds.forEach(get);
    const ids = new Set(operation.taskIds);
    return tasks.filter((task) => !ids.has(task.id));
  }
  if (operation.kind === "reorder") {
    const ids = new Set(operation.taskIds);
    get(operation.targetId);
    operation.taskIds.forEach(get);
    if (ids.has(operation.targetId))
      throw new ReportEditError("이동할 행과 기준 행은 달라야 합니다.");
    const ordered = [...tasks].sort((a, b) => a.position - b.position);
    const moving = ordered.filter((task) => ids.has(task.id));
    const rest = ordered.filter((task) => !ids.has(task.id));
    const index = rest.findIndex((task) => task.id === operation.targetId);
    rest.splice(
      index + (operation.placement === "after" ? 1 : 0),
      0,
      ...moving,
    );
    return rest.map((task, i) => ({
      ...task,
      position: (i + 1) * 100,
      updatedAt: stamp,
    }));
  }
  throw new ReportEditError("지원하지 않는 사본 편집입니다.");
}
