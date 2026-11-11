import { useMemo, useState } from "react";
import { propertiesFor } from "../../shared/domain.js";
import {
  aggregate,
  numericProperties,
} from "../../shared/insights/insights.js";
import { Button } from "../ui/Button";
import Select from "../ui/Select";
import InsightsChart from "./InsightsChart";
import { comparisonProperty } from "./insights-chart-templates";
import type { Task } from "../types";
import type {
  ChartCell,
  InsightChart,
  InsightValue,
  InsightsContext,
  TaskMetrics,
} from "./insights-types";

export default function InsightsComparison({
  tasks,
  ctx,
  onDrill,
  onTask,
}: {
  tasks: Task[];
  ctx: InsightsContext;
  onDrill: (chart: InsightChart, cell?: ChartCell) => void;
  onTask: (metric: TaskMetrics) => void;
}) {
  const [propertyId, setPropertyId] = useState(
    () => comparisonProperty(ctx.settings)?.id || "",
  );
  const [measure, setMeasure] = useState('{"kind":"count"}');
  const [presentation, setPresentation] = useState<"matrix" | "stacked">(
    "matrix",
  );
  const properties = propertiesFor(ctx.settings).filter(
    (property) => property.kind === "option",
  );
  const property =
    properties.find((entry) => entry.id === propertyId) ||
    comparisonProperty(ctx.settings);
  const numeric = useMemo(
    () => numericProperties(tasks, ctx.settings),
    [tasks, ctx.settings],
  );
  const choices: { label: string; value: InsightValue }[] = [
    { label: "업무 수", value: { kind: "count" } },
    { label: "작업 주 합", value: { kind: "workWeeks" } },
    ...numeric.map((entry) => ({
      label: `${entry.name} · 숫자 열 합계`,
      value: { kind: "numberSum" as const, propertyId: entry.id },
    })),
  ];
  const currentMeasure =
    choices.find((choice) => JSON.stringify(choice.value) === measure)?.value ||
    choices[0].value;
  const chart = useMemo<InsightChart>(
    () => ({
      id: "ccompar",
      title: "책임자별 업무 비교",
      type: "table",
      dimensions: {
        row: { kind: "owner" },
        column: { kind: "property", propertyId: property?.id || "" },
      },
      values: [currentMeasure],
      display: { percent: "value" },
    }),
    [property?.id, JSON.stringify(currentMeasure)],
  );
  const result = useMemo(
    () => aggregate(tasks, chart, ctx),
    [tasks, chart, ctx],
  );
  if (!property) return null;
  return (
    <section
      className="insights-card insights-comparison"
      aria-label="책임자별 업무 비교"
    >
      <div className="insights-card-heading">
        <h2>책임자별 업무 비교</h2>
        <div className="insights-comparison-controls">
          <label>
            속성
            <Select
              aria-label="비교 속성"
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
          <label>
            값
            <Select
              aria-label="비교 값"
              value={JSON.stringify(currentMeasure)}
              onChange={(event) => setMeasure(event.target.value)}
            >
              {choices.map((entry) => (
                <option
                  key={JSON.stringify(entry.value)}
                  value={JSON.stringify(entry.value)}
                >
                  {entry.label}
                </option>
              ))}
            </Select>
          </label>
          <div
            className="insights-view-switch"
            role="group"
            aria-label="비교 표시"
          >
            <Button
              active={presentation === "matrix"}
              aria-pressed={presentation === "matrix"}
              onClick={() => setPresentation("matrix")}
            >
              매트릭스
            </Button>
            <Button
              active={presentation === "stacked"}
              aria-pressed={presentation === "stacked"}
              onClick={() => setPresentation("stacked")}
            >
              업무 구성
            </Button>
          </div>
        </div>
      </div>
      <InsightsChart
        chart={chart}
        result={result}
        ctx={ctx}
        presentation={presentation}
        onDrill={(cell) => onDrill(chart, cell)}
        onTask={onTask}
      />
    </section>
  );
}
