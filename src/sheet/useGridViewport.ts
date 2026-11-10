import {
  useMemo,
  useRef,
  useCallback,
  useLayoutEffect,
  type RefObject,
  type ReactNode,
} from "react";
import { useVirtualizer, defaultRangeExtractor } from "@tanstack/react-virtual";
import { groupValue } from "../../shared/domain.js";
import { rowFontSize } from "../../shared/formatting/formatting.js";
import type { Task, Settings, View, Property, Selection } from "../types";
import type { Column } from "./grid-types";
import type { EditorState } from "./InlineCellEditor";
import type { SheetJump } from "./sheet-command-types";
export const GROUP_HEADING_HEIGHT = 28;
export default function useGridViewport({
  ref,
  tasks,
  columns,
  settings,
  view,
  group,
  groupKey,
  editor,
  selection,
  rowResize,
  footer,
  jump,
  rowHeaderWidth,
  positions,
}: {
  ref: RefObject<HTMLDivElement | null>;
  tasks: Task[];
  columns: Column[];
  settings: Settings;
  view: View;
  group: Property | undefined;
  groupKey: string;
  editor: EditorState | null;
  selection: Selection | null;
  rowResize: { taskId: string; height: number } | null;
  footer: ReactNode;
  jump: SheetJump | null;
  rowHeaderWidth: number;
  positions: number[];
}) {
  const appliedJump = useRef<number | null>(null);
  const groupHeights = useMemo(
    () =>
      tasks.map((t, i) =>
        !!group &&
        (i === 0 ||
          groupValue(t, groupKey) !== groupValue(tasks[i - 1], groupKey))
          ? GROUP_HEADING_HEIGHT
          : 0,
      ),
    [tasks, group, groupKey],
  );
  const groupHeight = (i: number) => groupHeights[i] || 0;
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (group)
      for (const t of tasks) {
        const key = groupValue(t, groupKey);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    return counts;
  }, [tasks, group, groupKey]);
  // 묶음마다 첫 행의 순번. 스크롤 위치에서 고정할 묶음 제목을 이 목록으로 찾는다.
  const groupStarts = useMemo(
    () => groupHeights.flatMap((height, i) => (height ? [i] : [])),
    [groupHeights],
  );
  // 셀 글자 크기에 맞춘 행 높이. 렌더·스크롤마다 전체 업무를 다시 계산하지 않도록
  // 업무 목록이나 높이 설정이 바뀔 때만 구한다.
  const density = settings.defaultDensity || "compact";
  const contentHeights = useMemo(
    () =>
      tasks.map((task) => {
        const fitted = Math.max(
          density === "comfortable" ? 48 : 38,
          Math.ceil(rowFontSize(task) * (4 / 3) * 1.55 + 16),
        );
        return (
          view.rowHeights[task.id] ||
          (density === "dense"
            ? Math.max(26, Math.round((fitted * 2) / 3))
            : fitted)
        );
      }),
    [tasks, density, view.rowHeights],
  );
  const estimateSize = useCallback(
    (i: number) =>
      groupHeights[i] +
      (rowResize?.taskId === tasks[i].id
        ? rowResize.height
        : contentHeights[i]),
    [tasks, groupHeights, contentHeights, rowResize],
  );
  // 함수가 렌더마다 바뀌면 가상 스크롤이 모든 행의 위치를 다시 계산한다.
  const getItemKey = useCallback((i: number) => tasks[i].id, [tasks]);
  const taskIndexes = useMemo(
    () => new Map(tasks.map((task, index) => [task.id, index])),
    [tasks],
  );
  const inputTaskId = editor?.point.taskId || selection?.focus.taskId;
  const inputIndex = inputTaskId ? (taskIndexes.get(inputTaskId) ?? -1) : -1;
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indices = defaultRangeExtractor(range);
      // 화면 밖에서도 선택한 셀의 IME 입력창과 편집 중인 입력창을 유지한다.
      return inputIndex >= 0
        ? [...new Set([...indices, inputIndex])].sort((a, b) => a - b)
        : indices;
    },
    [inputIndex],
  );
  const virtual = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => ref.current,
    estimateSize,
    overscan: 12,
    getItemKey,
    scrollMargin: 32,
    // Keep rows above a classic horizontal scrollbar (up to 18px), if any.
    scrollPaddingEnd: footer ? 18 : 0,
    rangeExtractor,
  });
  useLayoutEffect(() => {
    virtual.measure();
  }, [estimateSize]);
  // 행의 위쪽이 가려지면 보이게 할 스크롤 위치. 열 머리글(scrollMargin)과 고정한
  // 묶음 제목이 행을 가린다. 묶음의 첫 행은 자기 제목이 고정 위치에 오므로
  // 열 머리글만 피한다. 1px 미만으로 걸친 행은 보이는 것으로 본다.
  function coveredRowOffset(index: number) {
    const item = virtual.measurementsCache[index];
    const cover =
      virtual.options.scrollMargin +
      (group && !groupHeights[index] ? GROUP_HEADING_HEIGHT : 0);
    return item && item.start - cover + 1 <= (ref.current?.scrollTop ?? 0)
      ? item.start - cover
      : null;
  }
  function scrollToRow(index: number) {
    const offset = coveredRowOffset(index);
    if (offset === null) virtual.scrollToIndex(index, { align: "auto" });
    else virtual.scrollToOffset(offset);
  }
  useLayoutEffect(() => {
    if (jump && ref.current && appliedJump.current !== jump.id) {
      if (jump.key === null) {
        if (!jump.preserveHorizontalScroll) ref.current.scrollLeft = 0;
        if (jump.scrollTop !== undefined)
          ref.current.scrollTop = jump.scrollTop;
        appliedJump.current = jump.id;
        return;
      }
      const index = columns.findIndex((c) => c.key === jump.key);
      if (index >= 0) {
        if (jump.taskId) {
          const row = taskIndexes.get(jump.taskId);
          if (row === undefined) return;
          if (
            !jump.nearest ||
            coveredRowOffset(row) !== null ||
            virtual.getOffsetForIndex(row, "auto")?.[1] !== "auto"
          )
            virtual.scrollToIndex(row, { align: "center" });
        }
        const pinned =
          rowHeaderWidth +
          columns.filter((c) => c.fixed).reduce((s, c) => s + c.width, 0);
        const grid = ref.current,
          left = positions[index];
        if (
          !jump.preserveHorizontalScroll &&
          !columns[index].fixed &&
          !(
            jump.nearest &&
            left >= grid.scrollLeft + pinned &&
            left + columns[index].width <= grid.scrollLeft + grid.clientWidth
          )
        )
          grid.scrollLeft = Math.max(0, left - pinned - 16);
        appliedJump.current = jump.id;
      }
    }
  }, [jump, columns, taskIndexes]);
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!editor || !grid) return;
    const ri = tasks.findIndex((t) => t.id === editor.point.taskId);
    if (ri >= 0) scrollToRow(ri);
    const ci = columns.findIndex((c) => c.key === editor.point.key);
    if (ci < 0 || columns[ci].fixed) return;
    const pinned =
      rowHeaderWidth +
      columns.filter((c) => c.fixed).reduce((sum, c) => sum + c.width, 0);
    const left = positions[ci];
    const right = left + columns[ci].width;
    // 이미 보이는 편집 셀은 가로 위치를 유지한다. 고정 열에 가리거나
    // 화면 밖에 있을 때만 그리드 안에서 필요한 만큼 이동한다.
    if (left < grid.scrollLeft + pinned)
      grid.scrollLeft = Math.max(0, left - pinned);
    else if (right > grid.scrollLeft + grid.clientWidth)
      grid.scrollLeft = Math.max(
        0,
        Math.min(left - pinned, right - grid.clientWidth),
      );
  }, [editor?.point.taskId, editor?.point.key]);
  return {
    groupHeight,
    groupCounts,
    groupStarts,
    density,
    contentHeights,
    taskIndexes,
    virtual,
    scrollToRow,
  };
}
