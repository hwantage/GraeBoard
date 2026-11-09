import { useEffect, useState } from "react";
import {
  cell,
  canEdit,
  emptyPropertyValue,
  MAX_STYLE_CELLS,
  fieldsFor,
} from "../../shared/domain.js";
import { applyBorderPreset } from "../../shared/formatting/borders.js";
import { resetCellStyle } from "../../shared/formatting/formatting.js";
import { STYLE_KEYS } from "../../shared/formatting/compact.js";
import { formatScopes } from "./format-selection.js";
import { rangesOf, rangeOf, selectedPoints, type Column } from "./Grid";
import type {
  CellChange,
  FormatChange,
  Style,
  Border,
  BorderPreset,
} from "../types";
import type { ClipboardMatrix } from "./clipboard";
import type { CellFailure } from "./useSheetOperations";
import type { Dispatch, SetStateAction, RefObject } from "react";
import type {
  Task,
  View,
  User,
  Property,
  Selection,
  SheetClone,
  Point,
} from "../types";

import type useSheetOperations from "./useSheetOperations";
import type useSheetCloneDraft from "./useSheetCloneDraft";

import type { SheetEditor } from "./sheet-command-types";
export default function useSheetCellCommands({
  teamId,
  year,
  user,
  canAdd,
  presentation,
  sheetClone,
  editingSheetClone,
  operations,
  sheetCloneDraft,
  editTasks,
  selection,
  selectionEpoch,
  editorRef,
  setSelection,
  setEditor,
  setError,
  changeView,
  allTasks,
  matchingTasks,
  visibleTasks,
  columns,
  columnOrder,
  fields,
  properties,
  assignableUsers,
  viewRef,
  editor,
  workspaceRef,
  editable,
  pending,
  failed,
  range,
  count,
  screen,
}: {
  teamId: string;
  year: number;
  user: User;
  canAdd: boolean;
  presentation: boolean;
  sheetClone: SheetClone | null;
  editingSheetClone: boolean;
  operations: ReturnType<typeof useSheetOperations>;
  sheetCloneDraft: ReturnType<typeof useSheetCloneDraft>;
  editTasks: () => Task[];
  selection: Selection | null;
  selectionEpoch: RefObject<number>;
  editorRef: RefObject<SheetEditor | null>;
  setSelection: Dispatch<SetStateAction<Selection | null>>;
  setEditor: Dispatch<SetStateAction<SheetEditor | null>>;
  setError: (message: string) => void;
  changeView: (part: Partial<View>, updateSelectedFilter?: boolean) => void;
  allTasks: Task[];
  matchingTasks: Task[];
  visibleTasks: Task[];
  columns: Column[];
  columnOrder: Column[];
  fields: ReturnType<typeof fieldsFor>;
  properties: Property[];
  assignableUsers: User[];
  viewRef: RefObject<View>;
  editor: SheetEditor | null;
  workspaceRef: RefObject<HTMLDivElement | null>;
  editable: boolean;
  pending: number;
  failed: ReturnType<typeof useSheetOperations>["failed"];
  range: ReturnType<typeof rangeOf>;
  count: number;
  screen: "annual" | "calendar";
}) {
  // Cell commands own permission/version checks, clipboard decoding and format brush.
  const [formatBrush, setFormatBrush] = useState<{
    styles: Style[][];
    repeat: boolean;
  } | null>(null);
  useEffect(() => {
    setFormatBrush(null);
  }, [teamId, year, sheetClone?.id, presentation, screen]);
  useEffect(() => {
    if (!formatBrush) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (workspaceRef.current?.querySelector("dialog[open]")) return;
      event.preventDefault();
      setFormatBrush(null);
    };
    // The drag tracker consumes Escape at window capture, before React events.
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [formatBrush]);
  function getPoints() {
    return selectedPoints(selection, visibleTasks, columns);
  }

  function rejectPendingChanges() {
    if (!operations.isPending()) return false;
    setError("앞선 변경을 저장 중입니다. 잠시 후 다시 적용하세요.");
    return true;
  }

  function submitChanges(
    build: () => CellChange[],
    mode: CellFailure["mode"] = "normal",
    buildFormat?: () => FormatChange,
  ) {
    if (sheetClone) {
      if (!editingSheetClone || !canAdd || presentation) return false;
      try {
        const changes = build();
        const format = buildFormat?.();
        if (changes.length) sheetCloneDraft.apply({ kind: "cells", changes });
        if (format?.scopes)
          sheetCloneDraft.apply({
            kind: "format",
            id: crypto.randomUUID(),
            scopes: format.scopes,
          });
        if (editorRef.current) {
          const task = editTasks().find(
            (t) => t.id === editorRef.current!.task.id,
          );
          if (task) {
            editorRef.current = { ...editorRef.current, task };
            setEditor(editorRef.current);
          }
        }
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    }
    if (sheetClone || presentation || operations.failure()) return false;
    if (rejectPendingChanges()) return false;
    return operations.submit(
      () => ({ changes: build(), format: buildFormat?.() }),
      mode,
      selectionEpoch.current,
    );
  }

  function mutate(
    points: Point[],
    transform: (t: Task, key: string) => Partial<CellChange>,
  ) {
    if (!points.length) return false;
    return submitChanges(() => {
      const tasksById = new Map(editTasks().map((t) => [t.id, t]));
      return points.map((p) => {
        const task = tasksById.get(p.taskId);
        if (!task) throw new Error("편집할 업무를 찾지 못했습니다.");
        if (!(sheetClone ? canAdd : canEdit(user, task)))
          throw new Error(
            "선택 범위에 편집 권한이 없는 업무가 포함되어 있습니다.",
          );
        return {
          ...p,
          expectedVersion: cell(task, p.key).version,
          expectedFormatRevision: task.formatting?.revision ?? 0,
          ...transform(task, p.key),
        };
      });
    });
  }

  function applyStyle(part: Partial<Style>, reset = false) {
    try {
      if (applyCommonStyle(part, reset)) return;
      mutate(
        selectedPoints(selection, matchingTasks, columnOrder, MAX_STYLE_CELLS),
        (t, k) => ({
          style: reset
            ? resetCellStyle(t, k)
            : { ...cell(t, k).style, ...part },
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function copyFormat(repeat: boolean) {
    if (formatBrush && !repeat) {
      setFormatBrush(null);
      return;
    }
    if (!editable || pending || editor || presentation) return;
    try {
      if (selection?.areas?.length)
        throw new Error("서식을 복사할 때는 하나의 연속된 영역을 선택하세요.");
      selectedPoints(selection, matchingTasks, columnOrder, MAX_STYLE_CELLS);
      if (!range || !count) return;
      const styles = matchingTasks.slice(range.r1, range.r2 + 1).map((task) =>
        columnOrder.slice(range.c1, range.c2 + 1).map(({ key }) => {
          const source = cell(task, key).style;
          // Missing properties must also replace the destination's inherited style.
          return structuredClone(
            Object.fromEntries(
              Object.keys(STYLE_KEYS).map((name) => [
                name,
                source[name as keyof Style] ?? null,
              ]),
            ),
          ) as Style;
        }),
      );
      setFormatBrush({ styles, repeat });
      requestAnimationFrame(() =>
        workspaceRef.current
          ?.querySelector<HTMLElement>(".sheet-scroll")
          ?.focus({ preventScroll: true }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function paintFormat(target: Selection | null) {
    if (!formatBrush || !target || editor || presentation || failed) return;
    if (!sheetClone && rejectPendingChanges()) return;
    try {
      const { styles, repeat } = formatBrush;
      const ranges = rangesOf(target, matchingTasks, columnOrder);
      if (!ranges.length) return;
      if (
        styles.length === 1 &&
        styles[0].length === 1 &&
        applyCommonStyle(styles[0][0], false, undefined, target)
      ) {
        if (!repeat) setFormatBrush(null);
        return;
      }
      const changes = new Map<string, { point: Point; style: Style }>();
      for (const range of ranges) {
        const single =
          range.r1 === range.r2 &&
          range.c1 === range.c2 &&
          (!range.kind || range.kind === "cells");
        const r2 = single ? range.r1 + styles.length - 1 : range.r2;
        const c2 = single ? range.c1 + styles[0].length - 1 : range.c2;
        if (r2 >= matchingTasks.length || c2 >= columnOrder.length)
          throw new Error(
            "서식을 적용할 범위가 표를 벗어납니다. 더 작은 범위를 선택하세요.",
          );
        for (let r = range.r1; r <= r2; r++)
          for (let c = range.c1; c <= c2; c++) {
            const point = {
              taskId: matchingTasks[r].id,
              key: columnOrder[c].key,
            };
            changes.set(`${point.taskId}:${point.key}`, {
              point,
              style:
                styles[(r - range.r1) % styles.length][
                  (c - range.c1) % styles[0].length
                ],
            });
            if (changes.size > MAX_STYLE_CELLS)
              throw new Error(
                `한 번에 ${MAX_STYLE_CELLS.toLocaleString()}개 셀까지 편집할 수 있습니다. 선택 범위를 줄여주세요.`,
              );
          }
      }
      if (
        mutate(
          [...changes.values()].map(({ point }) => point),
          (task, key) => ({ style: changes.get(`${task.id}:${key}`)!.style }),
        ) &&
        !repeat
      )
        setFormatBrush(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function applyCommonStyle(
    part: Partial<Style>,
    reset = false,
    border?: { preset: BorderPreset; border: Border | null },
    target = selection,
  ) {
    const ranges = rangesOf(target, matchingTasks, columnOrder);
    if (!ranges.length || ranges.some((r) => !r.kind || r.kind === "cells"))
      return false;
    const scopes = formatScopes(
      ranges,
      matchingTasks,
      columnOrder,
      part,
      reset,
      border,
    );
    if (!scopes.length) return true;
    submitChanges(
      () => [],
      "normal",
      () => {
        const tasks = editTasks(),
          ids = new Set(scopes.flatMap((s) => s.rows || []));
        const selected = tasks.filter((t) => ids.has(t.id));
        if (
          selected.length !== ids.size ||
          selected.some((t) => !(sheetClone ? canAdd : canEdit(user, t)))
        )
          throw new Error(
            "선택 범위에 편집 권한이 없는 업무가 포함되어 있습니다.",
          );
        return {
          teamId,
          expectedRevision: tasks[0]?.formatting?.revision ?? 0,
          scopes,
          expectedTasks: Object.fromEntries(
            selected.map((t) => [t.id, t.updatedAt]),
          ),
        };
      },
    );
    return true;
  }

  function applyBorder(preset: BorderPreset, border: Border | null) {
    try {
      if (applyCommonStyle({}, false, { preset, border })) return;
      const points = selectedPoints(
        selection,
        matchingTasks,
        columnOrder,
        MAX_STYLE_CELLS,
      );
      const selected = new Set(points.map((p) => `${p.taskId}:${p.key}`));
      const rows = new Map(matchingTasks.map((t, i) => [t.id, i]));
      const cols = new Map(columnOrder.map((c, i) => [c.key, i]));
      const has = (r: number, c: number) =>
        !!matchingTasks[r] &&
        !!columnOrder[c] &&
        selected.has(`${matchingTasks[r].id}:${columnOrder[c].key}`);
      mutate(points, (task, key) => {
        const r = rows.get(task.id)!,
          c = cols.get(key)!;
        return {
          style: applyBorderPreset(cell(task, key).style, preset, border, {
            Top: !has(r - 1, c),
            Right: !has(r, c + 1),
            Bottom: !has(r + 1, c),
            Left: !has(r, c - 1),
          }),
        };
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function beginEdit(p: Point, initial?: string) {
    const task = allTasks.find((t) => t.id === p.taskId);
    if (
      !task ||
      (sheetClone && (!editingSheetClone || !canAdd)) ||
      presentation ||
      failed
    )
      return false;
    if (operations.isPending()) {
      setError("앞선 변경을 저장 중입니다. 잠시 후 편집하세요.");
      return false;
    }
    if (!(sheetClone ? canAdd : canEdit(user, task))) {
      setError("이 업무를 편집할 권한이 없습니다.");
      return false;
    }
    if (
      fields.some((f) => f.key === p.key) &&
      !viewRef.current.visibleFields.includes(p.key)
    ) {
      changeView({ visibleFields: [...viewRef.current.visibleFields, p.key] });
    }
    setSelection({ anchor: p, focus: p });
    const next = { point: p, initial, task };
    editorRef.current = next;
    setEditor(next);
    return true;
  }

  function clearCells() {
    try {
      mutate(getPoints(), (_t, k) => ({
        value: emptyPropertyValue(properties.find((p) => p.id === k)),
      }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function paste(matrix: ClipboardMatrix) {
    if (!selection) return;
    if (selection.areas?.length) {
      setError("붙여넣을 때는 하나의 연속된 영역을 선택하세요.");
      return;
    }
    const ri = visibleTasks.findIndex((t) => t.id === selection.focus.taskId),
      ci = columns.findIndex((c) => c.key === selection.focus.key);
    if (ri < 0 || ci < 0) return;
    if (
      ri + matrix.length > visibleTasks.length ||
      matrix.some((r) => ci + r.length > columns.length)
    ) {
      setError(
        "붙여넣을 범위가 표를 벗어납니다. 행을 추가하거나 더 작은 범위를 선택하세요.",
      );
      return;
    }
    if (matrix.reduce((s, r) => s + r.length, 0) > 2000) {
      setError("한 번에 2,000개 셀까지 붙여넣을 수 있습니다.");
      return;
    }
    const changes = new Map<string, Pick<CellChange, "value" | "style">>();
    const points: Point[] = [];
    try {
      matrix.forEach((r, i) =>
        r.forEach(({ text, style }, j) => {
          const p = {
            taskId: visibleTasks[ri + i].id,
            key: columns[ci + j].key,
          };
          let v: any = text;
          const field = fields.find((f) => f.key === p.key);
          const property = properties.find((p) => p.id === field?.key);
          if (property?.kind === "option" && text) {
            const option = property.values.find(
              (o) => !o.archived && (o.label === text || o.id === text),
            );
            if (!option)
              throw new Error(`${property.name}에 없는 값입니다: ${text}`);
            v = option.id;
          }
          if (field?.type === "number") {
            if (text && !Number.isFinite(Number(text)))
              throw new Error(`${field.label} 열에는 숫자를 입력하세요.`);
            v = text === "" ? "" : Number(text);
          }
          if (property?.kind === "member") {
            const ids = text
              .split(/[,;]/)
              .map((s) => s.trim())
              .filter(Boolean)
              .map((name) => {
                const matches = assignableUsers.filter(
                  (u) => u.name === name || u.id === name,
                );
                if (matches.length !== 1)
                  throw new Error(
                    `담당자 “${name}”을 정확히 연결할 수 없습니다.`,
                  );
                return matches[0].id;
              });
            if (!property.multiple && ids.length > 1)
              throw new Error(
                `${property.name} 열에는 팀원 한 명을 선택하세요.`,
              );
            v = property.multiple ? [...new Set(ids)] : ids[0] || "";
          }
          points.push(p);
          changes.set(`${p.taskId}:${p.key}`, {
            value: v,
            ...(style
              ? {
                  style: {
                    ...resetCellStyle(visibleTasks[ri + i], p.key),
                    ...style,
                  },
                }
              : {}),
          });
        }),
      );
      mutate(points, (t, k) => changes.get(`${t.id}:${k}`)!);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return {
    formatBrush,
    submitChanges,
    mutate,
    applyStyle,
    copyFormat,
    paintFormat,
    applyBorder,
    beginEdit,
    clearCells,
    paste,
  };
}
