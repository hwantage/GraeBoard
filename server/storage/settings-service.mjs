import { z } from "zod";
import {
  normalizeSettings,
  normalizeView,
  savedFilter,
  viewLayout,
  propertyOption,
  splitNames,
  PROPERTY_VALUE_MAX_LENGTH,
} from "../../shared/domain.js";
import {
  propertiesSchema,
  styleSchema,
  weekHeaderSchema,
  borderSchema,
  requireThat,
} from "../validation.mjs";
import { THEME_IDS } from "../../shared/themes.js";
const weekBordersSchema = z
  .object({ left: borderSchema.optional(), right: borderSchema.optional() })
  .strict();

export const settingsSchema = z
  .object({
    theme: z.enum(THEME_IDS).optional(),
    properties: propertiesSchema.optional(),
    revision: z.number().int().nonnegative().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    defaultStyle: styleSchema.optional(),
    defaultDensity: z.enum(["comfortable", "compact", "dense"]).optional(),
    weekHeader: weekHeaderSchema.optional(),
    weekBorders: weekBordersSchema.optional(),
    currentWeekBorders: weekBordersSchema.optional(),
  })
  .strict();

export function prepareSettings(
  previous,
  input,
  { requireRevision = false } = {},
) {
  previous = normalizeSettings(previous);
  const data = settingsSchema.parse(input);
  const expected = data.revision ?? data.expectedRevision;
  if (expected !== undefined || requireRevision)
    requireThat(
      expected === (previous.revision || 0),
      409,
      "다른 관리자가 설정을 변경했습니다. 다시 열어 최신 설정을 확인하세요.",
    );
  // 제거한 속성·선택값은 보관(archived)해서 기존 셀을 계속 읽을 수 있게 한다.
  let properties = (data.properties ?? previous.properties).map((p) => {
    const old = previous.properties.find((o) => o.id === p.id);
    return {
      ...p,
      placement: p.placement ?? old?.placement ?? "beforeWeeks",
      values: [
        ...p.values,
        ...(old?.values || [])
          .filter((v) => !p.values.some((n) => n.id === v.id))
          .map((v) => ({ ...v, archived: true })),
      ],
    };
  });
  properties.push(
    ...previous.properties
      .filter((p) => !properties.some((n) => n.id === p.id))
      .map((p) => ({ ...p, archived: true })),
  );
  properties = normalizeSettings({ properties }).properties;
  propertiesSchema.parse(properties);
  for (const p of properties.filter((p) =>
    ["owner", "supporters"].includes(p.id),
  ))
    requireThat(
      p.kind === "member" && !!p.multiple === (p.id === "supporters"),
      400,
      "팀원·지원자는 업무 담당자를 지정하는 Member 속성입니다. 기본 팀원 속성은 삭제할 수 없습니다.",
    );
  for (const p of properties) {
    const old = previous.properties.find((o) => o.id === p.id);
    for (const v of p.values) {
      // 이름을 바꾸거나 새로 만든 값만 길이 제한을 받는다.
      const unchanged = old?.values.some(
        (o) => o.id === v.id && o.label === v.label,
      );
      requireThat(
        unchanged || v.label.length <= PROPERTY_VALUE_MAX_LENGTH,
        400,
        `${p.name}의 값 이름은 ${PROPERTY_VALUE_MAX_LENGTH}자까지 입력할 수 있습니다.`,
      );
    }
  }
  const settings = {
    theme: data.theme ?? previous.theme,
    properties,
    defaultStyle: data.defaultStyle ?? previous.defaultStyle,
    defaultDensity: data.defaultDensity ?? previous.defaultDensity,
    weekHeader: data.weekHeader ?? previous.weekHeader,
    weekBorders: data.weekBorders ?? previous.weekBorders,
    currentWeekBorders: data.currentWeekBorders ?? previous.currentWeekBorders,
    revision: (previous.revision || 0) + 1,
  };

  // Optional legacy settings are absent in persisted JSON, never undefined values.
  for (const key of Object.keys(settings))
    if (settings[key] === undefined) delete settings[key];
  return { previous, settings };
}
export function changedSettingsProperties(previous, properties) {
  return properties.filter((p) => {
    const old = previous.properties.find((o) => o.id === p.id);
    return (
      old &&
      !p.archived &&
      (old.kind !== p.kind || !!old.multiple !== !!p.multiple)
    );
  });
}
export function convertSettingsValue(old, p, value, users, validate) {
  const empty = value === "" || (Array.isArray(value) && !value.length);
  const text =
    old.kind === "member"
      ? (Array.isArray(value) ? value : empty ? [] : [value])
          .map((id) => users.find((u) => u.id === id)?.name || id)
          .join(", ")
      : (propertyOption(old, value)?.label ?? String(value));
  let next = empty ? (p.kind === "member" && p.multiple ? [] : "") : text;
  if (!empty && p.kind === "number")
    next = text.trim() && Number.isFinite(Number(text)) ? Number(text) : text;
  if (!empty && p.kind === "option") {
    const option = p.values.find(
      (v) => !v.archived && (v.label === text || v.id === value),
    );
    next = option ? option.id : text;
  }
  if (!empty && p.kind === "member") {
    const ids = splitNames(text).map((n) => {
      const matches = users.filter(
        (u) => u.role !== "viewer" && (u.id === n || u.name === n),
      );
      requireThat(
        matches.length === 1,
        400,
        `${p.name}: “${n}”에 해당하는 팀원을 정확히 선택할 수 없습니다.`,
      );
      return matches[0].id;
    });
    requireThat(
      p.multiple || ids.length <= 1,
      400,
      `${p.name}: 여러 팀원이 선택된 값이 있어 단일 선택으로 바꿀 수 없습니다.`,
    );
    next = p.multiple ? [...new Set(ids)] : ids[0] || "";
  }
  try {
    validate(next);
  } catch {
    requireThat(
      false,
      400,
      `${p.name}: 기존 값 “${text.slice(0, 40)}”을 새 속성 종류로 바꿀 수 없습니다. 해당 값을 먼저 수정하세요.`,
    );
  }

  return next;
}
export function normalizeSettingsAuxiliary(kind, data, settings) {
  return kind === "view"
    ? viewLayout(normalizeView(data, settings))
    : savedFilter(data, settings);
}
export const teamGeneralSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    theme: z.enum(THEME_IDS).optional(),
    settingsRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export class SettingsBusinessService {
  constructor(repository, user) {
    this.repository = repository;
    this.user = user;
  }
  save(teamId, input) {
    return this.repository.save(this.user, teamId, settingsSchema.parse(input));
  }
  general(teamId, input) {
    return this.repository.general(
      this.user,
      teamId,
      teamGeneralSchema.parse(input),
    );
  }
}
