import { z } from "zod";
import { savedFilterSchema } from "../validation.js";

const propertyId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,59}$/);
export const insightDimensionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner") }).strict(),
  z.object({ kind: z.literal("property"), propertyId }).strict(),
  z
    .object({
      kind: z.literal("time"),
      unit: z.enum(["month", "quarter"]),
      basis: z.enum(["work", "start", "end"]),
    })
    .strict(),
  z.object({ kind: z.literal("deadlineState") }).strict(),
  z.object({ kind: z.literal("progressState") }).strict(),
  z.object({ kind: z.literal("durationBand") }).strict(),
]);
export const insightValueSchema = z.union([
  z
    .object({
      kind: z.enum([
        "count",
        "completed",
        "inProgress",
        "workWeeks",
        "avgDuration",
        "medianDuration",
        "maxDuration",
        "delayed",
        "delayRate",
        "avgDelay",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["numberSum", "numberAvg", "numberMax"]),
      propertyId,
    })
    .strict(),
]);
const displaySchema = z
  .object({
    percent: z.enum(["value", "total", "series"]).optional(),
    orientation: z.enum(["vertical", "horizontal"]).optional(),
    mode: z.enum(["grouped", "stacked"]).optional(),
  })
  .strict();

// The same strict contract is used by both settings repositories and the editor.
// Property existence is intentionally a presentation concern: archiving a
// property must not prevent unrelated team settings from being saved.
export const insightChartSchema = z
  .object({
    id: z.string().regex(/^c[0-9a-z]{6}$/),
    title: z.string().trim().min(1).max(80),
    type: z.enum(["number", "bar", "radar", "table", "top"]),
    dimensions: z
      .object({
        axis: insightDimensionSchema.optional(),
        series: insightDimensionSchema.optional(),
        row: insightDimensionSchema.optional(),
        column: insightDimensionSchema.optional(),
      })
      .strict(),
    values: z.array(insightValueSchema).min(1).max(4),
    display: displaySchema.optional(),
    filter: savedFilterSchema.optional(),
    sort: z
      .union([
        z.object({ kind: z.enum(["duration", "delayWeeks"]) }).strict(),
        z.object({ kind: z.literal("number"), propertyId }).strict(),
      ])
      .optional(),
    limit: z.number().int().min(5).max(50).optional(),
  })
  .strict()
  .superRefine((chart, ctx) => {
    const slots = {
      number: [],
      bar: ["axis", "series"],
      radar: ["axis", "series"],
      table: ["row", "column"],
      top: [],
    }[chart.type];
    const fail = (message) => ctx.addIssue({ code: "custom", message });
    if (Object.keys(chart.dimensions).some((slot) => !slots.includes(slot)))
      fail("차트 종류에 맞는 칸만 선택하세요.");
    if (chart.type !== "table" && chart.values.length !== 1)
      fail("이 차트는 값 하나만 선택합니다.");
    for (const slot of chart.type === "radar"
      ? ["axis", "series"]
      : chart.type === "bar"
        ? ["axis"]
        : chart.type === "table"
          ? ["row"]
          : [])
      if (!chart.dimensions[slot]) fail(`${slot} 기준을 선택하세요.`);
    if (chart.type === "top" && (!chart.sort || chart.limit === undefined))
      fail("정렬 값과 개수를 선택하세요.");
    if (chart.type !== "top" && (chart.sort || chart.limit !== undefined))
      fail("업무 목록에서만 정렬 값과 개수를 지정합니다.");
    if (
      chart.type !== "bar" &&
      (chart.display?.orientation || chart.display?.mode)
    )
      fail("막대 차트에서만 방향과 묶음·누적을 지정합니다.");
    if (
      chart.type === "top" &&
      chart.display?.percent &&
      chart.display.percent !== "value"
    )
      fail("업무 목록은 정렬 값을 그대로 표시합니다.");
  });

export const insightsSettingsSchema = z
  .object({
    workColors: z
      .array(
        z
          .object({
            color: z
              .string()
              .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
              .transform((color) => {
                const hex = color.slice(1).toLowerCase();
                return (
                  "#" +
                  (hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex)
                );
              }),
            name: z.string().trim().max(40).optional(),
          })
          .strict(),
      )
      .max(20)
      .refine(
        (colors) =>
          new Set(colors.map((entry) => entry.color)).size === colors.length,
        "업무 색상은 중복될 수 없습니다.",
      ),
    deadlinePropertyId: propertyId.nullable().optional(),
    charts: z
      .array(insightChartSchema)
      .max(30)
      .refine(
        (charts) =>
          new Set(charts.map((chart) => chart.id)).size === charts.length,
        "차트 ID는 중복될 수 없습니다.",
      ),
  })
  .strict();
