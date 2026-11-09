import { propertiesFor } from "../../shared/domain.js";
import type { Settings } from "../types";
import type { ChartResult, InsightChart } from "./insights-types";

export const monthlyWorkDefinition: Omit<InsightChart, "id"> = {
  title: "월별 작업량",
  type: "bar",
  dimensions: { axis: { kind: "time", unit: "month", basis: "work" } },
  values: [{ kind: "workWeeks" }],
  display: { percent: "value", orientation: "vertical", mode: "grouped" },
};
export const ownerCountDefinition: Omit<InsightChart, "id"> = {
  title: "책임자",
  type: "table",
  dimensions: { row: { kind: "owner" } },
  values: [{ kind: "count" }],
};
export function rankedOwners(result: ChartResult) {
  return result.rows
    .map((row) => ({
      id: row.key,
      name: row.label,
      count: result.rowTotals[row.key][0].raw,
    }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}
export function peopleRadarDefinition(
  propertyId: string,
  owners: string[] = [],
): Omit<InsightChart, "id"> {
  return {
    title: "책임자별 업무 비중",
    type: "radar",
    dimensions: {
      axis: { kind: "property", propertyId },
      series: { kind: "owner" },
    },
    values: [{ kind: "count" }],
    display: { percent: "series" },
    ...(owners.length
      ? {
          filter: {
            propertyFilters: { owner: owners },
            propertyFilterModes: { owner: "include" },
          },
        }
      : {}),
  };
}

export function comparisonProperty(settings: Settings) {
  const options = propertiesFor(settings).filter((p) => p.kind === "option");
  return (
    options.find((p) => p.name === "분류") ||
    options.find((p) => p.id === "category") ||
    options.find((p) => p.id !== "status") ||
    options[0]
  );
}
export function chartTemplates(
  settings: Settings,
  owners: string[] = [],
): { label: string; chart: Omit<InsightChart, "id"> }[] {
  const property = comparisonProperty(settings);
  return [
    ...(property
      ? [
          {
            label: "책임자×속성 매트릭스",
            chart: {
              title: `${property.name}별 책임자 비교`,
              type: "table" as const,
              dimensions: {
                row: { kind: "owner" as const },
                column: { kind: "property" as const, propertyId: property.id },
              },
              values: [{ kind: "count" as const }],
              display: { percent: "value" as const },
            },
          },
          {
            label: "책임자별 업무 구성",
            chart: {
              title: `${property.name}별 업무 구성`,
              type: "bar" as const,
              dimensions: {
                axis: { kind: "owner" as const },
                series: { kind: "property" as const, propertyId: property.id },
              },
              values: [{ kind: "count" as const }],
              display: {
                percent: "value" as const,
                orientation: "horizontal" as const,
                mode: "stacked" as const,
              },
            },
          },
          {
            label: "책임자별 업무 비중",
            chart: peopleRadarDefinition(property.id, owners),
          },
        ]
      : []),
    {
      label: "월별 작업량",
      chart: monthlyWorkDefinition,
    },
  ];
}
