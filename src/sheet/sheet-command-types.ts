import type { HistoryEntry, Point, Task } from "../types";
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
    ))
  | null;
