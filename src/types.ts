export type ThemeId = import("../shared/themes.js").ThemeId;
export type Border = {
  style: "none" | "solid" | "medium" | "thick" | "dashed" | "double";
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
  // null cancels an inherited property and restores its native appearance.
  borderTop?: Border | null;
  borderRight?: Border | null;
  borderBottom?: Border | null;
  borderLeft?: Border | null;
  color?: string | null;
  backgroundColor?: string | null;
  fontFamily?: string | null;
  fontSize?: number | null;
  textAlign?: "left" | "center" | "right" | null;
  verticalAlign?: "top" | "middle" | "bottom" | null;
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: boolean | null;
  strike?: boolean | null;
  textMode?: "overflow" | "wrap" | "clip" | null;
};
export type Cell = {
  value: string | number | string[];
  style: Style;
  version: number;
};
export type DocumentInfo = {
  id: string;
  title: string;
  revision: number | string;
  hasContent: boolean;
  updatedAt: string | null;
};
export type TaskDocument = {
  sync?: { session: string; sequence: number };
  id?: string;
  title?: string;
  markdown: string;
  revision: number | string;
  updatedAt: string | null;
};
export type DocumentSaveResult = TaskDocument & {
  hasDocument: boolean;
  documentCount: number;
  taskUpdatedAt: string;
};
export type Task = {
  id: string;
  teamId: string;
  years: number[];
  position: number;
  deletedAt?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  cells: Record<string, Cell>;
  defaultStyle?: Style;
  formatting?: Formatting;
  rowStyle?: Style;
  hasDocument?: boolean;
  documentCount?: number;
  documents?: { id: string; title: string; markdown: string }[];
};
export type FormatRule = {
  id: string;
  rows: string[] | null;
  keys: string[] | null;
  excludeKeys?: string[];
  style: Style;
  orders: Record<string, number>;
};
export type Formatting = { revision: number; rules: FormatRule[] };
export type FormatScope = {
  rows: string[] | null;
  keys: string[] | null;
  excludeKeys?: string[];
  style: Style;
  reset?: boolean;
};
export type FormatChange = {
  teamId: string;
  expectedRevision: number;
  scopes?: FormatScope[];
  expectedTasks?: Record<string, string>;
  restore?: string;
  expectedCells?: Record<string, number>;
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
  weekBorders?: { left?: Border; right?: Border };
  currentWeekBorders?: { left?: Border; right?: Border };
  theme?: ThemeId;
  properties?: Property[];
  revision?: number;
  defaultStyle?: Style;
};
export type Team = {
  id: string;
  name: string;
  settings: Settings;
  status?: "unconnected" | "importing" | "active" | "maintenance";
  sync?: {
    available: boolean;
    configured: boolean;
  };
};
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
export type Bootstrap = import("../shared/session-contract").Bootstrap<
  User,
  Team
>;
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
  expectedFormatRevision?: number;
  rawStyle?: boolean;
};
export type SavedCell = Point & Cell;
export type BatchResult = {
  cells: SavedCell[];
  before: SavedCell[];
  updatedAt?: Record<string, string>;
  operationId: string;
  savedAt: string;
  formatting?: Formatting;
  formatTeamId?: string;
  formatRevision?: number;
  previousFormatRevision?: number;
  formatOperation?: boolean;
};
// 실행취소 기록. 셀 변경 묶음과 업무(행) 추가·삭제를 함께 쌓는다.
export type TaskDeletion = {
  kind: "delete";
  ids: string[];
  title: string;
  deletedVersions?: Record<string, string>;
};
export type TaskCreation = Omit<TaskDeletion, "kind"> & {
  kind: "create";
  task: Task;
};
export type HistoryEntry = BatchResult | TaskDeletion | TaskCreation;
export type Report = {
  id: string;
  revision: string;
  name: string;
  year: number;
  referenceDate: string;
  createdAt: string;
  tasks: Task[];
  users: User[];
  view: View;
  settings?: Settings;
};
