import { useLayoutEffect, useRef, useState } from "react";
import type {
  ChartCell,
  ChartResult,
  InsightChart,
  InsightsContext,
} from "./insights-types";
import {
  chartTicks,
  chartInk,
  insightNumber,
  Legend,
  percentValue,
  seriesColors,
} from "./insights-chart-presentation";

export default function InsightsBarChart({
  chart,
  result,
  ctx,
  onDrill,
  comparison = false,
}: {
  chart: InsightChart;
  result: ChartResult;
  ctx: InsightsContext;
  onDrill: (cell?: ChartCell) => void;
  comparison?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null),
    [available, setAvailable] = useState(720);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setAvailable(Math.max(620, Math.floor(entry.contentRect.width))),
    );
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const horizontal = comparison || chart.display?.orientation === "horizontal";
  const additive = [
    "count",
    "completed",
    "inProgress",
    "workWeeks",
    "delayed",
    "numberSum",
  ].includes(chart.values[0].kind);
  const requestedStack = comparison || chart.display?.mode === "stacked";
  const stacked =
    requestedStack && additive && chart.display?.percent !== "series";
  const cells = new Map(
    result.cells.map((cell) => [JSON.stringify([cell.row, cell.series]), cell]),
  );
  const cellFor = (row: string, series: string) =>
    cells.get(JSON.stringify([row, series]))!;
  const colors = seriesColors(
    chart,
    ctx,
    result.series.map((series) => series.key),
  );
  const positive = result.rows.map((row) =>
    result.series.reduce(
      (sum, series) =>
        sum + Math.max(0, cellFor(row.key, series.key).values[0].value),
      0,
    ),
  );
  const negative = result.rows.map((row) =>
    result.series.reduce(
      (sum, series) =>
        sum + Math.min(0, cellFor(row.key, series.key).values[0].value),
      0,
    ),
  );
  const domain = chartTicks(
    Math.min(
      0,
      ...(stacked
        ? negative
        : result.cells.map((cell) => cell.values[0].value)),
    ),
    Math.max(
      0,
      ...(stacked
        ? positive
        : result.cells.map((cell) => cell.values[0].value)),
    ),
  );
  const rowHeight = stacked ? 38 : Math.max(36, result.series.length * 14 + 10);
  const width = horizontal
    ? available
    : Math.max(
        available,
        result.rows.length * Math.max(60, result.series.length * 14 + 18),
      );
  const height = horizontal
    ? Math.max(100, result.rows.length * rowHeight + 56)
    : 310;
  const left = horizontal
    ? Math.min(
        190,
        Math.max(
          100,
          ...result.rows.map((row) => Math.min(15, row.label.length) * 11 + 18),
        ),
      )
    : 58;
  const top = 24,
    right = 70,
    bottom = horizontal ? 32 : 64;
  const plotLength = horizontal ? width - left - right : height - top - bottom;
  const unit = plotLength / (domain.max - domain.min);
  const zero = horizontal
    ? left - domain.min * unit
    : height - bottom + domain.min * unit;
  const band = horizontal
    ? rowHeight
    : (width - left - right) / Math.max(1, result.rows.length);
  const pct = percentValue(chart);
  const names = new Map(result.rows.map((row) => [row.key, row.label]));
  const labels = new Map(
    result.series.map((series) => [series.key, series.label]),
  );
  const accessible = (cell: ChartCell) =>
    `${names.get(cell.row)} · ${labels.get(cell.series)}: ${insightNumber(cell.values[0].value, pct)}`;
  const activate = (cell: ChartCell) => ({
    role: "button",
    tabIndex: 0,
    "aria-label": accessible(cell),
    onClick: () => onDrill(cell),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onDrill(cell);
      }
    },
  });
  return (
    <>
      <div ref={root} className="insights-chart-scroll">
        {!result.rows.length || !result.series.length ? (
          <p className="field-help">해당 업무가 없습니다.</p>
        ) : (
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            className="insights-bars"
            aria-label={chart.title}
            role="group"
          >
            {horizontal && stacked && (
              <text
                x={width - right + 10}
                y={top - 8}
                className="insights-bar-total"
              >
                합계
              </text>
            )}
            {domain.ticks.map((tick) => {
              const position = horizontal
                ? zero + tick * unit
                : zero - tick * unit;
              return (
                <g
                  key={tick}
                  className={
                    tick === 0 ? "insights-zero-axis" : "insights-chart-grid"
                  }
                >
                  <line
                    x1={horizontal ? position : left}
                    x2={horizontal ? position : width - right}
                    y1={horizontal ? top - 8 : position}
                    y2={horizontal ? height - bottom : position}
                  />
                  <text
                    x={horizontal ? position : left - 10}
                    y={horizontal ? height - 8 : position + 4}
                    textAnchor={horizontal ? "middle" : "end"}
                  >
                    {insightNumber(tick, pct)}
                  </text>
                </g>
              );
            })}
            {result.rows.map((row, rowIndex) => {
              let above = 0,
                below = 0;
              const rowTotal = result.rowTotals[row.key]?.[0];
              return (
                <g key={row.key}>
                  <text
                    x={horizontal ? left - 12 : left + (rowIndex + 0.5) * band}
                    y={
                      horizontal
                        ? top + (rowIndex + 0.5) * band + 4
                        : height - bottom + 20
                    }
                    textAnchor={horizontal ? "end" : "middle"}
                    className="insights-axis-label"
                  >
                    <title>{row.label}</title>
                    {row.label.length > (horizontal ? 15 : 10)
                      ? row.label.slice(0, horizontal ? 14 : 9) + "…"
                      : row.label}
                  </text>
                  {result.series.map((series, seriesIndex) => {
                    const cell = cellFor(row.key, series.key),
                      n = cell.values[0].value;
                    const offset = stacked ? (n >= 0 ? above : below) : 0;
                    if (n >= 0) above += n;
                    else below += n;
                    const thickness =
                      (band - 12) / (stacked ? 1 : result.series.length);
                    const cross =
                      (horizontal ? top : left) +
                      rowIndex * band +
                      6 +
                      (stacked ? 0 : seriesIndex * thickness);
                    const start = horizontal
                      ? zero + Math.min(offset, offset + n) * unit
                      : zero - Math.max(offset, offset + n) * unit;
                    const length = Math.abs(n) * unit,
                      color = colors.get(series.key)!;
                    const showInside = stacked && n !== 0 && length >= 34;
                    return (
                      <g
                        key={series.key}
                        {...activate(cell)}
                        className="insights-bar-mark"
                        data-value={n}
                      >
                        <title>{accessible(cell)}</title>
                        <rect
                          x={horizontal ? start : cross}
                          y={horizontal ? cross : start}
                          width={
                            horizontal ? length : Math.max(1, thickness - 2)
                          }
                          height={
                            horizontal ? Math.max(1, thickness - 2) : length
                          }
                          fill={color}
                          rx={stacked ? 0 : 2}
                        />
                        {(!stacked ||
                          showInside ||
                          result.series.length === 1) && (
                          <text
                            x={
                              horizontal
                                ? showInside
                                  ? start + length / 2
                                  : zero + n * unit + (n < 0 ? -5 : 5)
                                : cross + (thickness - 2) / 2
                            }
                            y={
                              horizontal
                                ? cross + thickness / 2 + 3
                                : showInside
                                  ? start + length / 2 + 4
                                  : zero - n * unit + (n < 0 ? 14 : -6)
                            }
                            textAnchor={
                              horizontal
                                ? showInside
                                  ? "middle"
                                  : n < 0
                                    ? "end"
                                    : "start"
                                : "middle"
                            }
                            fill={showInside ? chartInk(color) : "var(--ink)"}
                            className="insights-bar-value"
                          >
                            {insightNumber(n, pct)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                  {stacked && rowTotal && (
                    <text
                      x={
                        horizontal
                          ? width - right + 10
                          : left + (rowIndex + 0.5) * band
                      }
                      y={
                        horizontal
                          ? top + (rowIndex + 0.5) * band + 4
                          : zero - above * unit - 9
                      }
                      textAnchor={horizontal ? "start" : "middle"}
                      className="insights-bar-total"
                    >
                      <title>중복을 제거한 행 전체 값</title>
                      {insightNumber(rowTotal.value, pct)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {result.series.length > 1 && (
        <Legend series={result.series} colors={colors} />
      )}
      {requestedStack && !stacked && (
        <p className="insights-chart-note">
          평균·비율·최댓값과 계열 안 %는 누적하지 않고 묶음 막대로 비교합니다.
        </p>
      )}
      {stacked &&
        (chart.dimensions.series?.kind === "time" ||
          chart.dimensions.column?.kind === "time") && (
          <p className="insights-chart-note">
            여러 기간에 속한 업무는 막대에 반복됩니다. 행 전체 값은 중복을
            제거합니다.
          </p>
        )}
      {chart.display?.percent === "series" && (
        <p className="insights-chart-note">
          각 계열의 전체 집계 값이 100%입니다.
        </p>
      )}
      {chart.display?.percent === "total" && (
        <p className="insights-chart-note">
          중복을 제거한 전체 집계 값이 100%입니다.
        </p>
      )}
      {result.totals[0]?.excluded > 0 && (
        <small>제외 {result.totals[0].excluded}건</small>
      )}
    </>
  );
}
