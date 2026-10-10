import { z } from "zod";
import { BORDER_STYLES } from "../shared/borders.js";
import {
  FIELDS,
  FONTS,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  MAX_STYLE_CELLS,
  FIELD_KEYS,
  mondayOf,
  propertiesFor,
  propertyValue,
  PROPERTY_DISPLAYS,
  PROPERTY_KINDS,
  CORE_PROPERTY_KEYS,
} from "../shared/domain.js";
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export function requireThat(condition, status, message, details) {
  if (!condition) throw new HttpError(status, message, details);
}
export const yearSchema = z.coerce.number().int().min(2000).max(2100);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      /^\d{4}-\d{2}-\d{2}$/.test(s) &&
      !Number.isNaN(Date.parse(s)) &&
      new Date(s + "T12:00:00Z").toISOString().startsWith(s),
    "유효한 날짜가 아닙니다.",
  );
export const borderSchema = z
  .object({
    style: z.enum(BORDER_STYLES),
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  })
  .strict();
export const weekHeaderSchema = z
  .object({
    color: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
    backgroundColor: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
  })
  .strict();
export const styleSchema = z
  .object({
    borderTop: borderSchema.nullable().optional(),
    borderRight: borderSchema.nullable().optional(),
    borderBottom: borderSchema.nullable().optional(),
    borderLeft: borderSchema.nullable().optional(),
    color: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
    backgroundColor: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
    fontFamily: z.enum(FONTS).optional(),
    fontSize: z.number().int().min(MIN_FONT_SIZE).max(MAX_FONT_SIZE).optional(),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    wrap: z.boolean().optional(),
    textMode: z.enum(["overflow", "wrap", "clip"]).optional(),
  })
  .strict();
export const changeSchema = z
  .object({
    taskId: z.string().uuid(),
    key: z.string().max(80),
    expectedVersion: z.number().int().nonnegative(),
    value: z
      .union([
        z.string().max(10000),
        z.number().finite(),
        z.array(z.string().uuid()).max(50),
      ])
      .optional(),
    style: styleSchema.optional(),
  })
  .strict();
export const batchSchema = z.object({
  operationId: z.string().uuid(),
  changes: z
    .array(changeSchema)
    .min(1)
    .max(MAX_STYLE_CELLS)
    .refine(
      (changes) =>
        changes.length <= 2000 ||
        changes.every((c) => c.value === undefined && c.style !== undefined),
      "값 변경은 한 번에 2,000셀까지 가능합니다.",
    ),
});
export const viewSchema = z
  .object({
    year: yearSchema,
    people: z.array(z.string().max(50)).max(100),
    personRole: z.enum(["owner", "supporter", "either"]),
    status: z.string().max(60),
    category: z.string().max(60),
    propertyFilters: z
      .record(z.string().max(80), z.array(z.string().max(10000)).max(101))
      .refine((v) => Object.keys(v).length <= 50)
      .optional(),
    propertyFilterModes: z
      .record(z.string().max(80), z.enum(["include", "exclude"]))
      .refine((v) => Object.keys(v).length <= 50)
      .optional(),
    search: z.string().max(300),
    fromMonth: z.number().int().min(1).max(12),
    toMonth: z.number().int().min(1).max(12),
    fromWeek: z.union([z.literal(""), dateSchema]).default(""),
    toWeek: z.union([z.literal(""), dateSchema]).default(""),
    hiddenRows: z.array(z.string().uuid()).max(20000),
    hiddenWeeks: z.array(dateSchema).max(60),
    collapsedMonths: z.array(z.number().int().min(1).max(12)).max(12),
    frozenColumns: z.number().int().min(0).max(60).default(0),
    visibleFields: z.array(z.string().max(80)).min(1).max(60),
    widths: z.record(z.string().max(80), z.number().min(40).max(900)),
    compactWeekColumns: z.boolean().optional(),
    rowHeights: z.record(z.string().uuid(), z.number().min(26).max(500)),
    sort: z
      .enum(["position", "deadline", "title", "category"])
      .default("position"),
    groupBy: z.string().max(80).optional(),
    sortKey: z.string().max(80).optional(),
    sortDirection: z.enum(["asc", "desc", "default"]).optional(),
    knownProperties: z.array(z.string().max(80)).max(60).optional(),
    columnVisibility: z.record(z.string().max(80), z.boolean()).optional(),
    density: z.enum(["comfortable", "compact", "dense"]),
  })
  .strict()
  .refine(
    (v) =>
      v.fromMonth <= v.toMonth &&
      (!v.fromWeek || !v.toWeek || v.fromWeek <= v.toWeek),
    "기간 범위를 확인하세요.",
  );
export function validCellKey(key, settings) {
  return (
    FIELD_KEYS.includes(key) ||
    propertiesFor(settings).some((p) => p.id === key) ||
    (dateSchema.safeParse(key).success && mondayOf(key) === key)
  );
}
export function validateCellValue(
  db,
  teamId,
  key,
  value,
  settings,
  previousValue,
) {
  requireThat(validCellKey(key, settings), 400, "지원하지 않는 셀입니다.");
  if (value === undefined) return;
  const property = propertiesFor(settings, true).find((p) => p.id === key);
  const type =
    property?.kind ||
    (key === "supporters"
      ? "member"
      : FIELDS.find((f) => f.key === key)?.type) ||
    "text";
  if (type === "member") {
    // Preserve existing assignments, but never allow a former member to be
    // assigned again after their value has been removed from this cell.
    const previous = new Set(
      Array.isArray(previousValue)
        ? previousValue
        : previousValue
          ? [previousValue]
          : [],
    );
    if (property?.multiple ?? key === "supporters") {
      requireThat(Array.isArray(value), 400, "팀원은 목록이어야 합니다.");
      requireThat(
        value.length <= 50 && new Set(value).size === value.length,
        400,
        "팀원 목록을 확인하세요.",
      );
      for (const v of value) if (!previous.has(v)) member(db, teamId, v);
    } else {
      requireThat(typeof value === "string", 400, "팀원을 확인하세요.");
      if (value && !previous.has(value)) member(db, teamId, value);
    }
    return;
  }
  // Preserve numeric progress from older files and undo history.
  if (
    key === "progress" &&
    type === "text" &&
    typeof value === "number" &&
    Number.isFinite(value)
  )
    return;
  if (type === "number") {
    requireThat(
      value === "" ||
        (typeof value === "number" &&
          Number.isFinite(value) &&
          (!["score", "current"].includes(key) || value >= 0)),
      400,
      "유효한 숫자를 입력하세요.",
    );
    return;
  }
  requireThat(typeof value === "string", 400, "텍스트를 입력하세요.");
  requireThat(
    value.length <= 10000,
    400,
    "셀은 10,000자까지 입력할 수 있습니다.",
  );
  if (type === "date" && value) dateSchema.parse(value);
  if (type === "option" && value)
    requireThat(
      property.values.some(
        (v) => !v.archived && propertyValue(property, v) === value,
      ),
      400,
      "속성에 없는 선택값입니다.",
    );
}
function member(db, teamId, userId) {
  requireThat(
    !!db
      .prepare("SELECT 1 FROM memberships WHERE team_id=? AND user_id=?")
      .get(teamId, userId),
    400,
    "이 팀에 속한 담당자를 선택하세요.",
  );
}

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const optionSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
    label: z.string().trim().min(1).max(60),
    backgroundColor: hex.default("#edf6f4"),
    dotColor: hex.default("#177b70"),
    emoji: z.string().max(24).default("📌"),
    archived: z.boolean().optional(),
  })
  .strict();
export const propertiesSchema = z
  .array(
    z
      .object({
        id: z
          .string()
          .refine(
            (id) => FIELD_KEYS.includes(id) || /^prop_[0-9a-f-]{36}$/.test(id),
          ),
        name: z.string().trim().min(1).max(50),
        kind: z.enum(PROPERTY_KINDS).default("option"),
        display: z.enum([...PROPERTY_DISPLAYS, "avatar"]),
        multiple: z.boolean().optional(),
        visible: z.boolean().optional(),
        placement: z.enum(["beforeWeeks", "afterWeeks"]).optional(),
        values: z
          .array(optionSchema)
          .max(100)
          .refine(
            (a) =>
              new Set(a.map((v) => v.id)).size === a.length &&
              new Set(a.filter((v) => !v.archived).map((v) => v.label)).size ===
                a.filter((v) => !v.archived).length,
            "속성 값의 이름과 ID는 중복될 수 없습니다.",
          ),
        archived: z.boolean().optional(),
      })
      .strict(),
  )
  .min(3)
  .max(50)
  .refine(
    (a) =>
      new Set(a.map((p) => p.id)).size === a.length &&
      new Set(a.filter((p) => !p.archived).map((p) => p.name)).size ===
        a.filter((p) => !p.archived).length &&
      a.every(
        (p) => p.kind !== "option" || PROPERTY_DISPLAYS.includes(p.display),
      ) &&
      a.some(
        (p) =>
          p.id === "title" &&
          p.kind === "text" &&
          !p.archived &&
          p.visible !== false,
      ) &&
      CORE_PROPERTY_KEYS.every((key) =>
        a.some((p) => p.id === key && !p.archived),
      ) &&
      a.some((p) => p.id === "owner" && p.kind === "member" && !p.multiple) &&
      a.some(
        (p) =>
          p.id === "status" &&
          p.kind === "option" &&
          p.values.some((v) => !v.archived),
      ),
    "작업·팀원·상태는 삭제하거나 종류를 바꿀 수 없습니다. 상태에는 선택값이 하나 이상 필요하며 속성 이름과 ID는 중복될 수 없습니다.",
  );
