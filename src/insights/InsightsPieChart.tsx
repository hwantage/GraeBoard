import type { KeyboardEvent } from "react";
import type {
  ChartCell,
  ChartResult,
  InsightChart,
  InsightsContext,
} from "./insights-types";
import {
  insightNumber,
  percentValue,
  seriesColors,
} from "./insights-chart-presentation";

export default function InsightsPieChart({
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
  const colors = seriesColors(
    chart,
    ctx,
    result.rows.map((row) => row.key),
  );
  const cells = new Map(result.cells.map((cell) => [cell.row, cell]));
  const total = result.cells.reduce((sum, cell) => sum + cell.values[0].raw, 0);
  let angle = -Math.PI / 2;
  const slices = result.rows.map((row) => {
    const cell = cells.get(row.key)!,
      share = total ? cell.values[0].raw / total : 0;
    const start = angle;
    angle += share * 2 * Math.PI;
    return { row, cell, share, start, end: angle };
  });
  const cx = 150,
    cy = 145,
    radius = 112;
  const point = (a: number) =>
    cx + radius * Math.cos(a) + " " + (cy + radius * Math.sin(a));
  return (
    <>
      <div className="insights-chart-scroll insights-pie-layout">
        {total > 0 ? (
          <svg
            viewBox="0 0 300 290"
            className="insights-pie"
            role="group"
            aria-label={chart.title}
          >
            {slices
              .filter((slice) => slice.share > 0)
              .map(({ row, cell, share, start, end }) => {
                const label =
                  row.label +
                  ": " +
                  insightNumber(cell.values[0].raw) +
                  " · " +
                  insightNumber(share * 100, true);
                const props = {
                  fill: colors.get(row.key),
                  stroke: "#fff",
                  strokeWidth: 2,
                  role: "button",
                  tabIndex: 0,
                  "aria-label": label,
                  onClick: () => onDrill(cell),
                  onKeyDown: (event: KeyboardEvent<SVGElement>) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onDrill(cell);
                    }
                  },
                };
                return share === 1 ? (
                  <circle key={row.key} cx={cx} cy={cy} r={radius} {...props}>
                    <title>{label}</title>
                  </circle>
                ) : (
                  <path
                    key={row.key}
                    d={
                      "M " +
                      cx +
                      " " +
                      cy +
                      " L " +
                      point(start) +
                      " A " +
                      radius +
                      " " +
                      radius +
                      " 0 " +
                      (share > 0.5 ? 1 : 0) +
                      " 1 " +
                      point(end) +
                      " Z"
                    }
                    {...props}
                  >
                    <title>{label}</title>
                  </path>
                );
              })}
          </svg>
        ) : (
          <p className="field-help">비중을 표시할 양수 값이 없습니다.</p>
        )}
        <ul className="insights-pie-legend" aria-label="파이 분류">
          {slices.map(({ row, cell, share }) => (
            <li key={row.key}>
              <button onClick={() => onDrill(cell)}>
                <span
                  className="summary-dot"
                  style={{ backgroundColor: colors.get(row.key) }}
                />
                <span>{row.label}</span>
                <strong>
                  {insightNumber(cell.values[0].value, percentValue(chart))}
                </strong>
                {!percentValue(chart) && (
                  <small>{insightNumber(share * 100, true)}</small>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {!!result.totals[0]?.excluded && (
        <small>제외 {result.totals[0].excluded}건</small>
      )}
    </>
  );
}
