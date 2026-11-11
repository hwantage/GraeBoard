import { useState } from "react";
import { createPortal } from "react-dom";
import type {
  ChartResult,
  InsightChart,
  InsightsContext,
} from "./insights-types";
import {
  insightNumber,
  insightValueLabel,
  percentValue,
  ValueText,
} from "./insights-chart-presentation";

// Printable companion to SVGs: full labels and every plotted value, including
// zeros. It consumes the SAME aggregate, including the selected radar owners.
export default function InsightsChartData({
  chart,
  result,
  ctx,
}: {
  chart: InsightChart;
  result: ChartResult;
  ctx: InsightsContext;
}) {
  const [template, setTemplate] = useState<HTMLTemplateElement | null>(null);
  const cells = new Map(
    result.cells.map((cell) => [JSON.stringify([cell.row, cell.series]), cell]),
  );
  return (
    <>
      <template ref={setTemplate} className="insights-print-data" />
      {template &&
        createPortal(
          <table className="insights-table">
            <caption>{chart.title} · 그래프 수치</caption>
            <thead>
              <tr>
                <th scope="col">기준</th>
                <th scope="col">계열</th>
                {chart.values.map((definition, index) => (
                  <th
                    scope="col"
                    className="insights-number-column"
                    key={index}
                  >
                    {insightValueLabel(definition, ctx)}
                    {percentValue(chart, index) ? " (%)" : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.flatMap((row) =>
                result.series.map((series) => (
                  <tr key={JSON.stringify([row.key, series.key])}>
                    <th scope="row">{row.label}</th>
                    <td>{series.label}</td>
                    {cells
                      .get(JSON.stringify([row.key, series.key]))!
                      .values.map((entry, index) => (
                        <td className="insights-number-column" key={index}>
                          <ValueText
                            result={entry}
                            percent={percentValue(chart, index)}
                          />
                        </td>
                      ))}
                  </tr>
                )),
              )}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={2}>
                  전체 집계 (원값)
                </th>
                {result.totals.map((entry, index) => (
                  <td className="insights-number-column" key={index}>
                    {insightNumber(
                      entry.raw,
                      chart.values[index].kind === "delayRate",
                    )}
                    {!!entry.excluded && (
                      <small> 제외 {entry.excluded}건</small>
                    )}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>,
          template.content,
        )}
    </>
  );
}
