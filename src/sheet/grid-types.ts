import type React from "react";
import type { KeyboardEvent } from "react";
import type { User, Task, Point, Cell } from "../types";
import type { EditMove } from "./InlineCellEditor";
export type Column = {
  key: string;
  label: string;
  width: number;
  month?: number;
  fixed?: boolean;
  weekIndex?: number;
  date?: string;
  end?: string;
};
export type ColumnReference = Pick<Column, "key" | "label" | "month">;
export type RowCommand =
  "insertBefore" | "insertAfter" | "copy" | "paste" | "delete";

export type GridActions = {
  cellPointerDown(e: React.PointerEvent, point: Point): void;
  dragSelect(e: React.PointerEvent, point: Point): void;
  doubleClick(point: Point): void;
  edit(point: Point, initial?: string): boolean;
  memberOptions(): User[];
  rowMenu(task: Task): void;
  finish(value: Cell["value"], move?: EditMove): boolean | undefined;
  cancelEdit(): void;
  startRowDrag(e: React.PointerEvent, task: Task): void;
  keyboardMoveRow(e: KeyboardEvent, task: Task): void;
  startHeaderSelection(
    e: React.PointerEvent,
    kind: "columns" | "rows",
    index: number,
  ): void;
  selectHeader(
    kind: "columns" | "rows",
    index: number,
    extend?: boolean,
    add?: boolean,
  ): number;
  openHeaderMenu(
    e: React.MouseEvent,
    kind: "columns" | "rows",
    index: number,
  ): void;
  showHeaderMenu(
    kind: "columns" | "rows",
    index: number,
    x: number,
    y: number,
  ): void;
  startRowResize(e: React.PointerEvent, index: number): void;
  revealRows(ids: string[]): void;
};
