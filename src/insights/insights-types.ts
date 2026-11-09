import type { z } from "zod";
import type { Settings, Task, User } from "../types";
import type {
  insightChartSchema,
  insightDimensionSchema,
  insightValueSchema,
  insightsSettingsSchema,
} from "../../shared/insights/insights-schema.js";

export type InsightChart = z.infer<typeof insightChartSchema>;
export type InsightDimension = z.infer<typeof insightDimensionSchema>;
export type InsightValue = z.infer<typeof insightValueSchema>;
export type InsightsSettings = z.infer<typeof insightsSettingsSchema>;
export type InsightsPeriod = { from: string; to: string };
export type TaskMetrics = {
  task: Task;
  weeks: string[];
  rangeWeeks: string[];
  duration: number;
  start: string | null;
  end: string | null;
  startMonth: string | null;
  endMonth: string | null;
  progressState: "completed" | "inProgress" | "planned" | "none";
  deadlineState:
    | "onTimeCompleted"
    | "delayedCompleted"
    | "overdue"
    | "plannedDelay"
    | "onTime"
    | "noDeadline"
    | "noWork";
  deadline: string | null;
  delayWeeks: number;
  delayed: boolean;
};
export type InsightsContext = {
  settings: Settings;
  users: User[];
  period: InsightsPeriod;
  currentWeek: string;
  colors?: Set<string>;
  cache?: ReturnType<
    typeof import("../../shared/insights/insights.js").createTaskMetricsCache
  >;
};
export type ChartCell = {
  row: string;
  series: string;
  values: { raw: number; value: number; excluded: number }[];
  taskIds: string[];
  valueIndex?: number;
  total?: boolean;
  scope?: "row" | "series" | "grand";
};
export type ChartResult = {
  rows: { key: string; label: string }[];
  series: { key: string; label: string }[];
  cells: ChartCell[];
  totals: { raw: number; excluded: number }[];
  seriesTotals: Record<
    string,
    { raw: number; value: number; excluded: number }[]
  >;
  rowTotals: Record<string, { raw: number; value: number; excluded: number }[]>;
  list: (TaskMetrics & { sortValue: number })[];
  excluded: number;
  warnings: string[];
  errors: string[];
  metrics: TaskMetrics[];
};
