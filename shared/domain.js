import {
  DEFAULT_STATUS_OPTIONS,
  defaultCoreProperties,
  upgradeCoreProperties,
} from "./coreProperties.js";
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
} from "./coreProperties.js";
export const FIELDS = [
  { key: "category", label: "분류", width: 108, type: "category" },
  { key: "type", label: "유형", width: 84, type: "type" },
  { key: "title", label: "작업", width: 330, type: "text" },
  { key: "description", label: "설명", width: 220, type: "text" },
  { key: "owner", label: "팀원", width: 112, type: "person" },
  { key: "supporters", label: "지원자", width: 120, type: "people" },
  { key: "status", label: "상태", width: 105, type: "status" },
  { key: "progress", label: "진척률", width: 80, type: "text" },
  { key: "deadline", label: "목표일", width: 112, type: "date" },
  { key: "score", label: "Score", width: 72, type: "number" },
  { key: "current", label: "Current", width: 78, type: "number" },
];
export const FIELD_KEYS = FIELDS.map((f) => f.key);
export const PROPERTY_VALUE_MAX_LENGTH = 15;
export const MAX_STYLE_CELLS = 50000;
/** @type {import("../src/types").Settings} */
export const DEFAULT_SETTINGS = {
  propertiesVersion: 3,
  properties: defaultCoreProperties(),
  theme: "mint",
  categories: ["UX 개선", "차별화", "기타"],
  types: ["기획", "디자인", "개발", "검토", "연구"],
  statuses: DEFAULT_STATUS_OPTIONS.map((v) => v.label),
  retentionDays: 365,
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
export function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
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
  return style.textMode || (style.wrap ? "wrap" : "overflow");
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
  const style = { ...task.defaultStyle, ...current.style };
  // A legacy per-cell wrap flag takes priority over the task's newer default mode.
  if (current.style?.wrap !== undefined && current.style.textMode === undefined)
    style.textMode = current.style.wrap ? "wrap" : "overflow";
  return { ...current, style };
}
export function value(task, key) {
  return cell(task, key).value;
}
export function canEdit(user, task) {
  return (
    user &&
    (user.role === "admin" ||
      user.role === "manager" ||
      (user.role === "member" &&
        (value(task, "owner") === user.id ||
          (value(task, "supporters") || []).includes(user.id))))
  );
}
export const PROPERTY_DISPLAYS = ["text", "round", "square", "dot", "emoji"];
export const BUILTIN_PROPERTIES = {
  category: "categories",
  type: "types",
  status: "statuses",
};
export const PROPERTY_KINDS = ["option", "text", "date", "number", "member"];
export function normalizeSettings(settings = DEFAULT_SETTINGS) {
  const result = { ...DEFAULT_SETTINGS, ...settings };
  let properties = (settings.properties || []).map((p) => ({
    ...p,
    kind: p.kind || "option",
    values: (p.values || []).map((v) => ({ ...v })),
  }));
  if (![2, 3].includes(settings.propertiesVersion)) {
    for (const [key, list] of Object.entries(BUILTIN_PROPERTIES)) {
      if (!properties.some((p) => p.id === key))
        properties.push({
          id: key,
          name: FIELDS.find((f) => f.key === key).label,
          kind: "option",
          display: key === "status" ? "dot" : "square",
          values: result[list].map((label, i) => ({
            id: `${key}-${i}`,
            label,
            backgroundColor: key === "status" ? "#ffffff" : "#e5f0ee",
            dotColor: "#177b70",
            emoji: "📌",
          })),
        });
    }
    // Keep the old interleaved field order while making every information column editable.
    const options = properties.filter((p) => !p.archived);
    let i = 0;
    const ordered = FIELDS.flatMap((f) => {
      if (BUILTIN_PROPERTIES[f.key]) {
        if (f.key === "status") return options.slice(i);
        return i < options.length ? [options[i++]] : [];
      }
      return [
        {
          id: f.key,
          name: f.label,
          kind: ["person", "people"].includes(f.type) ? "member" : f.type,
          display: f.key === "owner" ? "avatar" : "text",
          multiple: f.key === "supporters",
          values: [],
        },
      ];
    });
    properties = [...ordered, ...properties.filter((p) => p.archived)];
  }
  if (settings.propertiesVersion !== 3)
    properties = upgradeCoreProperties(properties);
  result.properties = properties.map((p) => ({
    ...p,
    placement: p.placement ?? "beforeWeeks",
    visible:
      p.visible ??
      (!FIELD_KEYS.includes(p.id) ||
        (settings.propertiesVersion === 3
          ? DEFAULT_VISIBLE_FIELDS
          : ["category", "title", "owner", "status"]
        ).includes(p.id)),
  }));
  result.propertiesVersion = 3;
  return result;
}
/** @returns {import("../src/types").Property[]} */
export function propertiesFor(settings, includeArchived = false) {
  return (
    settings?.propertiesVersion === 3
      ? settings.properties
      : normalizeSettings(settings).properties
  ).filter((p) => includeArchived || !p.archived);
}
export function propertyValue(property, option) {
  return BUILTIN_PROPERTIES[property.id] ? option.label : option.id;
}
export function propertyOption(property, stored) {
  return property?.kind === "option" || property?.kind === undefined
    ? property?.values.find((v) => propertyValue(property, v) === stored)
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
    legacy = 0;
  for (const task of tasks) {
    const stored = value(task, "status");
    if (stored === "" || stored === undefined || stored === null) {
      empty++;
      continue;
    }
    const option = propertyOption(property, stored);
    const group = option && byId.get(option.id);
    if (group) group.count++;
    else legacy++;
  }
  if (empty)
    groups.push({
      id: "__empty",
      label: "미지정",
      color: "#8a959d",
      count: empty,
    });
  if (legacy)
    groups.push({
      id: "__legacy",
      label: "기존 값",
      color: "#8a959d",
      count: legacy,
    });
  return groups;
}
export function fieldsFor(settings) {
  return propertiesFor(settings).map((p) => ({
    key: p.id,
    label: p.name,
    width: FIELDS.find((f) => f.key === p.id)?.width || 120,
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
  const keys = fieldsFor(settings).map((f) => f.key);
  const known = [...FIELD_KEYS, ...(input.knownProperties || [])];
  const visibleFields = [
    ...new Set([
      ...input.visibleFields,
      ...properties
        .filter((p) => !known.includes(p.id) && p.visible !== false)
        .map((p) => p.id),
    ]),
  ].filter((k) => keys.includes(k));
  for (const p of properties) {
    if (input.columnVisibility && input.columnVisibility[p.id] !== p.visible) {
      const index = visibleFields.indexOf(p.id);
      if (p.visible && index === -1) visibleFields.push(p.id);
      if (!p.visible && index !== -1) visibleFields.splice(index, 1);
    }
  }
  const groupBy =
    input.groupBy ?? (input.sort === "category" ? "category" : "");
  const requestedSortKey =
    input.sortKey ??
    (["title", "deadline"].includes(input.sort) ? input.sort : "");
  const sortKey = keys.includes(requestedSortKey) ? requestedSortKey : "";
  const widths = Object.fromEntries(
    Object.entries(input.widths || {}).map(([key, width]) => [
      key,
      !input.compactWeekColumns && /^\d{4}-\d{2}-\d{2}$/.test(key)
        ? Math.max(40, Math.round(width / 2))
        : width,
    ]),
  );
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
    groupBy: active.includes(groupBy) ? groupBy : "",
    propertyFilters: Object.fromEntries(
      Object.entries(propertyFiltersFor(input)).filter(([key]) =>
        active.includes(key),
      ),
    ),
    status: "",
    category: "",
    widths,
    compactWeekColumns: true,
    sortKey,
    sortDirection: sortKey ? (input.sortDirection ?? "asc") : "default",
    sort: "position",
  };
}
export function defaultView(year) {
  return {
    year,
    people: [],
    personRole: "either",
    status: "",
    category: "",
    propertyFilters: {},
    search: "",
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
    compactWeekColumns: true,
    rowHeights: {},
    sort: "position",
    groupBy: "",
    sortKey: "",
    sortDirection: "default",
    knownProperties: FIELD_KEYS,
    columnVisibility: Object.fromEntries(
      FIELD_KEYS.map((key) => [key, DEFAULT_VISIBLE_FIELDS.includes(key)]),
    ),
    density: "compact",
  };
}
export function propertyFiltersFor(view) {
  const filters = { ...view.propertyFilters };
  for (const key of ["category", "status"])
    if (view[key] && filters[key] === undefined) filters[key] = [view[key]];
  return filters;
}
export function filteredTasks(
  tasks,
  view,
  userId,
  settings = DEFAULT_SETTINGS,
  users = [],
) {
  const selected = view.people.map((p) => (p === "me" ? userId : p));
  const filters = Object.entries(propertyFiltersFor(view));
  let result = tasks.filter((t) => {
    const owner = value(t, "owner"),
      supporters = value(t, "supporters") || [];
    if (
      selected.length &&
      !selected.some(
        (p) =>
          (view.personRole !== "supporter" && owner === p) ||
          (view.personRole !== "owner" && supporters.includes(p)),
      )
    )
      return false;
    if (
      filters.some(
        ([key, values]) =>
          values.length &&
          !(Array.isArray(value(t, key))
            ? value(t, key).length
              ? value(t, key).some((v) => values.includes(v))
              : values.includes("")
            : values.includes(String(value(t, key)))),
      )
    )
      return false;
    if (
      view.search &&
      !`${value(t, "title")} ${value(t, "description")}`
        .toLowerCase()
        .includes(view.search.toLowerCase())
    )
      return false;
    return true;
  });
  const property = propertiesFor(settings).find(
    (p) =>
      p.id === (view.groupBy || (view.sort === "category" ? "category" : "")),
  );
  const order = new Map(
    (property?.values || []).map((v, i) => [propertyValue(property, v), i]),
  );
  const requestedKey =
    view.sortKey ||
    (["title", "deadline"].includes(view.sort) ? view.sort : "");
  const key = fieldsFor(settings).some((f) => f.key === requestedKey)
    ? requestedKey
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
export function displayValue(
  task,
  key,
  users = [],
  settings = DEFAULT_SETTINGS,
) {
  const v = value(task, key);
  const property = propertiesFor(settings, true).find((p) => p.id === key);
  if (property?.kind === "member") {
    const ids = Array.isArray(v) ? v : v ? [v] : [];
    return ids
      .map((id) => users.find((u) => u.id === id)?.name || id)
      .join(", ");
  }
  return propertyOption(property, v)?.label ?? String(v ?? "");
}
export function safeSpreadsheetText(v) {
  const s = String(v ?? "");
  return /^[\s]*[=+@\-\t\r]/.test(s) ? `'${s}` : s;
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
