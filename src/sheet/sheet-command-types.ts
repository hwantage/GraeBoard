import type { HistoryEntry, Point, Selection, Task } from "../types";
export type SheetEditor = { point: Point; initial?: string; task: Task };
export type SheetJump = {
  key: string | null;
  taskId?: string;
  id: number;
  preserveHorizontalScroll?: boolean;
  scrollTop?: number;
  nearest?: boolean;
};
export type SheetUndoNotice =
  | ({ message: string } & (
      | { kind: "filter"; undo: () => Promise<void> }
      | { kind: "rows"; sheet: string; target: HistoryEntry | Task[] }
      | {
          // 업무 색과 같은 일반 배경색 칠하기 안내. 칠하기로 생긴 실행취소
          // 기록(target)이 최신일 때만 유지하며, 같은 범위를 업무 표시로 바꾼다.
          kind: "work";
          sheet: string;
          before: HistoryEntry | Task[] | undefined;
          target?: HistoryEntry | Task[];
          mark: { color: string; selection: Selection };
        }
    ))
  | null;
