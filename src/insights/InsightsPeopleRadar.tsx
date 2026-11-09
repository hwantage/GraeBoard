import { useEffect, useMemo, useState } from "react";
import { isAssignable, propertiesFor } from "../../shared/domain.js";
import { aggregate } from "../../shared/insights/insights.js";
import PropertyFilter from "../sheet/PropertyFilter";
import Select from "../ui/Select";
import InsightsChart from "./InsightsChart";
import {
  comparisonProperty,
  peopleRadarDefinition,
  type rankedOwners,
} from "./insights-chart-templates";
import type { FilterMode, Task } from "../types";
import type {
  ChartCell,
  ChartResult,
  InsightChart,
  InsightsContext,
  TaskMetrics,
} from "./insights-types";

export default function InsightsPeopleRadar({
  tasks,
  ctx,
  teamId,
  owners,
  onDrill,
  onTask,
}: {
  tasks: Task[];
  ctx: InsightsContext;
  teamId: string;
  owners: ReturnType<typeof rankedOwners>;
  onDrill: (chart: InsightChart, cell?: ChartCell) => void;
  onTask: (metric: TaskMetrics) => void;
}) {
  const [propertyId, setPropertyId] = useState(
    () => comparisonProperty(ctx.settings)?.id || "",
  );
  const [selection, setSelection] = useState<{
    ids: string[];
    mode: FilterMode;
  } | null>(null);
  useEffect(() => {
    if (selection === null && owners.length)
      setSelection({
        ids: owners.slice(0, 3).map((owner) => owner.id),
        mode: "include",
      });
  }, [selection, owners]);
  const selected = selection || {
    ids: owners.slice(0, 3).map((owner) => owner.id),
    mode: "include" as const,
  };
  const properties = propertiesFor(ctx.settings).filter(
    (property) => property.kind === "option",
  );
  const property =
    properties.find((entry) => entry.id === propertyId) ||
    comparisonProperty(ctx.settings);
  const ownerProperty = propertiesFor(ctx.settings, true).find(
    (entry) => entry.id === "owner",
  )!;
  const people = useMemo(() => {
    const labels = new Map(owners.map((owner) => [owner.id, owner.name]));
    for (const user of ctx.users)
      if (
        isAssignable(user, teamId) ||
        labels.has(user.id) ||
        selected.ids.includes(user.id)
      )
        labels.set(user.id, user.name);
    for (const id of selected.ids)
      if (!labels.has(id)) labels.set(id, id || "미지정");
    return [...labels].filter(([id]) => id).map(([id, name]) => ({ id, name }));
  }, [owners, ctx.users, teamId, JSON.stringify(selected.ids)]);
  const chosen = selected.ids.length
    ? selected.mode === "include"
      ? selected.ids
      : owners
          .filter((owner) => !selected.ids.includes(owner.id))
          .map((owner) => owner.id)
    : owners.map((owner) => owner.id);
  const selectionKey = JSON.stringify({ ...selected, chosen });
  const report = useMemo(() => {
    if (!property) return null;
    const chart: InsightChart = {
      id: "cradar0",
      ...peopleRadarDefinition(property.id),
      filter: {
        propertyFilters: { owner: selected.ids },
        propertyFilterModes: { owner: selected.mode },
      },
    };
    const radar = aggregate(tasks, chart, ctx) as ChartResult;
    const fallback =
      radar.rows.length < 3 || radar.rows.length > 12
        ? "분류 축이 3~12개가 아니어서 표로 비교합니다."
        : chosen.length > 8
          ? "책임자가 8명을 넘어 표로 비교합니다. 책임자 선택에서 범위를 좁힐 수 있습니다."
          : "";
    const definition: InsightChart = fallback
      ? {
          ...chart,
          type: "table",
          dimensions: {
            row: chart.dimensions.axis,
            column: chart.dimensions.series,
          },
        }
      : chart;
    const result = fallback
      ? (aggregate(tasks, definition, ctx) as ChartResult)
      : radar;
    const series = chosen.map((id) => ({
      key: id,
      label:
        people.find((user) => user.id === id)?.name ||
        owners.find((owner) => owner.id === id)?.name ||
        id ||
        "미지정",
    }));
    const indexed = new Map(
      result.cells.map((cell) => [
        JSON.stringify([cell.row, cell.series]),
        cell,
      ]),
    );
    const zero = () => [{ raw: 0, value: 0, excluded: 0 }];
    // Explicitly selected people with no work keep a visible zero series. Axes
    // always come from real option definitions/observations, never filler axes.
    const completed: ChartResult = {
      ...result,
      rows: radar.rows,
      series,
      cells: radar.rows.flatMap((row) =>
        series.map(
          (entry) =>
            indexed.get(JSON.stringify([row.key, entry.key])) || {
              row: row.key,
              series: entry.key,
              taskIds: [],
              values: zero(),
            },
        ),
      ),
      rowTotals: Object.fromEntries(
        radar.rows.map((row) => [row.key, result.rowTotals[row.key] || zero()]),
      ),
      seriesTotals: Object.fromEntries(
        series.map((entry) => [
          entry.key,
          result.seriesTotals[entry.key] || zero(),
        ]),
      ),
    };
    return { chart: definition, result: completed, fallback };
  }, [tasks, ctx, property?.id, selectionKey, people, owners]);
  return (
    <article className="insights-card insights-analysis-card insights-people-radar">
      <div className="insights-card-heading">
        <h2>책임자별 업무 비중</h2>
        {property && (
          <label className="insights-analysis-property">
            속성{" "}
            <Select
              aria-label="비중 비교 속성"
              value={property.id}
              onChange={(event) => setPropertyId(event.target.value)}
            >
              {properties.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </label>
        )}
      </div>
      <details className="insights-people-selection">
        <summary>책임자 선택 · {chosen.length}명</summary>
        <PropertyFilter
          property={ownerProperty}
          tasks={tasks}
          users={people}
          selected={selected.ids}
          mode={selected.mode}
          onChange={(ids) => setSelection({ ...selected, ids })}
          onModeChange={(mode) => setSelection({ ...selected, mode })}
        />
      </details>
      <p className="insights-chart-unit">
        선택한 책임자 {chosen.length}명 · 범위 내 책임자 {owners.length}명<br />
        각 책임자의 범위·필터 내 업무 수 = 100% (업무 없음: 0%)
      </p>
      {!property || !report ? (
        <p className="field-help">비교할 선택형 속성이 없습니다.</p>
      ) : !report.result.metrics.length ? (
        <p className="field-help">선택 범위에 집계할 업무가 없습니다.</p>
      ) : (
        <>
          {report.fallback && <p className="field-help">{report.fallback}</p>}
          <InsightsChart
            chart={report.chart}
            result={report.result}
            ctx={ctx}
            onDrill={(cell) => onDrill(report.chart, cell)}
            onTask={onTask}
          />
        </>
      )}
    </article>
  );
}
