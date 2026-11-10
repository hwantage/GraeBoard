import { nextCalendarCopyTitle } from "../../shared/calendar/calendar.js";
import type { CalendarEntry, CalendarPlacement } from "./calendar-types";
import {
  mergeSecretCalendarLayout,
  moveSecretEntries,
  nextSecretLane,
} from "./secret-calendar-layout";

// This module deliberately has no API, sync or document dependencies. Only
// these local fields are persisted; CalendarEntry is a rendering adapter.
type StoredEntry = Pick<
  CalendarEntry,
  | "id"
  | "teamId"
  | "title"
  | "date"
  | "endDate"
  | "lane"
  | "tagIds"
  | "checkedTagIds"
> & { order: number };
type Store = { version: 2; visible: boolean; entries: StoredEntry[] };
export type SecretCalendarEntry = CalendarEntry & {
  secret: true;
  userId: string;
  order: number;
};
export const secretCalendarKey = (userId: string) =>
  `weekly-plan:secret-calendar:${userId}`;
export const secretCalendarChanged = "weekly-plan:secret-calendar-changed";
export const isSecretEntry = (
  entry: CalendarEntry,
): entry is SecretCalendarEntry => "secret" in entry && entry.secret === true;
const validDate = (date: unknown): date is string =>
  typeof date === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  !Number.isNaN(Date.parse(date)) &&
  new Date(`${date}T12:00:00Z`).toISOString().startsWith(date);
const validIds = (ids: unknown): ids is string[] =>
  Array.isArray(ids) &&
  ids.every((id) => typeof id === "string") &&
  new Set(ids).size === ids.length;
function validEntry(value: StoredEntry) {
  return (
    value &&
    typeof value.id === "string" &&
    value.id.startsWith("secret:") &&
    typeof value.teamId === "string" &&
    !!value.teamId &&
    typeof value.title === "string" &&
    !!value.title.trim() &&
    value.title.length <= 120 &&
    validDate(value.date) &&
    validDate(value.endDate) &&
    value.date <= value.endDate &&
    Number.isSafeInteger(value.lane) &&
    value.lane >= 0 &&
    Number.isSafeInteger(value.order) &&
    value.order >= 0 &&
    validIds(value.tagIds) &&
    validIds(value.checkedTagIds) &&
    value.checkedTagIds.every((id) => value.tagIds.includes(id))
  );
}
export function readSecretCalendar(userId: string): Store {
  let raw: string | null;
  try {
    raw = localStorage.getItem(secretCalendarKey(userId));
  } catch {
    throw new Error(
      "시크릿 일정을 불러올 수 없습니다. 브라우저 저장소 설정을 확인해 주세요.",
    );
  }
  if (raw === null) return { version: 2, visible: true, entries: [] };
  try {
    const value = JSON.parse(raw);
    if (value?.version === 1 && Array.isArray(value.entries)) {
      value.entries = value.entries.map((entry: StoredEntry) => ({
        ...entry,
        tagIds: [],
        checkedTagIds: [],
      }));
      value.version = 2;
    }
    if (value?.version === 2 && Array.isArray(value.entries))
      value.entries = value.entries.map(
        (entry: StoredEntry, index: number) => ({
          ...entry,
          order: entry.order ?? index,
        }),
      );
    if (
      value?.version !== 2 ||
      typeof value.visible !== "boolean" ||
      !Array.isArray(value.entries) ||
      !value.entries.every(validEntry) ||
      new Set(value.entries.map((item: StoredEntry) => item.id)).size !==
        value.entries.length
    )
      throw new Error();
    return value;
  } catch {
    throw new Error(
      "시크릿 일정 저장값을 읽을 수 없습니다. 이 브라우저의 기존 데이터는 변경하지 않았습니다.",
    );
  }
}
function write(userId: string, store: Store) {
  try {
    localStorage.setItem(secretCalendarKey(userId), JSON.stringify(store));
  } catch {
    throw new Error(
      "시크릿 일정을 저장할 수 없습니다. 브라우저 저장 공간과 설정을 확인한 뒤 다시 시도해 주세요.",
    );
  }
  window.dispatchEvent(
    new CustomEvent(secretCalendarChanged, { detail: userId }),
  );
}
function asEntry(value: StoredEntry, userId: string): SecretCalendarEntry {
  return {
    ...value,
    userId,
    secret: true,
    preview: "",
    hasDocument: false,
    revision: 0,
    updatedAt: "",
  };
}
export function secretEntries(store: Store, userId: string, teamId: string) {
  return store.entries
    .filter((item) => item.teamId === teamId)
    .map((item) => asEntry(item, userId));
}
export function setSecretCalendarVisible(userId: string, visible: boolean) {
  write(userId, { ...readSecretCalendar(userId), visible });
}
export function getSecretEntry(userId: string, teamId: string, id: string) {
  const value = readSecretCalendar(userId).entries.find(
    (item) => item.id === id && item.teamId === teamId,
  );
  if (!value) throw new Error("다른 탭에서 시크릿 일정이 삭제되었습니다.");
  return asEntry(value, userId);
}
export function saveSecretEntry(
  userId: string,
  value: Omit<StoredEntry, "tagIds" | "checkedTagIds" | "order"> &
    Partial<Pick<StoredEntry, "tagIds" | "checkedTagIds" | "order">>,
  create = false,
  layout?: CalendarPlacement[],
) {
  const store = readSecretCalendar(userId);
  if (
    !create &&
    !store.entries.some(
      (item) => item.id === value.id && item.teamId === value.teamId,
    )
  )
    throw new Error("다른 탭에서 시크릿 일정이 삭제되었습니다.");
  if (create && layout) {
    const positions = new Map(
      mergeSecretCalendarLayout(
        layout,
        secretEntries(store, userId, value.teamId),
      ).map((item) => [item.id, item.lane]),
    );
    store.entries = store.entries.map((item) =>
      positions.has(item.id)
        ? { ...item, lane: positions.get(item.id)! }
        : item,
    );
  }
  const next = {
    id: value.id,
    teamId: value.teamId,
    title: value.title.trim(),
    date: value.date,
    endDate: value.endDate,
    lane:
      create && layout
        ? nextSecretLane(
            layout,
            secretEntries(store, userId, value.teamId),
            value,
          )
        : value.lane,
    order:
      value.order ??
      store.entries.find((item) => item.id === value.id)?.order ??
      Math.max(-1, ...store.entries.map((item) => item.order)) + 1,
    tagIds: value.tagIds || [],
    checkedTagIds: value.checkedTagIds || [],
  };
  if (!validEntry(next))
    throw new Error("일정 제목과 유효한 시작일·종료일을 입력해 주세요.");
  write(userId, {
    ...store,
    entries: store.entries.some((item) => item.id === next.id)
      ? store.entries.map((item) => (item.id === next.id ? next : item))
      : [...store.entries, next],
  });
  return asEntry(next, userId);
}
export function patchSecretEntry(
  entry: SecretCalendarEntry,
  change: Partial<
    Pick<
      StoredEntry,
      "title" | "date" | "endDate" | "lane" | "tagIds" | "checkedTagIds"
    >
  >,
) {
  const latest = getSecretEntry(entry.userId, entry.teamId, entry.id);
  for (const field of Object.keys(change) as (keyof typeof change)[]) {
    if (
      JSON.stringify(latest[field]) !== JSON.stringify(entry[field]) &&
      JSON.stringify(latest[field]) !== JSON.stringify(change[field]) &&
      field !== "lane"
    )
      throw new Error(
        "다른 탭에서 시크릿 일정이 변경되었습니다. 입력을 복사한 뒤 일정을 다시 열어 주세요.",
      );
  }
  return saveSecretEntry(entry.userId, { ...latest, ...change });
}
export function copySecretEntry(
  entry: SecretCalendarEntry,
  layout: CalendarPlacement[],
) {
  const latest = getSecretEntry(entry.userId, entry.teamId, entry.id);
  return saveSecretEntry(
    entry.userId,
    {
      ...latest,
      id: `secret:${crypto.randomUUID()}`,
      order: undefined,
      title: nextCalendarCopyTitle(
        latest.title,
        readSecretCalendar(entry.userId).entries.map((item) => item.title),
      ),
    },
    true,
    layout,
  );
}
export function setSecretEntryTags(
  entry: SecretCalendarEntry,
  tagIds: string[],
) {
  const latest = getSecretEntry(entry.userId, entry.teamId, entry.id);
  return patchSecretEntry(
    { ...latest, tagIds: entry.tagIds },
    {
      tagIds,
      checkedTagIds: latest.checkedTagIds.filter((id) => tagIds.includes(id)),
    },
  );
}
export function setSecretTagChecked(
  entry: SecretCalendarEntry,
  tagId: string,
  checked: boolean,
) {
  const latest = getSecretEntry(entry.userId, entry.teamId, entry.id);
  if (!latest.tagIds.includes(tagId)) return latest;
  return patchSecretEntry(latest, {
    checkedTagIds: checked
      ? [...new Set([...latest.checkedTagIds, tagId])]
      : latest.checkedTagIds.filter((id) => id !== tagId),
  });
}
export function deleteSecretEntry(entry: SecretCalendarEntry) {
  const store = readSecretCalendar(entry.userId);
  const latest = store.entries.find(
    (item) => item.id === entry.id && item.teamId === entry.teamId,
  );
  if (!latest) throw new Error("다른 탭에서 시크릿 일정이 삭제되었습니다.");
  write(entry.userId, {
    ...store,
    entries: store.entries.filter((item) => item.id !== entry.id),
  });
  return asEntry(latest, entry.userId);
}
export function moveSecretEntry(
  entry: SecretCalendarEntry,
  layout: CalendarPlacement[],
  range: Pick<CalendarEntry, "date" | "endDate">,
  lane?: number,
) {
  const store = readSecretCalendar(entry.userId);
  const latest = getSecretEntry(entry.userId, entry.teamId, entry.id);
  for (const field of ["date", "endDate"] as const) {
    if (latest[field] !== entry[field] && latest[field] !== range[field])
      throw new Error(
        "다른 탭에서 시크릿 일정이 변경되었습니다. 입력을 복사한 뒤 일정을 다시 열어 주세요.",
      );
  }
  const moved = new Map(
    moveSecretEntries(
      layout,
      secretEntries(store, entry.userId, entry.teamId),
      entry.id,
      range,
      lane,
    ).map((item) => [item.id, item]),
  );
  const entries = store.entries.map((item) => {
    const position = moved.get(item.id);
    return position
      ? {
          ...item,
          date: position.date,
          endDate: position.endDate,
          lane: position.lane,
        }
      : item;
  });
  if (!entries.every(validEntry))
    throw new Error("일정 제목과 유효한 시작일·종료일을 입력해 주세요.");
  write(entry.userId, { ...store, entries });
}
