import InsightsLineChart from "./InsightsLineChart";
import InsightsPieChart from "./InsightsPieChart";
import { value, displayValue } from "../../shared/domain.js";
import { DEADLINE_LABELS } from "../../shared/insights/insights.js";
import type {
  InsightChart,
  ChartResult,
  ChartCell,
  InsightsContext,
  TaskMetrics,
} from "./insights-types";

import InsightsChartData from "./InsightsChartData";
import InsightsMatrix from "./InsightsMatrix";
import InsightsBarChart from "./InsightsBarChart";
import InsightsRadarChart from "./InsightsRadarChart";
import {
  insightNumber,
  insightValueLabel,
  percentValue,
  ValueText,
} from "./insights-chart-presentation";
export {
  insightNumber,
  insightValueLabel,
} from "./insights-chart-presentation";

export function InsightsTaskTable({
  metrics,
  ctx,
  onTask,
  sortLabel,
}: {
  metrics: (TaskMetrics & { sortValue?: number })[];
  ctx: InsightsContext;
  onTask: (metric: TaskMetrics) => void;
  sortLabel?: string;
}) {
  return (
    <div className="insights-table-scroll">
      <table className="insights-table">
        <thead>
          <tr>
            <th scope="col">작업명</th>
            <th scope="col">책임자</th>
            <th scope="col" className="insights-number-column">
              작업 주
            </th>
            <th scope="col" className="insights-number-column">
              업무 기간
            </th>
            <th scope="col">목표일 상태</th>
            {sortLabel && (
              <th scope="col" className="insights-number-column">
                {sortLabel}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {metrics.map((metric) => (
            <tr key={metric.task.id} onClick={() => onTask(metric)}>
              <th scope="row">
                <button
                  className="insights-task-link"
                  onClick={(event) => {
                    event.stopPropagation();
                    onTask(metric);
                  }}
                >
                  {String(value(metric.task, "title")) || "(제목 없음)"}
                </button>
              </th>
              <td>
                {displayValue(metric.task, "owner", ctx.users, ctx.settings) ||
                  "(미지정)"}
              </td>
              <td className="insights-number-column">
                {metric.rangeWeeks.length}주
              </td>
              <td className="insights-number-column">{metric.duration}주</td>
              <td>{DEADLINE_LABELS[metric.deadlineState]}</td>
              {sortLabel && (
                <td className="insights-number-column">
                  {insightNumber(metric.sortValue || 0)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!metrics.length && <p className="field-help">해당 업무가 없습니다.</p>}
    </div>
  );
}

export default function InsightsChart({
  chart,
  result,
  ctx,
  onDrill,
  onTask,
  presentation,
}: {
  chart: InsightChart;
  presentation?: "matrix" | "stacked";
  result: ChartResult;
  ctx: InsightsContext;
  onDrill: (cell?: ChartCell) => void;
  onTask: (metric: TaskMetrics) => void;
}) {
  const percent = (index = 0) => percentValue(chart, index);
  if (result.errors.length)
    return (
      <p className="error-note" role="alert">
        {result.errors.join(" ")}
      </p>
    );
  if (chart.type === "number")
    return (
      <button
        className="insights-number"
        aria-label={`${chart.title}: ${insightNumber(result.cells[0]?.values[0].value || 0, percent())}`}
        onClick={() => onDrill()}
      >
        <strong>
          <ValueText
            result={result.cells[0]?.values[0] || { value: 0, excluded: 0 }}
            percent={percent()}
          />
        </strong>
        <span>{insightValueLabel(chart.values[0], ctx)}</span>
      </button>
    );
  if (chart.type === "top")
    return (
      <>
        <InsightsTaskTable
          metrics={result.list}
          ctx={ctx}
          onTask={onTask}
          sortLabel={
            chart.sort?.kind === "duration"
              ? "업무 기간 순"
              : chart.sort?.kind === "delayWeeks"
                ? "지연 주 순"
                : "숫자 열 순"
          }
        />
        {!!result.excluded && <small>제외 {result.excluded}건</small>}
      </>
    );
  if (chart.type === "table" && presentation !== "stacked")
    return (
      <InsightsMatrix
        chart={chart}
        result={result}
        ctx={ctx}
        onDrill={onDrill}
      />
    );
  if (chart.type === "line" || chart.type === "pie") {
    const Plot = chart.type === "line" ? InsightsLineChart : InsightsPieChart;
    return (
      <>
        <Plot chart={chart} result={result} ctx={ctx} onDrill={onDrill} />
        <InsightsChartData chart={chart} result={result} ctx={ctx} />
      </>
    );
  }
  if (chart.type === "radar")
    return (
      <>
        <InsightsRadarChart
          chart={chart}
          result={result}
          ctx={ctx}
          onDrill={onDrill}
        />
        <InsightsChartData chart={chart} result={result} ctx={ctx} />
      </>
    );
  return (
    <>
      <InsightsBarChart
        chart={chart}
        result={result}
        ctx={ctx}
        onDrill={onDrill}
        comparison={presentation === "stacked"}
      />
      <InsightsChartData chart={chart} result={result} ctx={ctx} />
    </>
  );
}
