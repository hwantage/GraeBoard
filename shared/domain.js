import { defaultCoreProperties } from "./coreProperties.js";
import { FONTS } from "./fonts.js";
export {
  FONTS,
  FONT_SIZES,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  normalizeFont,
  fontFamilyCSS,
} from "./fonts.js";
export {
  CORE_PROPERTY_KEYS,
  DEFAULT_STATUS_OPTIONS,
  defaultCoreProperties,
  sampleProperties,
} from "./coreProperties.js";
export const PROPERTY_VALUE_MAX_LENGTH = 15;
export const MAX_STYLE_CELLS = 50000;
/** @type {import("../src/types").Settings} */
export const DEFAULT_SETTINGS = {
  properties: defaultCoreProperties(),
  theme: "mint",
  defaultDensity: "compact",
  defaultStyle: { fontFamily: FONTS[0], fontSize: 9, verticalAlign: "top" },
};
export const PALETTE = [
  "#ffffff",
  "#edf6f4",
  "#d1eee6",
  "#a8ddce",
  "#177b70",
  "#e5effc",
  "#b9d4f7",
  "#3c71ad",
  "#fff2c6",
  "#ffd978",
  "#d68c29",
  "#ffe6dd",
  "#f7b6a0",
  "#cc564d",
  "#ede8fa",
  "#cebdeb",
  "#8766ad",
  "#243642",
];
export const DEFAULT_VISIBLE_FIELDS = ["title", "owner", "status"];
export function dateKey(d) {
  return d.toISOString().slice(0, 10);
}
// Intl.DateTimeFormat 생성 비용이 커서 렌더마다 만들지 않도록 한 번만 만든다.
const seoulDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function todayKey() {
  return seoulDate.format(new Date());
}
export function mondayOf(date) {
  const d = new Date(
    `${typeof date === "string" ? date.slice(0, 10) : dateKey(date)}T12:00:00Z`,
  );
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return dateKey(d);
}
export function weeksForYear(year) {
  const start = new Date(mondayOf(`${year}-01-01`) + "T12:00:00Z");
  const end = new Date(`${year}-12-31T12:00:00Z`);
  const weeks = [];
  for (let d = start; d <= end; d = new Date(d.getTime() + 7 * 86400000)) {
    const friday = new Date(d.getTime() + 4 * 86400000),
      sunday = new Date(d.getTime() + 6 * 86400000);
    const display =
      friday.getUTCFullYear() === year
        ? friday
        : d.getUTCFullYear() === year
          ? d
          : sunday;
    weeks.push({
      key: dateKey(d),
      end: dateKey(sunday),
      date: dateKey(friday),
      month: display.getUTCMonth() + 1,
      label: `${friday.getUTCMonth() + 1}/${friday.getUTCDate()}`,
      index: weeks.length + 1,
    });
  }
  return weeks;
}
export function emptyCell() {
  return { value: "", style: {}, version: 0 };
}
export function textMode(style = {}) {
  return style.textMode || "overflow";
}
export function emptyPropertyValue(property) {
  return property?.kind === "member" && property.multiple ? [] : "";
}
export function groupValue(task, key) {
  const v = value(task, key);
  return Array.isArray(v) ? [...v].sort().join(",") : String(v ?? "");
}
export function cell(task, key) {
  const current = task.cells[key] ?? emptyCell();
  return { ...current, style: { ...task.defaultStyle, ...current.style } };
}
export function value(task, key) {
  return cell(task, key).value;
}
// 시스템 권한(admin/user)과 팀 내 권한(lead/member/viewer)은 따로 둔다.
// 시스템 관리자는 소속과 관계없이 모든 팀을 관리하지만, 담당자가 될 수 있는
// 사람은 그 팀의 팀장·팀원뿐이다.
export const TEAM_ROLES = ["lead", "member", "viewer"];
export function teamRole(user, teamId) {
  return user?.teamRoles?.[teamId] || null;
}
export function isSystemAdmin(user) {
  return user?.systemRole === "admin";
}
export function canManageTeam(user, teamId) {
  return isSystemAdmin(user) || teamRole(user, teamId) === "lead";
}
export function canContribute(user, teamId) {
  return canManageTeam(user, teamId) || teamRole(user, teamId) === "member";
}
export function isAssignable(user, teamId) {
  return ["lead", "member"].includes(teamRole(user, teamId));
}
export function canEdit(user, task) {
  return (
    !!user &&
    (canManageTeam(user, task.teamId) ||
      (teamRole(user, task.teamId) === "member" &&
        (value(task, "owner") === user.id ||
          (value(task, "supporters") || []).includes(user.id))))
  );
}
export const PROPERTY_DISPLAYS = ["text", "round", "square", "dot", "emoji"];
export const PROPERTY_KINDS = ["option", "text", "date", "number", "member"];
// 저장된 팀 설정에 기본값을 채운다. 속성이 없으면 기본 속성으로 시작한다.
export function normalizeSettings(settings = DEFAULT_SETTINGS) {
  const { properties, ...rest } = settings || {};
  return {
    ...DEFAULT_SETTINGS,
    ...rest,
    properties: (properties || defaultCoreProperties()).map((p) => ({
      ...p,
      kind: p.kind || "option",
      placement: p.placement ?? "beforeWeeks",
      visible: p.visible ?? true,
      values: (p.values || []).map((v) => ({ ...v })),
    })),
  };
}
/** @returns {import("../src/types").Property[]} */
export function propertiesFor(settings, includeArchived = false) {
  return (settings?.properties || []).filter(
    (p) => includeArchived || !p.archived,
  );
}
// 선택형 셀에 저장된 옵션 ID로 옵션 정의를 찾는다.
export function propertyOption(property, stored) {
  return property?.kind === "option"
    ? property.values.find((v) => v.id === stored)
    : undefined;
}
export function statusSummary(tasks, settings) {
  const property = propertiesFor(settings).find((p) => p.id === "status");
  if (!property) return [];
  const groups = property.values
    .filter((v) => !v.archived)
    .map((option) => ({
      id: option.id,
      label: option.label,
      color: option.dotColor,
      count: 0,
    }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  let empty = 0,
    archived = 0;
  for (const task of tasks) {
    const stored = value(task, "status");
    if (stored === "" || stored === undefined || stored === null) {
      empty++;
      continue;
    }
    const option = propertyOption(property, stored);
    const group = option && byId.get(option.id);
    if (group) group.count++;
    else archived++;
  }
  if (empty)
    groups.push({
      id: "__empty",
      label: "미지정",
      color: "#8a959d",
      count: empty,
    });
  if (archived)
    groups.push({
      id: "__archived",
      label: "보관된 값",
      color: "#8a959d",
      count: archived,
    });
  return groups;
}
export function fieldsFor(settings) {
  return propertiesFor(settings).map((p) => ({
    key: p.id,
    label: p.name,
    width: p.width || 120,
    type: p.kind === "option" ? "property" : p.kind,
    multiple: p.multiple,
    placement: p.placement ?? "beforeWeeks",
  }));
}
export function orderColumns(fields, weeks) {
  return [
    ...fields.filter((f) => f.placement !== "afterWeeks"),
    ...weeks,
    ...fields.filter((f) => f.placement === "afterWeeks"),
  ];
}
export function normalizeView(input, settings = DEFAULT_SETTINGS) {
  const properties = propertiesFor(settings);
  const active = properties.map((p) => p.id);
  // 보기가 모르는 사이 추가된 속성은 기본 표시 여부를 따라 열에 더한다.
  const known = input.knownProperties || [];
  const visibleFields = [
    ...new Set([
      ...(input.visibleFields || []),
      ...properties
        .filter((p) => !known.includes(p.id) && p.visible !== false)
        .map((p) => p.id),
    ]),
  ].filter((k) => active.includes(k));
  for (const p of properties) {
    if (input.columnVisibility && input.columnVisibility[p.id] !== p.visible) {
      const index = visibleFields.indexOf(p.id);
      if (p.visible && index === -1) visibleFields.push(p.id);
      if (!p.visible && index !== -1) visibleFields.splice(index, 1);
    }
  }
  const sortKey = active.includes(input.sortKey) ? input.sortKey : "";
  return {
    ...defaultView(input.year),
    ...input,
    visibleFields: visibleFields.includes("title")
      ? visibleFields
      : ["title", ...visibleFields],
    knownProperties: active,
    columnVisibility: Object.fromEntries(
      properties.map((p) => [p.id, p.visible !== false]),
    ),
    groupBy: active.includes(input.groupBy) ? input.groupBy : "",
    propertyFilters: Object.fromEntries(
      Object.entries(input.propertyFilters || {}).filter(([key]) =>
        active.includes(key),
      ),
    ),
    propertyFilterModes: Object.fromEntries(
      Object.entries(input.propertyFilterModes || {}).filter(
        ([key, mode]) =>
          active.includes(key) && ["include", "exclude"].includes(mode),
      ),
    ),
    widths: input.widths || {},
    sortKey,
    sortDirection: sortKey ? (input.sortDirection ?? "asc") : "default",
  };
}
export function defaultView(year) {
  return {
    year,
    propertyFilters: {},
    propertyFilterModes: {},
    fromMonth: 1,
    toMonth: 12,
    fromWeek: "",
    toWeek: "",
    hiddenRows: [],
    hiddenWeeks: [],
    collapsedMonths: [],
    visibleFields: DEFAULT_VISIBLE_FIELDS,
    frozenColumns: 0,
    widths: {},
    rowHeights: {},
    groupBy: "",
    sortKey: "",
    sortDirection: "default",
    knownProperties: [],
    columnVisibility: {},
  };
}
export function filteredTasks(
  tasks,
  view,
  settings = DEFAULT_SETTINGS,
  users = [],
) {
  const filters = Object.entries(view.propertyFilters || {});
  let result = tasks.filter((t) => {
    if (
      filters.some(([key, values]) => {
        if (!values.length) return false;
        const cellValue = value(t, key);
        const matches = Array.isArray(cellValue)
          ? cellValue.length
            ? cellValue.some((v) => values.includes(v))
            : values.includes("")
          : values.includes(String(cellValue));
        return view.propertyFilterModes?.[key] === "exclude"
          ? matches
          : !matches;
      })
    )
      return false;
    return true;
  });
  const property = propertiesFor(settings).find((p) => p.id === view.groupBy);
  const order = new Map((property?.values || []).map((v, i) => [v.id, i]));
  const key = propertiesFor(settings).some((p) => p.id === view.sortKey)
    ? view.sortKey
    : "";
  const direction = view.sortDirection || (key ? "asc" : "default");
  const collator = new Intl.Collator("ko", {
    numeric: true,
    sensitivity: "base",
  });
  const base = (a, b) =>
    a.position - b.position ||
    String(a.createdAt).localeCompare(String(b.createdAt)) ||
    a.id.localeCompare(b.id);
  result = result.toSorted((a, b) => {
    if (property) {
      const av = groupValue(a, property.id),
        bv = groupValue(b, property.id);
      if (av !== bv) {
        const rank = (v) =>
          !v ? Number.MAX_SAFE_INTEGER : (order.get(v) ?? order.size);
        return (
          rank(av) - rank(bv) ||
          collator.compare(
            displayValue(a, property.id, users, settings),
            displayValue(b, property.id, users, settings),
          )
        );
      }
    }
    if (key && direction !== "default") {
      const av = value(a, key),
        bv = value(b, key);
      const emptyA =
        av === "" || av == null || (Array.isArray(av) && !av.length);
      const emptyB =
        bv === "" || bv == null || (Array.isArray(bv) && !bv.length);
      if (emptyA !== emptyB) return emptyA ? 1 : -1;
      const compared =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : collator.compare(
              displayValue(a, key, users, settings),
              displayValue(b, key, users, settings),
            );
      if (compared) return compared * (direction === "desc" ? -1 : 1);
    }
    return base(a, b);
  });
  return result;
}
export function visibleWeeks(year, view) {
  return weeksForYear(year).filter(
    (w) =>
      (!view.fromWeek || w.key >= view.fromWeek) &&
      (!view.toWeek || w.key <= view.toWeek) &&
      w.month >= view.fromMonth &&
      w.month <= view.toMonth &&
      !view.hiddenWeeks.includes(w.key) &&
      !view.collapsedMonths.includes(w.month),
  );
}
// 셀 값을 화면에 보이는 글자로 바꾼다. 속성을 이미 알고 있으면 이 함수를 직접 쓴다.
export function displayValueFor(property, v, users = []) {
  if (property?.kind === "member") {
    const ids = Array.isArray(v) ? v : v ? [v] : [];
    return ids
      .map((id) => users.find((u) => u.id === id)?.name || id)
      .join(", ");
  }
  return propertyOption(property, v)?.label ?? String(v ?? "");
}
export function displayValue(
  task,
  key,
  users = [],
  settings = DEFAULT_SETTINGS,
) {
  return displayValueFor(
    propertiesFor(settings, true).find((p) => p.id === key),
    value(task, key),
    users,
  );
}
export function safeSpreadsheetText(v) {
  const s = String(v ?? "");
  return /^[\s]*[=+@\-\t\r]/.test(s) ? `'${s}` : s;
}
// 쉼표·세미콜론·줄바꿈으로 나열한 이름 목록을 개별 이름으로 나눈다.
export function splitNames(text) {
  return String(text ?? "")
    .split(/[,;\n]/)
    .map((n) => n.trim())
    .filter(Boolean);
}
// 속성·선택값 ID. 팀 안에서만 유일하면 되므로 짧은 무작위 문자열로 만든다.
// 셀 키와 셀 값에 그대로 저장되므로 길이가 저장 공간에 바로 영향을 준다.
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
export function shortId(prefix) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return prefix + [...bytes].map((b) => ID_ALPHABET[b % 36]).join("");
}
export function validLink(text) {
  try {
    const match = String(text).match(/https?:\/\/[^\s]+/);
    const u = new URL(match ? match[0] : text);
    return ["http:", "https:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
export function textLinks(input) {
  const text = String(input ?? "");
  /** @type {{ text: string, href?: string }[]} */
  const parts = [];
  let end = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s]+|#\d{6}(?!\d)/g)) {
    const label = match[0];
    const href = label.startsWith("#")
      ? `http://redmine.somansa.com/redmine/issues/${label.slice(1)}`
      : validLink(label);
    if (!href) continue;
    if (match.index > end) parts.push({ text: text.slice(end, match.index) });
    parts.push({ text: label, href });
    end = match.index + label.length;
  }
  if (end < text.length || !parts.length) parts.push({ text: text.slice(end) });
  return parts;
}
