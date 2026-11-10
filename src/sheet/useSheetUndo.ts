import { cell } from "../../shared/domain.js";
import { sheetChanges, type ChangeTargets } from "./selection-areas.js";
import type { HistoryEntry } from "../types";
import type useSheetRowCommands from "./useSheetRowCommands";
import type useSheetCellCommands from "./useSheetCellCommands";
import type { Dispatch, SetStateAction, RefObject } from "react";
import type { Task, Selection, SheetClone } from "../types";
import type useTaskData from "./useTaskData";
import type useSheetOperations from "./useSheetOperations";
import type useSheetCloneDraft from "./useSheetCloneDraft";

import type { SheetEditor } from "./sheet-command-types";
export default function useSheetUndo({
  sheetClone,
  editingSheetClone,
  canAdd,
  presentation,
  editorRef,
  sheetCloneDraft,
  selectionEpoch,
  documentsForSheetCloneRows,
  setError,
  revealChange,
  visibleTasks,
  selection,
  setRowTask,
  redoStack,
  undoStack,
  operations,
  deleteTasks,
  restoreTasks,
  submitChanges,
  taskData,
  teamId,
}: {
  sheetClone: SheetClone | null;
  editingSheetClone: boolean;
  canAdd: boolean;
  presentation: boolean;
  editorRef: RefObject<SheetEditor | null>;
  sheetCloneDraft: ReturnType<typeof useSheetCloneDraft>;
  selectionEpoch: RefObject<number>;
  documentsForSheetCloneRows: ReturnType<
    typeof useSheetRowCommands
  >["documentsForSheetCloneRows"];
  setError: (message: string) => void;
  revealChange: (
    targets: ChangeTargets,
    selected: number,
    retain?: boolean,
  ) => void;
  visibleTasks: Task[];
  selection: Selection | null;
  setRowTask: Dispatch<SetStateAction<Task | null>>;
  redoStack: HistoryEntry[];
  undoStack: HistoryEntry[];
  operations: ReturnType<typeof useSheetOperations>;
  deleteTasks: ReturnType<typeof useSheetRowCommands>["deleteTasks"];
  restoreTasks: ReturnType<typeof useSheetRowCommands>["restoreTasks"];
  submitChanges: ReturnType<typeof useSheetCellCommands>["submitChanges"];
  taskData: ReturnType<typeof useTaskData>;
  teamId: string;
}) {
  // Dispatch undo through the original command owners or the existing copy draft.
  async function undo(redo = false) {
    if (sheetClone) {
      if (editingSheetClone && canAdd && !presentation && !editorRef.current) {
        const draft = sheetCloneDraft.ref.current;
        if (!draft) return;
        const next = draft.history[draft.cursor + (redo ? 1 : -1)];
        if (!next) return;
        const selected = selectionEpoch.current;
        let before: Task[];
        try {
          const ids = new Set(next.map((task) => task.id));
          const documents = await documentsForSheetCloneRows(
            draft.tasks.filter((task) => !ids.has(task.id)),
          );
          if (
            sheetCloneDraft.ref.current?.sheetClone.id !==
              draft.sheetClone.id ||
            sheetCloneDraft.ref.current?.cursor !== draft.cursor
          )
            return;
          sheetCloneDraft.preserveDocuments(documents);
          before = sheetCloneDraft.ref.current.tasks;
          sheetCloneDraft.undo(redo);
        } catch (e) {
          setError((e as Error).message);
          return;
        }
        revealChange(
          sheetChanges(
            before,
            sheetCloneDraft.ref.current?.tasks || sheetClone.tasks,
            visibleTasks,
            selection?.focus.key,
          ),
          selected,
          true,
        );
        setRowTask(null);
        setError("");
      }
      return;
    }
    const stack = redo ? redoStack : undoStack,
      entry = stack.at(-1);
    if (
      !entry ||
      operations.isPending() ||
      operations.failure() ||
      sheetClone ||
      presentation
    )
      return;
    setError("");
    if ("kind" in entry) {
      const mode = redo ? "redo" : "undo";
      if ((entry.kind === "create") !== redo) void deleteTasks(entry, mode);
      else void restoreTasks(entry, mode);
      return;
    }
    if (entry.formatOperation) {
      submitChanges(
        () => [],
        redo ? "redo" : "undo",
        () => {
          const revision = taskData.snapshot()[0]?.formatting?.revision ?? 0;
          if (revision !== entry.formatRevision)
            throw new Error("이후 서식 변경이 있어 되돌릴 수 없습니다.");
          return {
            teamId,
            expectedRevision: revision,
            restore: entry.operationId,
            expectedCells: Object.fromEntries(
              entry.cells.map((c) => [`${c.taskId}:${c.key}`, c.version]),
            ),
          };
        },
      );
      return;
    }
    submitChanges(
      () => {
        const tasksById = new Map(taskData.snapshot().map((t) => [t.id, t]));
        const afterById = new Map(
          entry.cells.map((c) => [`${c.taskId}:${c.key}`, c]),
        );
        return entry.before.map((c) => {
          const t = tasksById.get(c.taskId);
          const after = afterById.get(`${c.taskId}:${c.key}`);
          if (!t || !after || cell(t, c.key).version !== after.version)
            throw new Error(
              "이후 변경이 있어 되돌릴 수 없습니다. 변경 이력에서 확인하세요.",
            );
          if (
            JSON.stringify(c.style) !== JSON.stringify(after.style) &&
            (entry.formatRevision ?? 0) !== (t.formatting?.revision ?? 0)
          )
            throw new Error("이후 공통 서식 변경이 있어 되돌릴 수 없습니다.");
          return {
            taskId: c.taskId,
            key: c.key,
            ...(JSON.stringify(c.value) === JSON.stringify(after.value)
              ? {}
              : { value: c.value }),
            style: c.style,
            expectedVersion: after.version,
            expectedFormatRevision: t.formatting?.revision ?? 0,
            rawStyle: true,
          };
        });
      },
      redo ? "redo" : "undo",
    );
  }
  return undo;
}
