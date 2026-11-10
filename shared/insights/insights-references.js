import { propertiesFor } from "../domain.js";

export function summaryPropertyId(settings) {
  return settings.insights?.summaryPropertyId === undefined
    ? "status"
    : settings.insights.summaryPropertyId;
}

export function summaryPropertyWarning(settings) {
  const id = summaryPropertyId(settings);
  if (!id) return "";
  const property = propertiesFor(settings, true).find((p) => p.id === id);
  if (!property)
    return (
      "통계 속성이 없습니다: " + id + " · 인사이트 설정에서 다시 선택하세요."
    );
  if (property.kind !== "option")
    return (
      "통계 속성이 선택형이 아닙니다: " +
      property.name +
      " · 인사이트 설정에서 다시 선택하세요."
    );
  return property.archived ? "보관된 통계 속성: " + property.name : "";
}

export function chartPropertyReferences(chart) {
  return [
    ...Object.values(chart.dimensions)
      .filter((ref) => ref.propertyId)
      .map((ref) => ({ id: ref.propertyId, kinds: ["option"] })),
    ...[...chart.values, chart.sort]
      .filter((ref) => ref?.propertyId)
      .map((ref) => ({ id: ref.propertyId, kinds: ["text", "number"] })),
    ...Object.entries(chart.filter?.propertyFilters || {})
      .filter(([, values]) => values.length)
      .map(([id]) => ({ id, kinds: null })),
  ];
}

// Used by the existing archive confirmation; references and cell data stay intact.
export function insightPropertyUsages(settings, id) {
  const usages = [];
  if (summaryPropertyId(settings) === id) usages.push("상단 통계");
  const deadline =
    settings.insights?.deadlinePropertyId === undefined
      ? "deadline"
      : settings.insights.deadlinePropertyId;
  if (deadline === id) usages.push("목표일 통계");
  for (const chart of settings.insights?.charts || [])
    if (chartPropertyReferences(chart).some((ref) => ref.id === id))
      usages.push("차트: " + chart.title);
  return usages;
}
