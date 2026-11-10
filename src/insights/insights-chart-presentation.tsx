import { propertiesFor } from "../../shared/domain.js";
import { getTheme } from "../../shared/formatting/themes.js";
import { VALUE_LABELS } from "../../shared/insights/insights.js";
import { inkFor, normalizeHex } from "../ui/color";
import type {
  InsightChart,
  InsightDimension,
  InsightValue,
  InsightsContext,
} from "./insights-types";

export function insightFilterLabels(
  filter: NonNullable<InsightChart["filter"]>,
  ctx: InsightsContext,
) {
  return Object.entries(filter.propertyFilters || {})
    .filter(([, values]) => values.length)
    .map(([id, values]) => {
      const property = propertiesFor(ctx.settings, true).find(
        (entry) => entry.id === id,
      );
      const names = values.map((value) =>
        !value
          ? "미지정"
          : property?.kind === "member"
            ? ctx.users.find((entry) => entry.id === value)?.name || value
            : property?.kind === "option"
              ? property.values.find((entry) => entry.id === value)?.label ||
                value
              : value,
      );
      return `${property?.name || id} ${filter.propertyFilterModes?.[id] === "exclude" ? "제외" : "일치"}: ${names.join(", ")}`;
    });
}

const CATEGORY_COLORS = [
  "#426f9c",
  "#8a659e",
  "#a67b36",
  "#358478",
  "#b66d54",
  "#6d7e43",
  "#527f97",
  "#a86487",
  "#6670a3",
  "#89765d",
  "#48949b",
  "#7d788b",
];
const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex: string) =>
  rgb(hex)
    .map((n) => {
      const v = n / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: string, b: string) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) /
  (Math.min(luminance(a), luminance(b)) + 0.05);
export function chartInk(background: string) {
  const preferred = inkFor(background);
  return (
    [
      preferred,
      preferred === "#ffffff" ? "#243642" : "#ffffff",
      "#000000",
    ].find((color) => contrast(background, color) >= 4.5) || "#ffffff"
  );
}
export function heatColors(
  value: number,
  maximum: number,
  themeId: InsightsContext["settings"]["theme"],
) {
  if (!value || !maximum)
    return { backgroundColor: "#ffffff", color: "#5c7078" };
  const theme = getTheme(themeId),
    low = rgb(theme.surface),
    high = rgb(value < 0 ? "#72588b" : theme.strong);
  const amount = 0.12 + 0.88 * Math.min(1, Math.abs(value) / maximum);
  const backgroundColor =
    "#" +
    low
      .map((n, i) =>
        Math.round(n + (high[i] - n) * amount)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");
  return {
    backgroundColor,
    color: chartInk(backgroundColor),
  };
}
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
export function ValueText({
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
export function percentValue(chart: InsightChart, index = 0) {
  return (
    !!(chart.display?.percent && chart.display.percent !== "value") ||
    chart.values[index]?.kind === "delayRate"
  );
}
export function seriesColors(
  chart: InsightChart,
  ctx: InsightsContext,
  keys: string[],
) {
  const dimension: InsightDimension | undefined =
    chart.type === "pie"
      ? chart.dimensions.axis
      : chart.type === "table"
        ? chart.dimensions.column
        : chart.dimensions.series;
  const property =
    dimension?.kind === "property"
      ? propertiesFor(ctx.settings, true).find(
          (p) => p.id === dimension.propertyId,
        )
      : undefined;
  const vocabulary = property
    ? property.values.map((option) => ({
        key: option.id,
        color: option.dotColor || option.backgroundColor,
      }))
    : dimension?.kind === "owner"
      ? [...ctx.users]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((user) => ({ key: user.id, color: user.color }))
      : [];
  const assigned = new Map<string, string>(),
    used: string[] = [];
  const distinct = (color: string) =>
    used.every(
      (old) => Math.hypot(...rgb(color).map((v, i) => v - rgb(old)[i])) >= 60,
    );
  for (const [index, item] of vocabulary.entries()) {
    const actual = normalizeHex(item.color || "");
    // Resolve fallback against the complete vocabulary, never filtered row order.
    const rotated = CATEGORY_COLORS.map(
      (_, i) => CATEGORY_COLORS[(index + i) % CATEGORY_COLORS.length],
    );
    const color =
      actual && luminance(actual) < 0.72 && distinct(actual)
        ? actual
        : rotated.find(distinct) || rotated[0];
    assigned.set(item.key, color);
    used.push(color);
  }
  return new Map(
    keys.map((key) => {
      if (!dimension) return [key, getTheme(ctx.settings.theme).accent];
      const hash = [...key].reduce(
        (value, char) => (value * 31 + char.charCodeAt(0)) >>> 0,
        0,
      );
      return [
        key,
        assigned.get(key) ||
          (key ? CATEGORY_COLORS[hash % CATEGORY_COLORS.length] : "#7b8790"),
      ];
    }),
  );
}
export function chartTicks(minimum: number, maximum: number) {
  const range = maximum - minimum || 1;
  const magnitude = 10 ** Math.floor(Math.log10(range / 4));
  const fraction = range / 4 / magnitude;
  const step =
    (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) *
    magnitude;
  const min = Math.floor(minimum / step) * step,
    max =
      minimum === 0 && maximum === 0 ? step : Math.ceil(maximum / step) * step;
  const ticks = Array.from(
    { length: Math.round((max - min) / step) + 1 },
    (_, i) => Number((min + i * step).toPrecision(12)),
  );
  return { min, max, ticks };
}
export function Legend({
  series,
  colors,
}: {
  series: { key: string; label: string }[];
  colors: Map<string, string>;
}) {
  return (
    <ul className="insights-legend" aria-label="계열 범례">
      {series.map((entry) => (
        <li key={entry.key}>
          <span style={{ backgroundColor: colors.get(entry.key) }} />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}
