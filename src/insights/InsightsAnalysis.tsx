import InsightsTrend from "./InsightsTrend";
import { useMemo } from "react";
import { aggregate } from "../../shared/insights/insights.js";
import InsightsChart from "./InsightsChart";
import InsightsPeopleRadar from "./InsightsPeopleRadar";
import {
  monthlyWorkDefinition,
  rankedOwners,
} from "./insights-chart-templates";
import type { Task } from "../types";
import type {
  ChartCell,
  ChartResult,
  InsightChart,
  InsightsContext,
  TaskMetrics,
} from "./insights-types";

const reports: { chart: InsightChart; note: string }[] = [
  {
    chart: { id: "cmonth0", ...monthlyWorkDefinition },
    note: "선택 기간에 표시한 작업 주 합",
  },
  {
    chart: {
      id: "cdurat0",
      title: "업무 기간 분포",
      type: "bar",
      dimensions: { axis: { kind: "durationBand" } },
      values: [{ kind: "count" }],
    },
    note: "범위에 포함된 업무 수 · 업무 기간은 불러온 전체 작업 주 기준",
  },
  {
    chart: {
      id: "cdeadl0",
      title: "목표일 준수 현황",
      type: "bar",
      dimensions: { axis: { kind: "deadlineState" } },
      values: [{ kind: "count" }],
      display: { orientation: "horizontal" },
    },
    note: "범위 내 업무 수 · 목표일이 없는 업무도 별도로 표시",
  },
];
export default function InsightsAnalysis({
  tasks,
  ctx,
  teamId,
  ownerSummary,
  onDrill,
  onTask,
}: {
  tasks: Task[];
  ctx: InsightsContext;
  teamId: string;
  ownerSummary: ChartResult;
  onDrill: (chart: InsightChart, cell?: ChartCell) => void;
  onTask: (metric: TaskMetrics) => void;
}) {
  const results = useMemo(
    () => reports.map(({ chart }) => aggregate(tasks, chart, ctx)),
    [tasks, ctx],
  );
  const owners = useMemo(() => rankedOwners(ownerSummary), [ownerSummary]);
  const renderChart = (index: number) => {
    const { chart, note } = reports[index];
    return (
      <article className="insights-card insights-analysis-card">
        <div className="insights-card-heading">
          <h2>{chart.title}</h2>
        </div>
        <p className="insights-chart-unit">{note}</p>
        <InsightsChart
          chart={chart}
          result={results[index]}
          ctx={ctx}
          onDrill={(cell) => onDrill(chart, cell)}
          onTask={onTask}
        />
      </article>
    );
  };
  return (
    <section className="insights-grid insights-analysis" aria-label="기본 분석">
      <InsightsTrend
        tasks={tasks}
        ctx={ctx}
        owners={owners}
        onDrill={onDrill}
        onTask={onTask}
      />
      {renderChart(0)}
      <InsightsPeopleRadar
        tasks={tasks}
        ctx={ctx}
        teamId={teamId}
        owners={owners}
        onDrill={onDrill}
        onTask={onTask}
      />
      {renderChart(1)}
      {renderChart(2)}
    </section>
  );
}
