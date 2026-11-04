import { diffArrays, diffChars } from "diff";

// Both servers list a conflict as `base`/`desired` arrays (one payload per
// change of the operation) and `current` records keyed by
// entityId(entity, key). `target` labels the changes "entity k1/k2" joined by
// ", " (server/sync/node-routes.mjs, worker/admin.mjs). Pair them per change.

const ENTITY_NAMES = {
  task: "업무",
  cell: "셀",
  document: "문서",
  calendar: "일정",
  tag: "일정 태그",
  report: "사본",
  reportTask: "사본 업무",
  reportCell: "사본 셀",
  formats: "공통 서식",
  rule: "캘린더 규칙",
  weekly: "주간 항목",
  filter: "저장된 필터",
  team: "팀 설정",
  person: "사람",
};

const changeLabel = (entity, key) => entity + " " + key.join("/");

const REASONS = {
  "Concurrent field change":
    "같은 항목을 두 곳에서 고쳐, 나중에 들어온 수정을 보류했습니다.",
  "Failed dependency":
    "이 수정보다 앞선 수정이 보류되어, 이어진 이 수정도 함께 보류했습니다.",
  "Parent task deleted": "상위 업무가 그사이 삭제되어 보류했습니다.",
  "Entity already exists": "같은 항목이 이미 있어 보류했습니다.",
  "Restore base changed": "복원하려던 항목이 그사이 바뀌어 보류했습니다.",
  "Entity generation changed": "항목이 그사이 다시 만들어져 보류했습니다.",
  "Delete conflicts with edit":
    "한쪽은 삭제하고 다른 쪽은 고쳐서 보류했습니다.",
  "Entity deleted": "항목이 그사이 삭제되어 보류했습니다.",
};

const FIELD_NAMES = {
  value: "값",
  style: "서식",
  markdown: "본문",
  title: "제목",
  position: "순서",
  tags: "태그",
  date: "날짜",
  endDate: "종료일",
  lane: "표시 줄",
  userId: "담당자",
  deletedAt: "삭제 시각",
  years: "연도",
  rules: "규칙",
  name: "이름",
  color: "색",
  defaultStyle: "기본 서식",
  rowStyle: "행 서식",
};

/** "서식(style)" for known payload fields so the diff key stays findable. */
export const fieldLabel = (field) =>
  FIELD_NAMES[field] ? `${FIELD_NAMES[field]}(${field})` : field;

/** Korean explanation of the reducer's conflict reason, else the reason. */
export const conflictReason = (reason) => REASONS[reason] || reason || "";

/** "a, b 외 N개" so a large command does not fill the summary line. */
export function conflictTitle(target, shown = 2) {
  const labels = target ? target.split(", ") : [];
  if (labels.length <= shown) return labels.join(", ");
  return `${labels.slice(0, shown).join(", ")} 외 ${labels.length - shown}개`;
}

/**
 * @typedef {{ state: "present" | "deleted" | "absent", payload: unknown }} Side
 * @typedef {{ site: "internal" | "external" | null, initial?: boolean,
 *   actor: string | null, createdAt: string | null }} Origin
 * @typedef {{ label: string, entity: string, name: string, key: string,
 *   base: Side, current: Side, desired: Side, writer: Origin | null }} ConflictChange
 */

/** @returns {ConflictChange[]} */
export function conflictChanges(conflict) {
  const labels = conflict.target ? conflict.target.split(", ") : [];
  const base = Array.isArray(conflict.base) ? conflict.base : [];
  const desired = Array.isArray(conflict.desired) ? conflict.desired : [];
  const writers = conflict.origin?.writers || {};
  const records = new Map();
  const ordered = [];
  for (const [id, record] of Object.entries(conflict.current || {})) {
    let label;
    try {
      const [entity, key] = JSON.parse(id);
      label = changeLabel(entity, key);
    } catch {
      label = id;
    }
    const entry = { record, writer: writers[id] || null };
    records.set(label, entry);
    ordered.push(entry);
  }
  const count = Math.max(labels.length, base.length, desired.length);
  return Array.from({ length: count }, (_, index) => {
    const label = labels[index] || "";
    const space = label.indexOf(" ");
    const entity = space > 0 ? label.slice(0, space) : label;
    const { record, writer } = records.has(label)
      ? records.get(label)
      : ordered.length === count
        ? ordered[index]
        : { record: null, writer: null };
    return {
      label,
      entity,
      name: ENTITY_NAMES[entity] || entity || "변경",
      key: space > 0 ? label.slice(space + 1) : "",
      base: side(base[index]),
      current: record
        ? {
            state: record.deleted ? "deleted" : "present",
            payload: record.payload,
          }
        : { state: "absent", payload: null },
      desired: side(desired[index]),
      writer,
    };
  });
}

const SITE_NAMES = { internal: "사내", external: "외부" };

/** "사내" or "외부" for an origin from shared/conflict-origin.js, else "". */
export const siteName = (origin) => SITE_NAMES[origin?.site] || "";

/** "사내 · 김바다 · <time>" with whatever the origin knows. */
export function describeOrigin(origin, time = (value) => value) {
  if (!origin) return "";
  if (origin.initial) return "처음 게시된 값";
  return [
    siteName(origin),
    origin.actor,
    origin.createdAt && time(origin.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * One description of who wrote the current side of several changes: the
 * shared one, or the sites involved when they differ.
 */
export function describeWriters(changes, time) {
  const writers = changes.map((change) => change.writer).filter(Boolean);
  const descriptions = [
    ...new Set(writers.map((writer) => describeOrigin(writer, time))),
  ];
  if (descriptions.length <= 1) return descriptions[0] || "";
  const sites = [...new Set(writers.map(siteName).filter(Boolean))];
  return `${sites.join("·")} (항목마다 다름)`;
}

/**
 * Changes the other side also touched since the base come first; the rest
 * did not collide and are applied or dropped with the whole command.
 * @param {ConflictChange[]} changes
 */
export function splitContested(changes) {
  const contested = [],
    clean = [];
  for (const change of changes)
    (changedFields(change.base, change.current).length
      ? contested
      : clean
    ).push(change);
  return { contested, clean };
}

const side = (payload) =>
  payload === null || payload === undefined
    ? { state: "absent", payload: null }
    : { state: "present", payload };

const SIDE_NOTES = {
  absent: "(없음)",
  deleted: "(삭제된 항목)",
};

/**
 * Renders a payload as indented "key: value" lines with sorted keys. A
 * multi-line string (a document body) becomes one line per text line so that
 * a line diff points at the changed sentence instead of one huge JSON string.
 * @param {Side} value
 * @returns {string[]}
 */
export function sideLines(value) {
  const lines = value.state === "present" ? [] : [SIDE_NOTES[value.state]];
  if (value.state !== "absent") lines.push(...payloadLines(value.payload));
  return lines;
}

export function payloadLines(value) {
  const lines = [];
  write(value, "", "", lines);
  return lines;
}

function write(value, indent, prefix, lines) {
  if (typeof value === "string" && value.includes("\n")) {
    lines.push(indent + prefix + "|");
    for (const line of value.split("\n")) lines.push(indent + "  " + line);
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) return void lines.push(indent + prefix + "[]");
    if (prefix) lines.push(indent + prefix.trimEnd());
    const inner = prefix ? indent + "  " : indent;
    for (const item of value) {
      const start = lines.length;
      write(item, inner + "  ", "", lines);
      lines[start] = inner + "- " + lines[start].slice(inner.length + 2);
    }
    return;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    if (!keys.length) return void lines.push(indent + prefix + "{}");
    if (prefix) lines.push(indent + prefix.trimEnd());
    const inner = prefix ? indent + "  " : indent;
    for (const key of keys) write(value[key], inner, key + ": ", lines);
    return;
  }
  lines.push(indent + prefix + JSON.stringify(value ?? null));
}

/** Top-level payload fields whose values differ between two sides. */
export function changedFields(from, to) {
  if (from.state === "absent" || to.state === "absent")
    return from.state === to.state ? [] : [stateField(from, to)];
  const a = objectOf(from.payload),
    b = objectOf(to.payload);
  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => canonical(a[key]) !== canonical(b[key]))
    .sort();
  if (from.state !== to.state) fields.unshift(stateField(from, to));
  return fields;
}

const stateField = (from, to) =>
  to.state === "absent"
    ? "(없어짐)"
    : from.state === "absent"
      ? "(새로 생김)"
      : to.state === "deleted"
        ? "(삭제됨)"
        : "(복원됨)";

const objectOf = (payload) =>
  payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : { 값: payload };

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value ?? null);
}

const INLINE_LIMIT = 4000;

/**
 * @typedef {{ text: string, changed: boolean }} Segment
 * @typedef {{ type: "same" | "removed" | "added", text: string,
 *   from?: number, to?: number, segments?: Segment[] }} DiffRow
 * @typedef {{ type: "fold", count: number, rows: DiffRow[] }} DiffFold
 */

/**
 * Line diff of two sides. Unchanged runs longer than 2×context lines are
 * folded; removed lines directly followed by added lines are paired and
 * marked character by character.
 * @returns {{ equal: boolean, rows: (DiffRow | DiffFold)[] }}
 */
export function diffSides(from, to, context = 3) {
  const a = sideLines(from),
    b = sideLines(to);
  const rows = [];
  let fromLine = 1,
    toLine = 1,
    removed = [];
  for (const part of diffArrays(a, b)) {
    if (part.removed) {
      removed = part.value.map((text) => ({
        type: "removed",
        text,
        from: fromLine++,
      }));
      rows.push(...removed);
      continue;
    }
    if (part.added) {
      const added = part.value.map((text) => ({
        type: "added",
        text,
        to: toLine++,
      }));
      for (let i = 0; i < Math.min(removed.length, added.length); i++)
        markChars(removed[i], added[i]);
      rows.push(...added);
      removed = [];
      continue;
    }
    removed = [];
    for (const text of part.value)
      rows.push({ type: "same", text, from: fromLine++, to: toLine++ });
  }
  return {
    equal: rows.every((row) => row.type === "same"),
    rows: fold(rows, context),
  };
}

function markChars(removed, added) {
  if (removed.text.length + added.text.length > INLINE_LIMIT) return;
  const parts = diffChars(removed.text, added.text);
  // Lines that share almost nothing read better without character marks.
  const kept = parts
    .filter((part) => !part.added && !part.removed)
    .reduce((sum, part) => sum + part.value.length, 0);
  if (kept < Math.min(removed.text.length, added.text.length) / 3) return;
  removed.segments = parts
    .filter((part) => !part.added)
    .map((part) => ({ text: part.value, changed: !!part.removed }));
  added.segments = parts
    .filter((part) => !part.removed)
    .map((part) => ({ text: part.value, changed: !!part.added }));
}

function fold(rows, context) {
  const result = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index].type !== "same") {
      result.push(rows[index++]);
      continue;
    }
    let end = index;
    while (end < rows.length && rows[end].type === "same") end++;
    const head = index === 0 ? 0 : context,
      tail = end === rows.length ? 0 : context;
    if (end - index > head + tail + 1) {
      result.push(...rows.slice(index, index + head));
      const hidden = rows.slice(index + head, end - tail);
      result.push({ type: "fold", count: hidden.length, rows: hidden });
      result.push(...rows.slice(end - tail, end));
    } else result.push(...rows.slice(index, end));
    index = end;
  }
  return result;
}
