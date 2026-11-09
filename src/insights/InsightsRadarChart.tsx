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

export default function InsightsRadarChart({
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
  const [viewport, setViewport] = useState({ width: 500, height: 335 });
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const next = {
        width: Math.max(280, Math.floor(entry.contentRect.width)),
        height: Math.max(240, Math.floor(entry.contentRect.height)),
      };
      setViewport((current) =>
        current.width === next.width && current.height === next.height
          ? current
          : next,
      );
    });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, [result.rows.length, result.series.length]);
  const cells = new Map(
    result.cells.map((cell) => [JSON.stringify([cell.row, cell.series]), cell]),
  );
  const colors = seriesColors(
    chart,
    ctx,
    result.series.map((series) => series.key),
  );
  const pct = percentValue(chart);
  const domain = chartTicks(
    Math.min(0, ...result.cells.map((cell) => cell.values[0].value)),
    Math.max(
      pct ? 100 : 0,
      ...result.cells.map((cell) => cell.values[0].value),
    ),
  );
  const cx = viewport.width / 2,
    cy = viewport.height / 2,
    radius = Math.min(
      125,
      (viewport.width - 146) / 2,
      (viewport.height - 70) / 2,
    ),
    count = result.rows.length;
  const point = (index: number, distance: number) => [
    cx + Math.sin((index * Math.PI * 2) / count) * distance,
    cy - Math.cos((index * Math.PI * 2) / count) * distance,
  ];
  const distance = (value: number) =>
    ((value - domain.min) / (domain.max - domain.min)) * radius;
  if (!count || !result.series.length)
    return <p className="field-help">해당 업무가 없습니다.</p>;
  return (
    <>
      <div className="insights-radar-scroll" ref={container}>
        <svg
          viewBox={`0 0 ${viewport.width} ${viewport.height}`}
          className="insights-radar"
          aria-label={chart.title}
          role="group"
        >
          {domain.ticks.map((tick) => (
            <g
              key={tick}
              className={
                tick === 0 ? "insights-zero-axis" : "insights-chart-grid"
              }
            >
              <polygon
                points={result.rows
                  .map((_, index) => point(index, distance(tick)).join(","))
                  .join(" ")}
                fill="none"
              />
              <text x={cx + 5} y={cy - distance(tick) - 4}>
                {insightNumber(tick, pct)}
              </text>
            </g>
          ))}
          {result.rows.map((row, index) => {
            const [x, y] = point(index, radius + 25),
              [ex, ey] = point(index, radius);
            const anchor =
              x < cx - 10 ? "end" : x > cx + 10 ? "start" : "middle";
            const labelWidth =
              anchor === "end"
                ? x - 6
                : anchor === "start"
                  ? viewport.width - x - 6
                  : viewport.width - 12;
            const labelLength = Math.max(
              2,
              Math.min(10, Math.floor(labelWidth / 11)),
            );
            const label = Array.from(row.label);
            return (
              <g key={row.key}>
                <line x1={cx} y1={cy} x2={ex} y2={ey} stroke="var(--line)" />
                <text
                  x={x}
                  y={y + 4}
                  textAnchor={anchor}
                  className="insights-radar-axis-label"
                  fill="var(--ink)"
                >
                  <title>{row.label}</title>
                  {label.length > labelLength
                    ? label.slice(0, labelLength - 1).join("") + "…"
                    : row.label}
                </text>
              </g>
            );
          })}
          {result.series.map((series) => (
            <g key={series.key} style={{ color: colors.get(series.key) }}>
              <polygon
                points={result.rows
                  .map((row, index) =>
                    point(
                      index,
                      distance(
                        cells.get(JSON.stringify([row.key, series.key]))!
                          .values[0].value,
                      ),
                    ).join(","),
                  )
                  .join(" ")}
                fill="currentColor"
                fillOpacity=".08"
                stroke="currentColor"
                strokeWidth={2}
              />
              {result.rows.map((row, index) => {
                const cell = cells.get(JSON.stringify([row.key, series.key]))!,
                  [x, y] = point(index, distance(cell.values[0].value));
                const label = `${row.label} · ${series.label}: ${insightNumber(cell.values[0].value, pct)}`;
                return (
                  <g key={row.key}>
                    <circle
                      cx={x}
                      cy={y}
                      r={4.5}
                      fill="currentColor"
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
                    {result.series.length <= 2 &&
                      distance(cell.values[0].value) > 10 && (
                        <text
                          x={x + (x <= cx + 10 ? -9 : 9)}
                          y={y + (y > cy + 10 ? 12 : -5)}
                          textAnchor={x <= cx + 10 ? "end" : "start"}
                          fill="var(--ink)"
                          className="insights-radar-value"
                        >
                          {insightNumber(cell.values[0].value, pct)}
                        </text>
                      )}
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
      </div>
      <Legend series={result.series} colors={colors} />
      {domain.min < 0 && (
        <p className="insights-chart-note">
          0 눈금 안쪽은 음수, 바깥쪽은 양수입니다.
        </p>
      )}
      {result.totals[0]?.excluded > 0 && (
        <small>제외 {result.totals[0].excluded}건</small>
      )}
    </>
  );
}
