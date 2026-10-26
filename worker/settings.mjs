import { z } from "zod";
import {
  normalizeSettings,
  normalizeView,
  savedFilter,
  viewLayout,
  propertyOption,
  splitNames,
  PROPERTY_VALUE_MAX_LENGTH,
} from "../shared/domain.js";
import {
  propertiesSchema,
  styleSchema,
  weekHeaderSchema,
  borderSchema,
  validateCellValue,
} from "../server/validation.mjs";
import { THEME_IDS } from "../shared/themes.js";
import { assert } from "./access.mjs";
const borders = z
  .object({ left: borderSchema.optional(), right: borderSchema.optional() })
  .strict();
const schema = z
  .object({
    theme: z.enum(THEME_IDS).optional(),
    properties: propertiesSchema.optional(),
    revision: z.number().int().nonnegative().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    defaultStyle: styleSchema.optional(),
    defaultDensity: z.enum(["comfortable", "compact", "dense"]).optional(),
    weekHeader: weekHeaderSchema.optional(),
    weekBorders: borders.optional(),
    currentWeekBorders: borders.optional(),
  })
  .strict();
export async function saveWorkerSettings(s, input, people) {
  const row = await s.get("team", []),
    previous = normalizeSettings(row.payload.settings),
    data = schema.parse(input);
  const expected = data.revision ?? data.expectedRevision;
  assert(
    expected === row.revision,
    409,
    "다른 관리자가 설정을 변경했습니다. 최신 설정을 확인하세요.",
  );
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
  for (const p of properties) {
    const old = previous.properties.find((o) => o.id === p.id);
    if (["owner", "supporters"].includes(p.id))
      assert(
        p.kind === "member" && !!p.multiple === (p.id === "supporters"),
        400,
        "팀원·지원자 종류는 변경할 수 없습니다.",
      );
    for (const value of p.values)
      assert(
        old?.values.some((o) => o.id === value.id && o.label === value.label) ||
          value.label.length <= PROPERTY_VALUE_MAX_LENGTH,
        400,
        "선택값 이름이 너무 깁니다.",
      );
  }
  const settings = {
    ...previous,
    ...Object.fromEntries(
      Object.entries(data).filter(
        ([k]) => !["revision", "expectedRevision"].includes(k),
      ),
    ),
    properties,
  };
  delete settings.revision;
  const allowed = new Set(
    people.filter((p) => p.role !== "viewer").map((p) => p.id),
  );
  for (const property of properties) {
    const old = previous.properties.find((p) => p.id === property.id);
    if (
      !old ||
      property.archived ||
      (old.kind === property.kind && !!old.multiple === !!property.multiple)
    )
      continue;
    for (const row of await s.list("cell"))
      if (row.key[1] === property.id) {
        const value = row.payload.value,
          empty = value === "" || (Array.isArray(value) && !value.length),
          text =
            old.kind === "member"
              ? (Array.isArray(value) ? value : empty ? [] : [value])
                  .map((id) => people.find((p) => p.id === id)?.name || id)
                  .join(", ")
              : (propertyOption(old, value)?.label ?? String(value));
        let next = empty
          ? property.kind === "member" && property.multiple
            ? []
            : ""
          : text;
        if (!empty && property.kind === "number")
          next =
            text.trim() && Number.isFinite(Number(text)) ? Number(text) : text;
        if (!empty && property.kind === "option")
          next =
            property.values.find(
              (v) => !v.archived && (v.label === text || v.id === value),
            )?.id || text;
        if (!empty && property.kind === "member") {
          const ids = splitNames(text).map((name) => {
            const matches = people.filter(
              (u) => u.role !== "viewer" && (u.id === name || u.name === name),
            );
            assert(
              matches.length === 1,
              400,
              `${property.name}: 팀원을 정확히 선택할 수 없습니다.`,
            );
            return matches[0].id;
          });
          assert(
            property.multiple || ids.length <= 1,
            400,
            "복수 팀원을 단일 선택으로 바꿀 수 없습니다.",
          );
          next = property.multiple ? [...new Set(ids)] : ids[0] || "";
        }
        try {
          validateCellValue(
            null,
            s.teamId,
            property.id,
            next,
            settings,
            undefined,
            allowed,
          );
        } catch {
          assert(
            false,
            400,
            `${property.name}: 기존 값을 새 속성 종류로 바꿀 수 없습니다.`,
          );
        }
        await s.put("cell", row.key, { ...row.payload, value: next });
        await s.touch("task", [row.key[0]]);
      }
  }
  for (const entity of ["view", "filter", "personalFilter", "filterState"])
    for (const row of await s.list(entity)) {
      const value =
        entity === "view"
          ? viewLayout(normalizeView(row.payload, settings))
          : { ...row.payload, data: savedFilter(row.payload.data, settings) };
      await s.put(entity, row.key, value);
    }
  const saved = await s.put("team", [], { ...row.payload, settings });
  return { ...saved.payload.settings, revision: saved.revision };
}
