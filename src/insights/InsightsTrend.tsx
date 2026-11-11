import { useMemo, useState } from "react";
import { aggregate } from "../../shared/insights/insights.js";
import Select from "../ui/Select";
import InsightsChart from "./InsightsChart";
import type { Task } from "../types";
import type {
  ChartCell,
  InsightChart,
  InsightsContext,
  TaskMetrics,
} from "./insights-types";

export default function InsightsTrend({
  tasks,
  ctx,
  owners,
  onDrill,
  onTask,
}: {
  tasks: Task[];
  ctx: InsightsContext;
  owners: { id: string; name: string }[];
  onDrill: (chart: InsightChart, cell?: ChartCell) => void;
  onTask: (metric: TaskMetrics) => void;
}) {
  const [unit, setUnit] = useState<"week" | "month">("month");
  const [target, setTarget] = useState("all");
  const chart = useMemo<InsightChart>(
    () => ({
      id: "ctrend0",
      title: "업무 개수 추이",
      type: "line",
      dimensions: {
        axis: { kind: "time", unit, basis: "work" },
        ...(target === "people" ? { series: { kind: "owner" as const } } : {}),
      },
      values: [{ kind: "count" }],
      ...(target.startsWith("owner:")
        ? {
            filter: {
              propertyFilters: { owner: [target.slice(6)] },
              propertyFilterModes: { owner: "include" },
            },
          }
        : {}),
    }),
    [unit, target],
  );
  const result = useMemo(
    () => aggregate(tasks, chart, ctx),
    [tasks, chart, ctx],
  );
  return (
    <article className="insights-card insights-trend-card">
      <div className="insights-card-heading">
        <h2>업무 개수 추이</h2>
        <div className="insights-comparison-controls">
          <label>
            단위
            <Select
              aria-label="추이 단위"
              value={unit}
              onChange={(event) =>
                setUnit(event.target.value as "week" | "month")
              }
            >
              <option value="week">주별</option>
              <option value="month">월별</option>
            </Select>
          </label>
          <label>
            대상
            <Select
              aria-label="추이 대상"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="all">팀 전체</option>
              <option value="people">책임자별 비교</option>
              {owners.map((owner) => (
                <option key={owner.id} value={"owner:" + owner.id}>
                  {owner.name}
                </option>
              ))}
              {target.startsWith("owner:") &&
                !owners.some((owner) => "owner:" + owner.id === target) && (
                  <option value={target}>
                    {ctx.users.find((user) => "owner:" + user.id === target)
                      ?.name || "선택한 책임자 (해당 업무 없음)"}
                  </option>
                )}
            </Select>
          </label>
        </div>
      </div>
      <p className="insights-chart-unit">
        업무 표시가 있는 업무 수 · 같은 구간 안에서는 업무당 한 번 집계
      </p>
      <InsightsChart
        chart={chart}
        result={result}
        ctx={ctx}
        onDrill={(cell) => onDrill(chart, cell)}
        onTask={onTask}
      />
    </article>
  );
}
