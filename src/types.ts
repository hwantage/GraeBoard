export type ThemeId = import("../shared/themes.js").ThemeId;
export type Border = {
  style: "none" | "solid" | "medium" | "thick" | "dashed" | "dotted" | "double";
  color: string;
};
export type BorderPreset =
  | "all"
  | "inner"
  | "horizontal"
  | "vertical"
  | "outside"
  | "left"
  | "top"
  | "right"
  | "bottom"
  | "none";
export type Style = {
  // null clears inherited borders while preserving the native grid lines.
  borderTop?: Border | null;
  borderRight?: Border | null;
  borderBottom?: Border | null;
  borderLeft?: Border | null;
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSize?: number;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  textMode?: "overflow" | "wrap" | "clip";
};
export type Cell = {
  value: string | number | string[];
  style: Style;
  version: number;
};
export type Task = {
  id: string;
  teamId: string;
  years: number[];
  position: number;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  cells: Record<string, Cell>;
  defaultStyle?: Style;
};
export type User = {
  id: string;
  username: string;
  name: string;
  systemRole: "admin" | "user";
  active: boolean;
  color: string;
  avatarInitials?: string;
  avatarImage?: string;
  teamIds: string[];
  teamRoles: Record<string, TeamRole>;
};
export type TeamRole = "lead" | "member" | "viewer";
export type PropertyOption = {
  id: string;
  label: string;
  backgroundColor: string;
  dotColor: string;
  emoji: string;
  archived?: boolean;
};
export type Property = {
  id: string;
  name: string;
  kind?: "option" | "text" | "date" | "number" | "member";
  display: "text" | "round" | "square" | "dot" | "emoji" | "avatar";
  multiple?: boolean;
  visible?: boolean;
  width?: number;
  placement?: "beforeWeeks" | "afterWeeks";
  values: PropertyOption[];
  archived?: boolean;
};
export type Settings = {
  defaultDensity?: "comfortable" | "compact" | "dense";
  weekHeader?: { color?: string; backgroundColor?: string };
  theme?: ThemeId;
  properties?: Property[];
  revision?: number;
  defaultStyle?: Style;
};
export type Team = { id: string; name: string; settings: Settings };
export type FilterMode = "include" | "exclude";
export type View = {
  year: number;
  startMonth: number;
  propertyFilters?: Record<string, string[]>;
  propertyFilterModes?: Record<string, FilterMode>;
  fromMonth: number;
  toMonth: number;
  fromWeek?: string;
  toWeek?: string;
  hiddenRows: string[];
  hiddenWeeks: string[];
  collapsedMonths: number[];
  visibleFields: string[];
  frozenColumns?: number;
  widths: Record<string, number>;
  rowHeights: Record<string, number>;
  groupBy?: string;
  sortKey?: string;
  sortDirection?: "asc" | "desc" | "default";
  knownProperties?: string[];
  columnVisibility?: Record<string, boolean>;
};
export type Bootstrap = {
  user: User;
  users: User[];
  teams: Team[];
  years: number[];
};
export type Point = { taskId: string; key: string };
export type SelectionArea = {
  anchor: Point;
  focus: Point;
  kind?: "cells" | "columns" | "rows" | "all";
};
export type Selection = SelectionArea & { areas?: SelectionArea[] };
export type CellChange = Point & {
  value?: Cell["value"];
  style?: Style;
  expectedVersion: number;
};
export type SavedCell = Point & Cell;
export type BatchResult = {
  cells: SavedCell[];
  before: SavedCell[];
  updatedAt?: Record<string, string>;
  operationId: string;
  savedAt: string;
};
// 실행취소 기록. 셀 변경 묶음과 업무(행) 삭제를 함께 쌓는다.
export type TaskDeletion = {
  kind: "delete";
  ids: string[];
  title: string;
};
export type HistoryEntry = BatchResult | TaskDeletion;
export type Report = {
  id: string;
  name: string;
  year: number;
  referenceDate: string;
  createdAt: string;
  tasks: Task[];
  users: User[];
  view: View;
  settings?: Settings;
};
