import type {
  ChartCell,
  ChartResult,
  InsightChart,
  InsightsContext,
} from "./insights-types";
import {
  heatColors,
  insightNumber,
  insightValueLabel,
  percentValue,
  seriesColors,
  ValueText,
} from "./insights-chart-presentation";

export default function InsightsMatrix({
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
  const matrix = !!chart.dimensions.column,
    multiple = chart.values.length > 1;
  const cells = new Map(
    result.cells.map((cell) => [JSON.stringify([cell.row, cell.series]), cell]),
  );
  const colors = seriesColors(
    chart,
    ctx,
    result.series.map((series) => series.key),
  );
  const maxima = chart.values.map((_, index) =>
    Math.max(
      0,
      ...result.cells.map((cell) => Math.abs(cell.values[index].value)),
    ),
  );
  const negative = chart.values.map((_, index) =>
    result.cells.some((cell) => cell.values[index].value < 0),
  );
  const rawTotals = chart.display?.percent === "series";
  const totalPercent = (index: number) =>
    (!rawTotals && percentValue(chart, index)) ||
    chart.values[index].kind === "delayRate";
  const grand = result.totals.map((total) => ({
    ...total,
    value:
      chart.display?.percent === "total" ? (total.raw ? 100 : 0) : total.raw,
  }));
  const total = (
    scope: "row" | "series" | "grand",
    row = "",
    series = "",
    index = 0,
  ) => {
    const values =
      scope === "row"
        ? result.rowTotals[row]
        : scope === "series"
          ? result.seriesTotals[series]
          : grand;
    onDrill({ row, series, values, taskIds: [], scope, valueIndex: index });
  };
  return (
    <>
      {matrix && (
        <div className="insights-matrix-scales" aria-label="농도 범례">
          {chart.values.map((definition, index) => (
            <div key={index}>
              <span>{insightValueLabel(definition, ctx)}</span>
              <span className="insights-heat-scale">
                <span>
                  {negative[index]
                    ? insightNumber(-maxima[index], percentValue(chart, index))
                    : "0"}
                </span>
                {(negative[index]
                  ? [-1, -0.5, 0, 0.5, 1]
                  : [0, 0.25, 0.5, 0.75, 1]
                ).map((amount) => (
                  <i
                    key={amount}
                    style={heatColors(
                      amount * maxima[index],
                      maxima[index],
                      ctx.settings.theme,
                    )}
                  />
                ))}
                <span>
                  {insightNumber(maxima[index], percentValue(chart, index))}
                </span>
              </span>
              {negative[index] && <small>절댓값 기준 · 음수는 보라색</small>}
            </div>
          ))}
        </div>
      )}
      <div
        className={`insights-table-scroll${matrix ? " insights-matrix-scroll" : ""}`}
      >
        <table
          className={`insights-table${matrix ? " insights-matrix" : ""}`}
          aria-label={chart.title}
        >
          <thead>
            <tr>
              <th scope="col" rowSpan={matrix && multiple ? 2 : 1}>
                {chart.dimensions.row?.kind === "owner" ? "책임자" : "기준"}
              </th>
              {matrix ? (
                <>
                  {result.series.map((series) => (
                    <th
                      scope={multiple ? "colgroup" : "col"}
                      className={
                        multiple ? undefined : "insights-number-column"
                      }
                      colSpan={chart.values.length}
                      key={series.key}
                    >
                      <span className="insights-series-heading">
                        <i
                          style={{ backgroundColor: colors.get(series.key) }}
                        />
                        {series.label}
                      </span>
                    </th>
                  ))}
                  <th
                    scope={multiple ? "colgroup" : "col"}
                    className={`insights-matrix-total${multiple ? "" : " insights-number-column"}`}
                    colSpan={chart.values.length}
                  >
                    행 합계{rawTotals ? " (원값)" : ""}
                  </th>
                </>
              ) : (
                chart.values.map((definition, index) => (
                  <th
                    scope="col"
                    key={index}
                    className="insights-number-column"
                  >
                    {insightValueLabel(definition, ctx)}
                  </th>
                ))
              )}
            </tr>
            {matrix && multiple && (
              <tr>
                {[...result.series, { key: "total", label: "합계" }].flatMap(
                  (series) =>
                    chart.values.map((definition, index) => (
                      <th
                        scope="col"
                        className={`insights-number-column${series.key === "total" ? " insights-matrix-total" : ""}`}
                        key={`${series.key}:${index}`}
                      >
                        {insightValueLabel(definition, ctx)}
                      </th>
                    )),
                )}
              </tr>
            )}
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                {result.series.flatMap((series) =>
                  chart.values.map((definition, index) => {
                    const cell = cells.get(
                        JSON.stringify([row.key, series.key]),
                      )!,
                      entry = cell.values[index];
                    return (
                      <td
                        key={`${series.key}:${index}`}
                        className={`insights-number-column${matrix ? " insights-heat-cell" : ""}`}
                        style={
                          matrix
                            ? heatColors(
                                entry.value,
                                maxima[index],
                                ctx.settings.theme,
                              )
                            : undefined
                        }
                      >
                        <button
                          className="insights-cell"
                          aria-label={`${row.label} · ${series.label} · ${insightValueLabel(definition, ctx)}: ${insightNumber(entry.value, percentValue(chart, index))}`}
                          onClick={() =>
                            onDrill({ ...cell, valueIndex: index })
                          }
                        >
                          <ValueText
                            result={entry}
                            percent={percentValue(chart, index)}
                          />
                        </button>
                      </td>
                    );
                  }),
                )}
                {matrix &&
                  chart.values.map((definition, index) => (
                    <td
                      className="insights-matrix-total insights-number-column"
                      key={index}
                    >
                      <button
                        className="insights-cell"
                        onClick={() => total("row", row.key, "", index)}
                        aria-label={`${row.label} · 행 합계 · ${insightValueLabel(definition, ctx)}: ${insightNumber(result.rowTotals[row.key][index].value, totalPercent(index))}`}
                      >
                        <ValueText
                          result={result.rowTotals[row.key][index]}
                          percent={totalPercent(index)}
                        />
                      </button>
                    </td>
                  ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">합계</th>
              {result.series.flatMap((series) =>
                chart.values.map((definition, index) => (
                  <td
                    key={`${series.key}:${index}`}
                    className="insights-number-column"
                  >
                    <button
                      className="insights-cell"
                      onClick={() => total("series", "", series.key, index)}
                      aria-label={`${series.label} · 열 합계 · ${insightValueLabel(definition, ctx)}: ${insightNumber(result.seriesTotals[series.key][index].value, percentValue(chart, index))}`}
                    >
                      <ValueText
                        result={result.seriesTotals[series.key][index]}
                        percent={percentValue(chart, index)}
                      />
                    </button>
                  </td>
                )),
              )}
              {matrix &&
                chart.values.map((definition, index) => (
                  <td
                    className="insights-matrix-total insights-number-column"
                    key={index}
                  >
                    <button
                      className="insights-cell"
                      onClick={() => total("grand", "", "", index)}
                      aria-label={`전체 합계 · ${insightValueLabel(definition, ctx)}: ${insightNumber(grand[index].value, totalPercent(index))}`}
                    >
                      <ValueText
                        result={grand[index]}
                        percent={totalPercent(index)}
                      />
                    </button>
                  </td>
                ))}
            </tr>
          </tfoot>
        </table>
      </div>
      {rawTotals && (
        <p className="insights-chart-note">
          계열 안 %는 각 열의 전체 값 기준입니다.
          {matrix ? " 행·전체 합계는 원값입니다." : ""}
        </p>
      )}
      {chart.display?.percent === "total" && (
        <p className="insights-chart-note">
          전체 대비 %는 중복을 제거한 전체 집계 값 기준입니다.
        </p>
      )}
      {matrix &&
        chart.values.some((definition) =>
          [
            "avgDuration",
            "medianDuration",
            "maxDuration",
            "delayRate",
            "avgDelay",
            "numberAvg",
            "numberMax",
          ].includes(definition.kind),
        ) && (
          <p className="insights-chart-note">
            평균·중앙값·최댓값·비율의 합계는 해당 업무에서 다시 계산합니다.
          </p>
        )}
      {!result.rows.length && (
        <p className="field-help">해당 업무가 없습니다.</p>
      )}
    </>
  );
}
