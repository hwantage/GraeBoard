import { useRef, useState } from "react";
import { applyReportOperation } from "../shared/report-editing.js";
import { send } from "./api";
import type { Cell, CellChange, FormatScope, Report, Task } from "./types";

type Command =
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
  operationId: string;
  report: Report;
  tasks: Task[];
  operations: Operation[];
  history: Task[][];
  cursor: number;
};

export default function useReportDraft(teamId: string, actorId: string) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const ref = useRef(draft);
  const savingRef = useRef(false);
  function update(next: Draft | null) {
    ref.current = next;
    setDraft(next);
  }
  function begin(report: Report) {
    update({
      operationId: crypto.randomUUID(),
      report,
      tasks: report.tasks,
      operations: [],
      history: [report.tasks],
      cursor: 0,
    });
  }
  function apply(command: Command) {
    const current = ref.current;
    if (!current || savingRef.current) return false;
    if (current.cursor >= 1000)
      throw new Error("편집 내용을 먼저 저장한 뒤 수정을 계속하세요.");
    const operation = { ...command, at: new Date().toISOString() };
    const tasks = applyReportOperation(current.tasks, operation, {
      teamId,
      actorId,
      year: current.report.year,
      settings: current.report.settings,
    }) as Task[];
    update({
      ...current,
      operationId: crypto.randomUUID(),
      tasks,
      operations: [...current.operations.slice(0, current.cursor), operation],
      history: [...current.history.slice(0, current.cursor + 1), tasks],
      cursor: current.cursor + 1,
    });
    return true;
  }
  function undo(redo = false) {
    const current = ref.current;
    if (!current || savingRef.current) return;
    const cursor = current.cursor + (redo ? 1 : -1);
    if (cursor < 0 || cursor > current.operations.length) return;
    update({
      ...current,
      operationId: crypto.randomUUID(),
      cursor,
      tasks: current.history[cursor],
    });
  }
  async function save() {
    const current = ref.current;
    if (!current || savingRef.current) return null;
    if (!current.cursor) {
      update(null);
      return current.report;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await send<Report>(
        `/reports/${current.report.id}`,
        {
          operationId: current.operationId,
          revision: current.report.revision,
          operations: current.operations.slice(0, current.cursor),
        },
        "PATCH",
      );
      update(null);
      return saved;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  return {
    draft,
    ref,
    saving,
    begin,
    apply,
    undo,
    save,
    cancel: () => {
      if (!savingRef.current) update(null);
    },
    dirty: !!draft?.cursor,
    canUndo: !!draft?.cursor,
    canRedo: !!draft && draft.cursor < draft.operations.length,
  };
}
