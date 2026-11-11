import { useLayoutEffect, useRef, useState } from "react";
import type {
  ChartCell,
  ChartResult,
  InsightChart,
  InsightsContext,
} from "./insights-types";
import {
  chartTicks,
  insightNumber,
  Legend,
  percentValue,
  seriesColors,
} from "./insights-chart-presentation";

export default function InsightsLineChart({
  chart,
  result,
  ctx,
  onDrill,
}: {
  chart: InsightChart;
  result: ChartResult;
  ctx: InsightsContext;
  onDrill: (cell?: ChartCell) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(540);
  const hasRows = result.rows.length > 0;
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(280, Math.floor(entry.contentRect.width));
      setViewportWidth((current) => (current === width ? current : width));
    });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, [hasRows]);
  const colors = seriesColors(
    chart,
    ctx,
    result.series.map((s) => s.key),
  );
  const cells = new Map(
    result.cells.map((cell) => [JSON.stringify([cell.row, cell.series]), cell]),
  );
  const percent = percentValue(chart);
  const domain = chartTicks(
    Math.min(0, ...result.cells.map((cell) => cell.values[0].value)),
    Math.max(0, ...result.cells.map((cell) => cell.values[0].value)),
  );
  const width = Math.max(viewportWidth, result.rows.length * 25 + 85),
    height = 290;
  const left = 60,
    right = width - 25,
    top = 20,
    bottom = height - 45;
  const x = (i: number) =>
    result.rows.length === 1
      ? (left + right) / 2
      : left + (i / (result.rows.length - 1)) * (right - left);
  const y = (v: number) =>
    bottom - ((v - domain.min) / (domain.max - domain.min)) * (bottom - top);
  const lookup = (row: string, series: string) =>
    cells.get(JSON.stringify([row, series]))!;
  const unit =
    chart.dimensions.axis?.kind === "time"
      ? chart.dimensions.axis.unit
      : "month";
  const step = Math.max(
    1,
    Math.ceil(result.rows.length / Math.floor((width - 85) / 65)),
  );
  if (!hasRows) return <p className="field-help">선택한 기간이 없습니다.</p>;
  return (
    <>
      <div
        className="insights-chart-scroll insights-line-scroll"
        ref={container}
      >
        <svg
          viewBox={"0 0 " + width + " " + height}
          className="insights-lines"
          style={{ minWidth: width }}
          role="group"
          aria-label={chart.title}
        >
          {domain.ticks
            .filter(
              (tick) =>
                percent ||
                ![
                  "count",
                  "completed",
                  "inProgress",
                  "delayed",
                  "workWeeks",
                ].includes(chart.values[0].kind) ||
                Number.isInteger(tick),
            )
            .map((tick) => (
              <g
                key={tick}
                className={
                  tick === 0 ? "insights-zero-axis" : "insights-chart-grid"
                }
              >
                <line x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
                <text x={left - 9} y={y(tick) + 4} textAnchor="end">
                  {insightNumber(tick, percent)}
                </text>
              </g>
            ))}
          {result.rows.map(
            (row, i) =>
              (i % step === 0 || i === result.rows.length - 1) && (
                <text
                  key={row.key}
                  x={x(i)}
                  y={bottom + 20}
                  textAnchor="middle"
                  className="insights-axis-label"
                >
                  <title>{row.label}</title>
                  {unit === "week"
                    ? row.key.slice(5).replace("-", "/")
                    : row.key.slice(5)}
                  <tspan x={x(i)} dy={14} className="insights-axis-year">
                    {row.key.slice(0, 4)}
                  </tspan>
                </text>
              ),
          )}
          {result.series.map((series) => (
            <g key={series.key} style={{ color: colors.get(series.key) }}>
              <polyline
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                points={result.rows
                  .map(
                    (row, i) =>
                      x(i) +
                      "," +
                      y(lookup(row.key, series.key).values[0].value),
                  )
                  .join(" ")}
              />
              {result.rows.map((row, i) => {
                const cell = lookup(row.key, series.key),
                  current = cell.values[0].value;
                const previous = i
                  ? lookup(result.rows[i - 1].key, series.key).values[0].value
                  : null;
                const change =
                  previous === null
                    ? ""
                    : " · 이전 표시 구간 대비 " +
                      (current - previous > 0 ? "+" : "") +
                      insightNumber(current - previous) +
                      (percent ? "%p" : "");
                const label =
                  row.label +
                  " · " +
                  series.label +
                  ": " +
                  insightNumber(current, percent) +
                  change;
                return (
                  <circle
                    key={row.key}
                    cx={x(i)}
                    cy={y(current)}
                    r={4.5}
                    fill="currentColor"
                    stroke="var(--paper, #fff)"
                    strokeWidth={1.5}
                    role="button"
                    tabIndex={0}
                    aria-label={label}
                    onClick={() => onDrill(cell)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onDrill(cell);
                      }
                    }}
                  >
                    <title>{label}</title>
                  </circle>
                );
              })}
            </g>
          ))}
        </svg>
      </div>
      <Legend series={result.series} colors={colors} />
      {!!result.totals[0]?.excluded && (
        <small>제외 {result.totals[0].excluded}건</small>
      )}
    </>
  );
}
