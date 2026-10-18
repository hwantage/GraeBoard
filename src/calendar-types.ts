import type { FilterMode, Settings, TaskDocument, User } from "./types";
export type CalendarEntry = {
  id: string;
  teamId: string;
  userId: string | null;
  date: string;
  endDate: string;
  lane: number;
  title: string;
  preview: string;
  revision: number;
  updatedAt: string;
  tagIds: string[];
  checkedTagIds: string[];
};
export type CalendarPlacement = Pick<
  CalendarEntry,
  "id" | "date" | "endDate" | "lane"
>;
export type CalendarEntryUpdate = CalendarEntry & {
  layout?: CalendarPlacement[];
  placements?: { id: string; lane: number }[];
};
export type CalendarEntryDeletion = {
  layout: CalendarPlacement[];
  deletionId: string;
  placements: { id: string; lane: number }[];
};
export type CalendarTag = {
  id: string;
  teamId: string;
  userId: string | null;
  name: string;
  color: string;
  kind: "label" | "check";
  revision: number;
  usageCount: number;
};
export type CalendarTagCheck = {
  tagId: string;
  checked: boolean;
  updatedAt: string;
};
export type CalendarDocument = TaskDocument & { entry: CalendarEntry };
export type WeeklyItem = {
  userId: string;
  weekStart: string;
  taskId: string;
  title: string;
  importedAt: string;
  unavailable: boolean;
};
export type WeeklyAddResult = {
  added: number;
  existing: number;
  weekly: WeeklyItem[];
};
export type CalendarTaskOption = {
  id: string;
  title: string;
  years: number[];
  added: boolean;
};
export type CalendarRule = {
  propertyId: string;
  values: string[];
  mode: FilterMode;
  revision: number;
};
export type CalendarContext = {
  members: User[];
  tags: CalendarTag[];
  settings: Settings;
  rule: CalendarRule;
  ruleProblem: string;
};
export type CalendarData = {
  entries: CalendarEntry[];
  weekly: WeeklyItem[];
  layout: CalendarPlacement[];
};
