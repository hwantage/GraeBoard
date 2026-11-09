import { useEffect, useMemo, useRef, useState } from "react";
import { api, send, taskQuery } from "../platform/api";
import { value, canEdit, emptyPropertyValue } from "../../shared/domain.js";
import { copyRowFormatting } from "../../shared/formatting/formatting.js";
import { canUndoCreation } from "./history";
import { nearbyRows, type ChangeTargets } from "./selection-areas.js";
import type { TaskCreation, TaskDeletion } from "../types";
import type { RowCommand } from "./Grid";
import type { CellFailure } from "./useSheetOperations";
import type { Dispatch, SetStateAction, RefObject } from "react";
import type {
  Task,
  View,
  User,
  Property,
  Selection,
  SheetClone,
} from "../types";
import type useTaskData from "./useTaskData";
import type useSheetOperations from "./useSheetOperations";
import type useSheetCloneDraft from "./useSheetCloneDraft";
import type useSheetHistory from "./useSheetHistory";
import type {
  SheetEditor,
  SheetJump,
  SheetUndoNotice,
} from "./sheet-command-types";
export default function useSheetRowCommands({
  teamId,
  year,
  user,
  view,
  properties,
  ready,
  canAdd,
  presentation,
  sheetClone,
  editingSheetClone,
  taskData,
  operations,
  sheetCloneDraft,
  recordTaskResult,
  refresh,
  editTasks,
  visibleTasks,
  selection,
  selectionEpoch,
  editorRef,
  rowTask,
  changeView,
  setSelection,
  setEditor,
  setJump,
  setRowTask,
  setError,
  setToast,
  setUndoToast,
  revealChange,
}: {
  teamId: string;
  year: number;
  user: User;
  view: View;
  properties: Property[];
  ready: boolean;
  canAdd: boolean;
  presentation: boolean;
  sheetClone: SheetClone | null;
  editingSheetClone: boolean;
  taskData: ReturnType<typeof useTaskData>;
  operations: ReturnType<typeof useSheetOperations>;
  sheetCloneDraft: ReturnType<typeof useSheetCloneDraft>;
  recordTaskResult: ReturnType<typeof useSheetHistory>["recordTask"];
  refresh: ReturnType<typeof useTaskData>["refresh"];
  editTasks: () => Task[];
  visibleTasks: Task[];
  selection: Selection | null;
  selectionEpoch: RefObject<number>;
  editorRef: RefObject<SheetEditor | null>;
  rowTask: Task | null;
  changeView: (part: Partial<View>, updateSelectedFilter?: boolean) => void;
  setSelection: Dispatch<SetStateAction<Selection | null>>;
  setEditor: Dispatch<SetStateAction<SheetEditor | null>>;
  setJump: Dispatch<SetStateAction<SheetJump | null>>;
  setRowTask: Dispatch<SetStateAction<Task | null>>;
  setError: (message: string) => void;
  setToast: (message: string) => void;
  setUndoToast: Dispatch<SetStateAction<SheetUndoNotice>>;
  revealChange: (
    targets: ChangeTargets,
    selected: number,
    retain?: boolean,
  ) => void;
}) {
  // Row commands own copy state, persistence, document preservation and history.
  const [copiedRow, setCopiedRow] = useState<{
    task: Task;
    height?: number;
  } | null>(null);
  const scope = useMemo(() => ({}), [teamId, year, sheetClone?.id]);
  const boardKey = useRef(scope);
  boardKey.current = scope;
  useEffect(() => {
    boardKey.current = scope;
    return () => {
      if (boardKey.current === scope) boardKey.current = {};
    };
  }, [scope]);
  async function taskOperation(run: () => Promise<void>) {
    if (
      operations.isPending() ||
      operations.failure() ||
      sheetClone ||
      presentation
    )
      return;
    const finishOperation = operations.begin();
    try {
      await run();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      finishOperation();
    }
    await refresh();
  }

  function recordCreation(task: Task) {
    recordTaskResult({
      kind: "create",
      ids: [task.id],
      title: String(value(task, "title")) || "제목 없는",
      task,
    });
  }

  async function deleteTasks(
    entry: TaskDeletion | TaskCreation,
    mode: CellFailure["mode"] = "normal",
  ) {
    if (sheetClone) {
      if (!editingSheetClone || !canAdd || presentation) return;
      try {
        const ids = new Set(entry.ids);
        const documents = await documentsForSheetCloneRows(
          editTasks().filter((task) => ids.has(task.id)),
        );
        if (sheetCloneDraft.ref.current?.sheetClone.id !== sheetClone.id)
          return;
        sheetCloneDraft.preserveDocuments(documents);
        sheetCloneDraft.apply({ kind: "delete", taskIds: entry.ids });
        setSelection(null);
        const deleted = sheetCloneDraft.ref.current!;
        setToast("");
        setUndoToast({
          kind: "rows",
          sheet: `${teamId}:${year}:${sheetClone.id}`,
          target: deleted.history[deleted.cursor],
          message:
            entry.ids.length > 1
              ? `사본에서 ${entry.ids.length}개 업무를 삭제했습니다.`
              : "사본에서 업무를 삭제했습니다.",
        });
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    const submittedBoard = boardKey.current,
      selected = selectionEpoch.current,
      shown = visibleTasks,
      key = selection?.focus.key;
    return taskOperation(async () => {
      const deleting = entry.ids.map((id) => {
        const t = taskData.snapshot().find((task) => task.id === id);
        if (!t) throw new Error("이미 삭제되었거나 찾을 수 없는 업무입니다.");
        if (entry.kind === "create" && !canUndoCreation(entry.task, t))
          throw new Error(
            "이후 변경이 있어 되돌릴 수 없습니다. 변경 이력에서 확인하세요.",
          );
        return { id, updatedAt: t.updatedAt };
      });
      const { updatedAt } = await send<{ updatedAt: Record<string, string> }>(
        "/tasks/delete",
        { tasks: deleting },
      );
      const nextEntry = { ...entry, deletedVersions: updatedAt };
      if (boardKey.current !== submittedBoard) return;
      // A subsequent edit can invalidate the list refresh. Apply the confirmed
      // deletion now, while retaining any newer remote restoration already seen.
      const remaining = taskData
        .snapshot()
        .filter(
          (task) => !updatedAt[task.id] || task.updatedAt > updatedAt[task.id],
        );

      taskData.replace(remaining);
      recordTaskResult(entry, mode, nextEntry);
      setSelection(null);
      // 실행취소로 사라진 행은 그 자리를 이어받은 행으로 이동한다.
      if (mode !== "normal")
        revealChange(
          { near: nearbyRows(new Set(entry.ids), shown), key },
          selected,
        );
      const message =
        entry.ids.length > 1
          ? `${entry.ids.length}개 업무를 삭제했습니다.`
          : `‘${entry.title}’ 업무를 삭제했습니다.`;
      if (entry.kind === "delete") {
        setToast("");
        setUndoToast({
          kind: "rows",
          sheet: `${teamId}:${year}:original`,
          target: nextEntry,
          message,
        });
      } else {
        setUndoToast(null);
        setToast(message);
      }
    });
  }

  async function restoreTasks(
    entry: TaskDeletion | TaskCreation,
    mode: "undo" | "redo",
  ) {
    const submittedBoard = boardKey.current,
      selected = selectionEpoch.current;
    let restored = false;
    await taskOperation(async () => {
      await send("/tasks/restore", {
        tasks: entry.ids.map((id) => ({
          id,
          updatedAt: entry.deletedVersions?.[id],
        })),
      });
      if (boardKey.current !== submittedBoard) return;
      recordTaskResult(entry, mode);
      setToast(
        entry.ids.length > 1
          ? `${entry.ids.length}개 업무를 되살렸습니다.`
          : `‘${entry.title}’ 업무를 되살렸습니다.`,
      );
      restored = true;
    });
    // 되살린 행은 목록을 다시 읽은 뒤에 보이므로 그때 선택한다.
    if (restored && boardKey.current === submittedBoard)
      revealChange({ rows: entry.ids }, selected);
  }

  async function addSheetCloneTask(
    sourceId?: string,
    target?: Task,
    placement: "before" | "after" = "after",
    copied?: ReturnType<typeof copyRowFormatting>,
  ) {
    if (!editingSheetClone || !canAdd || presentation || editorRef.current)
      return;
    try {
      if (sourceId) {
        const source = editTasks().find((task) => task.id === sourceId);
        if (!source) return;
        const documents = await documentsForCopy(source);
        if (sheetCloneDraft.ref.current?.sheetClone.id !== sheetClone?.id)
          return;
        copied = { ...copyRowFormatting(source), documents };
      }
      const taskId = crypto.randomUUID();
      const fields =
        !sourceId && !copied && target && view.groupBy
          ? { [view.groupBy]: value(target, view.groupBy) }
          : {};
      sheetCloneDraft.apply({
        kind: "create",
        taskId,
        sourceId,
        ...(copied ? { copiedRow: copied } : {}),
        fields,
        ...(target ? { insertAt: { taskId: target.id, placement } } : {}),
      });
      const task = editTasks().find((t) => t.id === taskId)!;
      changeView({
        propertyFilters: {},
        propertyFilterModes: {},
        sortKey: "",
        sortDirection: "default",
      });
      const point = { taskId, key: "title" };
      setSelection({ anchor: point, focus: point });
      setJump({ ...point, id: Date.now(), preserveHorizontalScroll: true });
      if (!sourceId && !copied) {
        editorRef.current = { point, task };
        setEditor(editorRef.current);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function addTask() {
    if (sheetClone) {
      addSheetCloneTask();
      return;
    }
    if (
      !ready ||
      !canAdd ||
      sheetClone ||
      presentation ||
      operations.isPending() ||
      operations.failure()
    )
      return;
    const submittedBoard = boardKey.current;
    const submittedScope = taskData.currentScope();
    const finishOperation = operations.begin();
    setError("");
    try {
      const { task } = await send("/tasks", {
        teamId,
        year,
        fields: view.groupBy
          ? {
              [view.groupBy]: emptyPropertyValue(
                properties.find((p) => p.id === view.groupBy),
              ),
            }
          : {},
      });
      if (
        boardKey.current !== submittedBoard ||
        taskData.currentScope() !== submittedScope
      )
        return;
      taskData.replace((s) => {
        const next = [...s, task];

        return next;
      });
      recordCreation(task);
      changeView({
        propertyFilters: {},
        propertyFilterModes: {},
        sortKey: "",
        sortDirection: "default",
      });
      setSelection({
        anchor: { taskId: task.id, key: "title" },
        focus: { taskId: task.id, key: "title" },
      });
      setEditor({ point: { taskId: task.id, key: "title" }, task });
    } catch (e) {
      if (
        boardKey.current === submittedBoard &&
        taskData.currentScope() === submittedScope
      )
        setError((e as Error).message);
    } finally {
      finishOperation();
    }
  }

  async function reorderTask(
    taskIds: string | string[],
    targetId: string,
    placement: "before" | "after",
  ) {
    if (sheetClone) {
      if (!editingSheetClone || !canAdd || presentation) return;
      try {
        const ids = Array.isArray(taskIds) ? taskIds : [taskIds];
        const target = editTasks().find((task) => task.id === targetId);
        if (
          view.groupBy &&
          ids.some((id) => {
            const task = editTasks().find((t) => t.id === id);
            return (
              !task ||
              !target ||
              JSON.stringify(value(task, view.groupBy!)) !==
                JSON.stringify(value(target, view.groupBy!))
            );
          })
        )
          throw new Error("같은 묶음 안에서 순서를 변경하세요.");
        sheetCloneDraft.apply({
          kind: "reorder",
          taskIds: ids,
          targetId,
          placement,
        });
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    const ids = Array.isArray(taskIds) ? taskIds : [taskIds];
    const byId = new Map(taskData.snapshot().map((t) => [t.id, t]));
    const moving = ids.map((id) => byId.get(id));
    const target = byId.get(targetId);
    if (
      !ids.length ||
      moving.some((t) => !t) ||
      !target ||
      operations.isPending() ||
      operations.failure() ||
      sheetClone ||
      presentation
    )
      return;
    const submittedBoard = boardKey.current;
    setError("");
    const finishOperation = operations.begin();
    try {
      const result = await send("/tasks/reorder", {
        tasks: moving.map((t) => ({ id: t!.id, updatedAt: t!.updatedAt })),
        targetId,
        placement,
        year,
        startMonth: view.startMonth,
        groupBy: view.groupBy || "",
        targetUpdatedAt: target.updatedAt,
      });
      if (boardKey.current !== submittedBoard) return;
      const moved = new Map<string, Task>(
        result.tasks.map((t: Task) => [t.id, t]),
      );
      const next = taskData.snapshot().map((t) => moved.get(t.id) || t);

      taskData.replace(next);
    } catch (e) {
      if (boardKey.current === submittedBoard) setError((e as Error).message);
    } finally {
      finishOperation();
    }
    if (boardKey.current === submittedBoard) await refresh();
  }

  async function documentsForSheetCloneRows(tasks: Task[]) {
    const documents = new Map<string, NonNullable<Task["documents"]>>();
    const stored = new Set(sheetClone?.tasks.map((task) => task.id));
    const pending: string[] = [];
    for (const task of tasks) {
      if (task.documents)
        documents.set(task.id, structuredClone(task.documents));
      else if (!stored.has(task.id)) documents.set(task.id, []);
      else pending.push(task.id);
    }
    // Fetch fresh metadata even for apparently empty rows: another user may
    // have added a document since this sheet was loaded. Preserve all results
    // in one state update instead of remapping the undo history for every row.
    for (let offset = 0; offset < pending.length;) {
      const result = await send<{
        tasks: { id: string; documents: NonNullable<Task["documents"]> }[];
      }>(`/sheet-clones/${sheetClone!.id}/documents/batch`, {
        taskIds: pending.slice(offset, offset + 100),
      });
      if (sheetCloneDraft.ref.current?.sheetClone.id !== sheetClone!.id)
        throw new Error("시트가 변경되었습니다.");
      for (const task of result.tasks) documents.set(task.id, task.documents);
      offset += result.tasks.length;
    }
    return documents;
  }

  async function documentsForCopy(task: Task) {
    if (
      sheetClone &&
      !task.documents &&
      !sheetClone.tasks.some((t) => t.id === task.id)
    )
      return [];
    const documents =
      task.documents ||
      (
        await api<{ documents: NonNullable<Task["documents"]> }>(
          sheetClone
            ? `/sheet-clones/${sheetClone.id}/tasks/${task.id}/documents?content=1`
            : `/tasks/${task.id}/documents?content=1`,
        )
      ).documents;
    return documents.map(({ id, title, markdown }) => ({
      id,
      title,
      markdown,
    }));
  }

  async function rowCommand(
    command: RowCommand,
    selected: Task,
    selectedRows = [selected],
  ) {
    if (command === "delete") {
      if (
        operations.isPending() ||
        operations.failure() ||
        presentation ||
        editorRef.current
      )
        return;
      const byId = new Map(editTasks().map((task) => [task.id, task]));
      const targets = [...new Set(selectedRows.map((task) => task.id))].map(
        (id) => byId.get(id),
      );
      if (
        !targets.length ||
        targets.some(
          (task) =>
            !task ||
            !(sheetClone ? editingSheetClone && canAdd : canEdit(user, task)),
        )
      )
        return;
      setError("");
      await deleteTasks({
        kind: "delete",
        ids: targets.map((task) => task!.id),
        title: String(value(targets[0]!, "title")) || "제목 없는",
      });
      return;
    }
    if (sheetClone) {
      if (!editingSheetClone || !canAdd || presentation || editorRef.current)
        return;
      const target = editTasks().find((task) => task.id === selected.id);
      if (!target) return;
      if (command === "copy") {
        try {
          const documents = await documentsForCopy(target);
          if (sheetCloneDraft.ref.current?.sheetClone.id !== sheetClone.id)
            return;
          setCopiedRow({
            task: { ...structuredClone(target), documents },
            height: view.rowHeights[target.id],
          });
          setToast("사본의 행과 문서를 복사했습니다.");
        } catch (e) {
          setError((e as Error).message);
        }
      } else if (command === "paste") {
        if (copiedRow)
          addSheetCloneTask(
            undefined,
            target,
            "after",
            copyRowFormatting(copiedRow.task),
          );
      } else
        addSheetCloneTask(
          undefined,
          target,
          command === "insertBefore" ? "before" : "after",
        );
      return;
    }
    if (
      operations.isPending() ||
      operations.failure() ||
      sheetClone ||
      presentation ||
      editorRef.current
    )
      return;
    const target = taskData.snapshot().find((task) => task.id === selected.id);
    if (!target) return;
    setError("");
    if (command === "copy") {
      const board = boardKey.current;
      try {
        const documents = await documentsForCopy(target);
        if (boardKey.current !== board) return;
        setCopiedRow({
          task: { ...structuredClone(target), documents },
          height: view.rowHeights[target.id],
        });
        setToast(
          "행의 내용과 서식, 문서를 복사했습니다. 붙여넣을 행을 선택하세요.",
        );
      } catch (e) {
        if (boardKey.current === board) setError((e as Error).message);
      }
      return;
    }
    if (
      !canAdd ||
      (command === "paste" && (!copiedRow || copiedRow.task.teamId !== teamId))
    )
      return;
    const copy = command === "paste" ? copiedRow : null;
    const height = copy ? copy.height : view.rowHeights[target.id];
    const groupKey = view.groupBy;
    const inheritGroup = !!groupKey;
    const fields =
      !copy && inheritGroup ? { [groupKey]: value(target, groupKey) } : {};
    const keepGroup = copy
      ? inheritGroup &&
        JSON.stringify(value(copy.task, groupKey)) ===
          JSON.stringify(value(target, groupKey))
      : inheritGroup;
    const submittedBoard = boardKey.current;
    const finishOperation = operations.begin();
    try {
      const { task } = await send("/tasks", {
        teamId,
        year,
        fields,
        startMonth: view.startMonth,
        insertAt: {
          taskId: target.id,
          updatedAt: target.updatedAt,
          placement: command === "insertBefore" ? "before" : "after",
        },
        ...(copy
          ? {
              copiedRow: copyRowFormatting(copy.task),
            }
          : {}),
      });
      if (boardKey.current !== submittedBoard) return;
      const next = [...taskData.snapshot(), task];

      taskData.replace(next);
      recordCreation(task);
      changeView({
        propertyFilters: {},
        propertyFilterModes: {},
        sortKey: "",
        sortDirection: "default",
        groupBy: keepGroup ? groupKey : "",
        ...(height !== undefined
          ? { rowHeights: { ...view.rowHeights, [task.id]: height } }
          : {}),
      });
      // Spacing may have been normalized by the server; refresh every row's position.
      const current = await api<{ tasks: Task[] }>(
        taskQuery(teamId, year, view.startMonth),
      );
      if (boardKey.current !== submittedBoard) return;

      taskData.replace(current.tasks);
      const point = { taskId: task.id, key: "title" };
      setSelection({ anchor: point, focus: point });
      if (copy) {
        setJump((previous) => ({
          ...point,
          id: (previous?.id || 0) + 1,
          preserveHorizontalScroll: true,
        }));
        setToast("복사한 행을 아래에 붙여넣었습니다.");
      } else {
        setEditor({
          point,
          task: current.tasks.find((t) => t.id === task.id) || task,
        });
      }
    } catch (e) {
      if (boardKey.current === submittedBoard) setError((e as Error).message);
    } finally {
      finishOperation();
    }
  }

  async function detailAction(action: string) {
    if (!rowTask) return;
    const t = editTasks().find((task) => task.id === rowTask.id) || rowTask;
    setRowTask(null);
    setError("");
    try {
      if (action === "hide") {
        changeView({ hiddenRows: [...new Set([...view.hiddenRows, t.id])] });
        return;
      }
      if (action === "duplicate") {
        if (sheetClone) {
          addSheetCloneTask(t.id, t);
          return;
        }
        const submittedBoard = boardKey.current;
        await taskOperation(async () => {
          const { task } = await send<{ task: Task }>("/tasks", {
            teamId,
            year,
            sourceId: t.id,
            fields: { title: String(value(t, "title")) + " 사본" },
          });
          if (boardKey.current === submittedBoard) recordCreation(task);
        });
        return;
      }
      if (action === "delete") {
        // 확인 없이 지우고 실행취소로 되살린다.
        await deleteTasks({
          kind: "delete",
          ids: [t.id],
          title: String(value(t, "title")) || "제목 없는",
        });
        return;
      }
      if (action === "carry") {
        if (sheetClone) return;
        await send(
          `/tasks/${t.id}`,
          {
            updatedAt: t.updatedAt,
            years: [...new Set([...t.years, year + 1])],
          },
          "PATCH",
        );
        setToast(`${year + 1}년에서도 같은 업무를 조회할 수 있습니다.`);
      }
      if (action === "up" || action === "down") {
        if (view.sortKey && view.sortDirection !== "default")
          throw new Error(
            "컬럼 머리글을 우클릭하여 정렬 해제를 선택한 뒤 순서를 변경하세요.",
          );
        const order = visibleTasks.filter(
          (x) =>
            !view.groupBy || value(x, view.groupBy) === value(t, view.groupBy),
        );
        const idx = order.findIndex((x) => x.id === t.id),
          direction = action === "up" ? -1 : 1,
          neighbor = order[idx + direction];
        if (neighbor) {
          await reorderTask(
            t.id,
            neighbor.id,
            direction < 0 ? "before" : "after",
          );
        }
        return;
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return {
    copiedRow,
    clearCopiedRow: () => setCopiedRow(null),
    deleteTasks,
    restoreTasks,
    addTask,
    reorderTask,
    documentsForSheetCloneRows,
    rowCommand,
    detailAction,
  };
}
