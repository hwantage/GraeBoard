import { useEffect, useRef, useState } from "react";
import { applyReportOperation } from "../shared/report-editing.js";
import { rebaseReportCells } from "../shared/report-sync.js";
import { api, ApiError, send } from "./api";
import type {
  Cell,
  CellChange,
  FormatScope,
  Report,
  Task,
  View,
} from "./types";

type Command =
  | { kind: "restore"; tasks: Task[]; removeIds: string[] }
  | { kind: "cells"; changes: CellChange[] }
  | { kind: "format"; id: string; scopes: FormatScope[] }
  | {
      kind: "create";
      taskId: string;
      sourceId?: string;
      copiedRow?: {
        cells: Record<string, Pick<Cell, "value" | "style">>;
        defaultStyle: NonNullable<Task["defaultStyle"]>;
        rowStyle?: Task["rowStyle"];
        documents?: Task["documents"];
      };
      fields: Record<string, Cell["value"]>;
      insertAt?: { taskId: string; placement: "before" | "after" };
    }
  | { kind: "delete"; taskIds: string[] }
  | {
      kind: "reorder";
      taskIds: string[];
      targetId: string;
      placement: "before" | "after";
    };
type Operation = Command & { at: string };
type Draft = {
  report: Report;
  tasks: Task[];
  operations: Operation[];
  history: Task[][];
  cursor: number;
  view: View;
  viewSequence: number;
  savedViewSequence: number;
};
type Batch = {
  operationId: string;
  revision: string;
  operations: Operation[];
  view: View;
};

export default function useReportDraft(teamId: string, actorId: string) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef(draft);
  const running = useRef<Promise<Report | null> | null>(null);
  const documentChanges = useRef(
    new Map<
      string,
      { sequence: number; hasDocument: boolean; documentCount: number }
    >(),
  );
  const documentSequence = useRef(0);
  const retryBatch = useRef<{ data: Batch; viewSequence: number } | null>(null);
  function update(next: Draft | null) {
    ref.current = next;
    setDraft(next);
  }
  function begin(report: Report) {
    documentChanges.current.clear();
    retryBatch.current = null;
    setError("");
    update({
      report,
      tasks: report.tasks,
      operations: [],
      history: [report.tasks],
      cursor: 0,
      view: report.view,
      viewSequence: 0,
      savedViewSequence: 0,
    });
  }
  function apply(command: Command) {
    const current = ref.current;
    if (!current) return false;
    if (current.operations.length >= 1000)
      throw new Error(
        "저장하지 못한 변경이 많습니다. 저장 오류를 확인해 주세요.",
      );
    const operation = { ...command, at: new Date().toISOString() };
    const tasks = applyReportOperation(current.tasks, operation, {
      teamId,
      actorId,
      year: current.view.year,
      settings: current.report.settings,
    }) as Task[];
    const history = [
      ...current.history.slice(0, current.cursor + 1),
      tasks,
    ].slice(-101);
    update({
      ...current,
      tasks,
      operations: [...current.operations, operation],
      history,
      cursor: history.length - 1,
    });
    return true;
  }
  function updateDocument(
    taskId: string,
    hasDocument: boolean,
    documentCount: number,
  ) {
    documentChanges.current.set(taskId, {
      sequence: ++documentSequence.current,
      hasDocument,
      documentCount,
    });
    const current = ref.current;
    if (!current) return;
    const patched = new Map<Task[], Task[]>();
    const patch = (tasks: Task[]) => {
      const cached = patched.get(tasks);
      if (cached) return cached;
      const index = tasks.findIndex((task) => task.id === taskId);
      const task = tasks[index];
      let next = tasks;
      if (
        task &&
        (task.hasDocument !== hasDocument ||
          task.documentCount !== documentCount ||
          task.documents !== undefined)
      ) {
        next = tasks.slice();
        next[index] = {
          ...task,
          hasDocument,
          documentCount,
          documents: undefined,
        };
      }
      patched.set(tasks, next);
      return next;
    };
    const tasks = patch(current.tasks);
    const reportTasks = patch(current.report.tasks);
    const history = current.history.map(patch);
    if (
      tasks === current.tasks &&
      reportTasks === current.report.tasks &&
      history.every((tasks, index) => tasks === current.history[index])
    )
      return;
    update({
      ...current,
      report: { ...current.report, tasks: reportTasks },
      tasks,
      history,
    });
  }
  function preserveDocuments(
    documents: Map<string, NonNullable<Task["documents"]>>,
  ) {
    const current = ref.current;
    if (!current || !documents.size) return;
    const patch = (tasks: Task[]) =>
      tasks.map((task) =>
        documents.has(task.id)
          ? { ...task, documents: documents.get(task.id)! }
          : task,
      );
    update({
      ...current,
      tasks: patch(current.tasks),
      history: current.history.map(patch),
    });
  }
  function undo(redo = false) {
    const current = ref.current;
    if (!current) return;
    const cursor = current.cursor + (redo ? 1 : -1);
    if (cursor < 0 || cursor >= current.history.length) return;
    const tasks = current.history[cursor];
    const sheetJSON = ({
      documents: _documents,
      hasDocument: _hasDocument,
      documentCount: _documentCount,
      updatedAt: _updatedAt,
      ...task
    }: Task) => JSON.stringify(task);
    const existing = new Map(current.tasks.map((task) => [task.id, task]));
    const ids = new Set(tasks.map((task) => task.id));
    const operation: Operation = {
      kind: "restore",
      tasks: tasks.filter(
        (task) =>
          !existing.has(task.id) ||
          sheetJSON(task) !== sheetJSON(existing.get(task.id)!),
      ),
      removeIds: current.tasks
        .filter((task) => !ids.has(task.id))
        .map((task) => task.id),
      at: new Date().toISOString(),
    };
    update({
      ...current,
      cursor,
      tasks,
      operations: [...current.operations, operation],
    });
  }
  function changeView(view: View) {
    const current = ref.current;
    if (!current || JSON.stringify(current.view) === JSON.stringify(view))
      return;
    update({ ...current, view, viewSequence: current.viewSequence + 1 });
  }
  function rename(name: string) {
    const current = ref.current;
    if (current) update({ ...current, report: { ...current.report, name } });
  }
  function receive(report: Report, duringSave = false) {
    const current = ref.current;
    if (!current || current.report.id !== report.id) return true;
    if (current.report.revision === report.revision) {
      if (current.report.name !== report.name) rename(report.name);
      // Document metadata is deliberately excluded from the sheet revision.
      const tasks = new Map(current.tasks.map((task) => [task.id, task]));
      for (const task of report.tasks) {
        const previous = tasks.get(task.id);
        if (
          previous &&
          (!!previous.hasDocument !== !!task.hasDocument ||
            (previous.documentCount || 0) !== (task.documentCount || 0))
        )
          updateDocument(task.id, !!task.hasDocument, task.documentCount || 0);
      }
      return true;
    }
    if (running.current && !duringSave) return false;
    const merged = rebaseReportCells(
      current.report.tasks,
      report.tasks,
      current.operations,
      {
        teamId,
        actorId,
        year: report.year,
        settings: report.settings,
      },
    );
    if (!merged) return false;
    retryBatch.current = null;
    update({
      ...current,
      report,
      tasks: merged.tasks,
      history: merged.history,
      cursor: merged.history.length - 1,
    });
    return true;
  }
  function save(): Promise<Report | null> {
    if (running.current) return running.current;
    setError("");
    const work = async () => {
      setSaving(true);
      try {
        while (ref.current) {
          const current = ref.current;
          if (
            !current.operations.length &&
            current.savedViewSequence === current.viewSequence
          )
            return current.report;
          const batch = retryBatch.current || {
            data: {
              operationId: crypto.randomUUID(),
              revision: current.report.revision,
              operations: current.operations.slice(),
              view: current.view,
            },
            viewSequence: current.viewSequence,
          };
          retryBatch.current = batch;
          const sequence = documentSequence.current;
          let saved: Report;
          try {
            saved = await send<Report>(
              `/reports/${current.report.id}`,
              batch.data,
              "PATCH",
            );
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) {
              const remote = await api<Report>(`/reports/${current.report.id}`);
              if (
                remote.revision !== current.report.revision &&
                receive(remote, true)
              )
                continue;
            }
            throw error;
          }
          if (ref.current?.report.id !== current.report.id) return saved;
          const latest = ref.current;
          const operations = latest.operations.slice(
            batch.data.operations.length,
          );
          // Apply input made while the response was in flight to the saved base.
          let tasks = saved.tasks;
          for (const operation of operations)
            tasks = applyReportOperation(tasks, operation, {
              teamId,
              actorId,
              year: saved.year,
              settings: saved.settings,
            }) as Task[];
          // Locally confirmed document saves can arrive after the sheet response.
          tasks = tasks.map((task) => {
            const change = documentChanges.current.get(task.id);
            return change && change.sequence > sequence
              ? {
                  ...task,
                  hasDocument: change.hasDocument,
                  documentCount: change.documentCount,
                }
              : task;
          });
          update({
            ...latest,
            // Names are saved separately; an older sheet response must not
            // overwrite a rename, including when replaying a failed request.
            report: { ...saved, name: latest.report.name },
            tasks,
            operations,
            savedViewSequence: batch.viewSequence,
          });
          retryBatch.current = null;
        }
        return null;
      } catch (e) {
        setError((e as Error).message);
        throw e;
      } finally {
        running.current = null;
        setSaving(false);
      }
    };
    // Delay entry so synchronous clean returns cannot leave a resolved mutex.
    const promise = Promise.resolve().then(work);
    running.current = promise;
    return promise;
  }
  const dirty =
    !!draft &&
    (!!draft.operations.length ||
      draft.viewSequence !== draft.savedViewSequence);
  useEffect(() => {
    if (!dirty || error) return;
    const timer = window.setTimeout(() => void save().catch(() => {}), 650);
    return () => window.clearTimeout(timer);
  }, [draft?.operations, draft?.viewSequence, dirty, error]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return {
    draft,
    ref,
    saving,
    error,
    begin,
    receive,
    apply,
    updateDocument,
    preserveDocuments,
    undo,
    save,
    changeView,
    rename,
    cancel: () => {
      if (!running.current) {
        retryBatch.current = null;
        setError("");
        update(null);
      }
    },
    dirty,
    canUndo: !!draft?.cursor,
    canRedo: !!draft && draft.cursor < draft.history.length - 1,
  };
}
