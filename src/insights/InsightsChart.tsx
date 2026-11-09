import { value, displayValue } from "../../shared/domain.js";
import {
  DEADLINE_LABELS,
  VALUE_LABELS,
} from "../../shared/insights/insights.js";
import type {
  InsightChart,
  ChartResult,
  ChartCell,
  InsightsContext,
  TaskMetrics,
  InsightValue,
} from "./insights-types";

const palette = [
  "var(--accent)",
  "var(--ink)",
  "var(--muted)",
  "var(--error-ink)",
  "var(--filter-accent)",
  "var(--snapshot-accent)",
  "var(--document-accent)",
  "var(--accent-strong)",
];
export function insightValueLabel(
  definition: InsightValue,
  ctx: InsightsContext,
) {
  return (
    VALUE_LABELS[definition.kind] +
    ("propertyId" in definition
      ? ` · ${ctx.settings.properties?.find((p) => p.id === definition.propertyId)?.name || definition.propertyId}`
      : "")
  );
}
export function insightNumber(number: number, percent = false) {
  return (
    new Intl.NumberFormat("ko", { maximumFractionDigits: 2 }).format(number) +
    (percent ? "%" : "")
  );
}
function ValueText({
  result,
  percent,
}: {
  result: { value: number; excluded: number };
  percent: boolean;
}) {
  return (
    <>
      {insightNumber(result.value, percent)}
      {result.excluded > 0 && (
        <small className="insights-excluded">제외 {result.excluded}건</small>
      )}
    </>
  );
}
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
            <th scope="col">작업 주</th>
            <th scope="col">업무 기간</th>
            <th scope="col">목표일 상태</th>
            {sortLabel && <th scope="col">{sortLabel}</th>}
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
              <td>{metric.rangeWeeks.length}주</td>
              <td>{metric.duration}주</td>
              <td>{DEADLINE_LABELS[metric.deadlineState]}</td>
              {sortLabel && <td>{insightNumber(metric.sortValue || 0)}</td>}
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
}: {
  chart: InsightChart;
  result: ChartResult;
  ctx: InsightsContext;
  onDrill: (cell?: ChartCell) => void;
  onTask: (metric: TaskMetrics) => void;
}) {
  const percent = (index = 0) =>
    !!(chart.display?.percent && chart.display.percent !== "value") ||
    chart.values[index]?.kind === "delayRate";
  const cellFor = (row: string, series: string) =>
    result.cells.find((cell) => cell.row === row && cell.series === series)!;
  const accessible = (cell: ChartCell) =>
    `${result.rows.find((row) => row.key === cell.row)?.label} · ${result.series.find((series) => series.key === cell.series)?.label}: ${insightNumber(cell.values[0].value, percent())}`;
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
  if (chart.type === "table")
    return (
      <div className="insights-table-scroll">
        <table className="insights-table" aria-label={chart.title}>
          <thead>
            <tr>
              <th scope="col" rowSpan={2}>
                기준
              </th>
              {result.series.map((series) => (
                <th
                  scope="colgroup"
                  colSpan={chart.values.length}
                  key={series.key}
                >
                  {series.label}
                </th>
              ))}
            </tr>
            <tr>
              {result.series.flatMap((series) =>
                chart.values.map((definition, index) => (
                  <th scope="col" key={`${series.key}:${index}`}>
                    {insightValueLabel(definition, ctx)}
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                {result.series.flatMap((series) =>
                  chart.values.map((_, index) => {
                    const cell = cellFor(row.key, series.key);
                    return (
                      <td key={`${series.key}:${index}`}>
                        <button
                          className="insights-cell"
                          onClick={() =>
                            onDrill({ ...cell, valueIndex: index })
                          }
                          aria-label={`${row.label} · ${series.label} · ${insightValueLabel(chart.values[index], ctx)}`}
                        >
                          <ValueText
                            result={cell.values[index]}
                            percent={percent(index)}
                          />
                        </button>
                      </td>
                    );
                  }),
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">합계</th>
              {result.series.flatMap((series) =>
                chart.values.map((_, index) => (
                  <td key={`${series.key}:${index}`}>
                    <button
                      className="insights-cell"
                      onClick={() =>
                        onDrill({
                          row: "",
                          series: series.key,
                          values: result.seriesTotals[series.key],
                          taskIds: [],
                          total: true,
                          valueIndex: index,
                        })
                      }
                    >
                      <ValueText
                        result={result.seriesTotals[series.key][index]}
                        percent={percent(index)}
                      />
                    </button>
                  </td>
                )),
              )}
            </tr>
          </tfoot>
        </table>
      </div>
    );
  if (!result.rows.length || !result.series.length)
    return <p className="field-help">해당 업무가 없습니다.</p>;
  if (chart.type === "radar") {
    const center = 210,
      radius = 135,
      count = result.rows.length;
    const point = (index: number, distance: number) => [
      center + Math.sin((index * Math.PI * 2) / count) * distance,
      center - Math.cos((index * Math.PI * 2) / count) * distance,
    ];
    const max = Math.max(
      1,
      ...result.cells.map((cell) => cell.values[0].value),
    );
    const min = Math.min(
      0,
      ...result.cells.map((cell) => cell.values[0].value),
    );
    const distance = (value: number) => ((value - min) / (max - min)) * radius;
    return (
      <>
        <svg
          viewBox="0 0 420 420"
          className="insights-radar"
          aria-label={chart.title}
          role="group"
        >
          {[0.25, 0.5, 0.75, 1].map((scale) => (
            <g key={scale}>
              <polygon
                points={result.rows
                  .map((_, index) => point(index, radius * scale).join(","))
                  .join(" ")}
                fill="none"
                stroke="var(--line)"
              />
              <text
                x={center + 5}
                y={center - radius * scale + 11}
                fill="var(--muted)"
              >
                {insightNumber(min + (max - min) * scale, percent())}
              </text>
            </g>
          ))}
          {result.rows.map((row, index) => {
            const [x, y] = point(index, radius + 27);
            const [endX, endY] = point(index, radius);
            return (
              <g key={row.key}>
                <line
                  x1={center}
                  y1={center}
                  x2={endX}
                  y2={endY}
                  stroke="var(--line)"
                />
                <text x={x} y={y} textAnchor="middle" fill="var(--ink)">
                  {row.label}
                </text>
              </g>
            );
          })}
          {result.series.map((series, index) => (
            <g
              key={series.key}
              style={{ color: palette[index % palette.length] }}
            >
              <polygon
                points={result.rows
                  .map((row, axis) =>
                    point(
                      axis,
                      distance(cellFor(row.key, series.key).values[0].value),
                    ).join(","),
                  )
                  .join(" ")}
                fill="currentColor"
                fillOpacity=".08"
                stroke="currentColor"
                strokeWidth={2}
              />
              {result.rows.map((row, axis) => {
                const cell = cellFor(row.key, series.key);
                const [x, y] = point(axis, distance(cell.values[0].value));
                return (
                  <circle
                    key={row.key}
                    cx={x}
                    cy={y}
                    r={6}
                    fill="currentColor"
                    {...activate(cell)}
                  >
                    <title>{accessible(cell)}</title>
                  </circle>
                );
              })}
            </g>
          ))}
        </svg>
        <Legend result={result} />
        {result.totals[0]?.excluded > 0 && (
          <small>제외 {result.totals[0].excluded}건</small>
        )}
      </>
    );
  }
  const horizontal = chart.display?.orientation === "horizontal",
    stacked = chart.display?.mode === "stacked";
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
  const max = Math.max(
    1,
    ...(stacked ? positive : result.cells.map((cell) => cell.values[0].value)),
  );
  const min = Math.min(
    0,
    ...(stacked ? negative : result.cells.map((cell) => cell.values[0].value)),
  );
  const extent = max - min;
  const length = Math.max(440, result.rows.length * (horizontal ? 38 : 65));
  const width = horizontal ? 700 : length + 100,
    height = horizontal ? length + 40 : 360;
  const band = (horizontal ? height - 50 : width - 100) / result.rows.length;
  const unit = (horizontal ? width - 220 : height - 85) / extent;
  const zero = horizontal ? 150 - min * unit : height - 55 + min * unit;
  return (
    <>
      <div className="insights-chart-scroll">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="insights-bars"
          role="group"
          aria-label={chart.title}
        >
          <line
            x1={horizontal ? zero : 70}
            y1={horizontal ? 15 : zero}
            x2={horizontal ? zero : width - 25}
            y2={horizontal ? height - 25 : zero}
            stroke="var(--muted)"
          />
          <text
            x={horizontal ? width - 20 : 10}
            y={horizontal ? 14 : 20}
            fill="var(--muted)"
          >
            {insightNumber(max, percent())}
          </text>
          <text
            x={horizontal ? 145 : 10}
            y={horizontal ? 14 : height - 45}
            fill="var(--muted)"
          >
            {insightNumber(min, percent())}
          </text>
          {result.rows.map((row, rowIndex) => {
            let above = 0,
              below = 0;
            return (
              <g key={row.key}>
                <text
                  x={horizontal ? 140 : 70 + (rowIndex + 0.5) * band}
                  y={horizontal ? 25 + (rowIndex + 0.5) * band : height - 28}
                  textAnchor={horizontal ? "end" : "middle"}
                  fill="var(--ink)"
                >
                  {row.label}
                </text>
                {result.series.map((series, seriesIndex) => {
                  const cell = cellFor(row.key, series.key),
                    n = cell.values[0].value;
                  const offset = stacked ? (n >= 0 ? above : below) : 0;
                  if (n >= 0) above += n;
                  else below += n;
                  const thickness =
                    (band * 0.72) / (stacked ? 1 : result.series.length);
                  const cross =
                    (horizontal ? 20 : 70) +
                    rowIndex * band +
                    band * 0.14 +
                    (stacked ? 0 : seriesIndex * thickness);
                  const start = horizontal
                    ? zero + Math.min(offset, offset + n) * unit
                    : zero - Math.max(offset, offset + n) * unit;
                  return (
                    <rect
                      key={series.key}
                      x={horizontal ? start : cross}
                      y={horizontal ? cross : start}
                      width={
                        horizontal
                          ? Math.max(2, Math.abs(n) * unit)
                          : thickness - 1
                      }
                      height={
                        horizontal
                          ? thickness - 1
                          : Math.max(2, Math.abs(n) * unit)
                      }
                      fill={palette[seriesIndex % palette.length]}
                      {...activate(cell)}
                    >
                      <title>{accessible(cell)}</title>
                    </rect>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <Legend result={result} />
      {result.totals[0]?.excluded > 0 && (
        <small>제외 {result.totals[0].excluded}건</small>
      )}
    </>
  );
}
function Legend({ result }: { result: ChartResult }) {
  return (
    <ul className="insights-legend">
      {result.series.map((series, index) => (
        <li key={series.key}>
          <span style={{ backgroundColor: palette[index % palette.length] }} />
          {series.label}
        </li>
      ))}
    </ul>
  );
}
