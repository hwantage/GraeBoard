import {
  placeCalendarEntry,
  compactCalendarEntries,
} from "../../shared/calendar-layout.js";
import { z } from "zod";
import {
  dateSchema,
  propertyFilterValuesSchema,
  propertyFilterModeSchema,
  requireThat,
} from "../../shared/validation.js";
import {
  canContribute,
  canManageTeam,
  matchesPropertyFilter,
} from "../../shared/domain.js";
import {
  calendarWeek,
  CALENDAR_MAX_RANGE_DAYS,
  addDays,
  daysBetween,
} from "../../shared/calendar.js";
import {
  CALENDAR_TAG_COLORS,
  CALENDAR_TAG_LIMIT,
} from "../../shared/calendar-tags.js";
export const uuid = z.string().uuid();
export const titleSchema = z.string().trim().min(1).max(120);
const revisionSchema = z.number().int().nonnegative();
const laneSchema = z.number().int().min(0).max(10000);
const tagIdsSchema = z
  .array(uuid)
  .max(CALENDAR_TAG_LIMIT)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "같은 태그를 중복으로 지정할 수 없습니다.",
  );
const tagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.enum(CALENDAR_TAG_COLORS.map((color) => color.id)),
  kind: z.enum(["label", "check"]).default("label"),
});
export const scopeSchema = z.object({ teamId: uuid, userId: uuid });
const weeklyScopeSchema = scopeSchema.extend({
  weekStart: dateSchema.refine(
    (date) => calendarWeek(date) === date,
    "대상 주는 일요일 날짜로 선택하세요.",
  ),
});
export const rangeSchema = z.object({ date: dateSchema, endDate: dateSchema });
const bodySchemas = {
  savePreferences: z
    .object({
      weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    })
    .strict(),
  createTag: tagSchema
    .extend({ id: uuid, userId: uuid.nullable().optional() })
    .strict(),
  updateTag: tagSchema
    .extend({
      kind: tagSchema.shape.kind.removeDefault().optional(),
      expectedRevision: revisionSchema,
    })
    .strict(),
  deleteTag: z.object({ expectedRevision: revisionSchema }).strict(),
  saveRule: z
    .object({
      propertyId: z.string().min(1).max(80),
      values: propertyFilterValuesSchema,
      mode: propertyFilterModeSchema.default("include"),
      expectedRevision: revisionSchema,
    })
    .strict(),
  addWeekly: weeklyScopeSchema
    .extend({
      taskIds: z
        .array(uuid)
        .min(1)
        .max(100)
        .refine(
          (ids) => new Set(ids).size === ids.length,
          "같은 업무를 중복으로 선택할 수 없습니다.",
        ),
    })
    .strict(),
  importWeekly: weeklyScopeSchema.strict(),
  createEntry: scopeSchema
    .extend({
      userId: uuid.nullable(),
      id: uuid,
      date: dateSchema,
      endDate: dateSchema.optional(),
      title: titleSchema,
      tagIds: tagIdsSchema.default([]),
      checkedTagIds: tagIdsSchema.default([]),
    })
    .strict(),
  copyEntry: z.object({ id: uuid }).strict(),
  updateEntry: z.union([
    z
      .object({ title: titleSchema, expectedTitle: z.string().max(120) })
      .strict(),
    rangeSchema
      .extend({ expectedDate: dateSchema, expectedEndDate: dateSchema })
      .strict(),
    z
      .object({
        lane: laneSchema,
        expectedLane: laneSchema,
        expectedDate: dateSchema,
        expectedEndDate: dateSchema,
      })
      .strict(),
    z.object({ tagIds: tagIdsSchema, expectedTagIds: tagIdsSchema }).strict(),
  ]),
  checkTag: z
    .object({ checked: z.boolean(), expectedChecked: z.boolean() })
    .strict(),
  deleteEntry: z
    .object({
      deletionId: uuid,
      expectedUpdatedAt: z.string().datetime(),
      expectedRevision: revisionSchema,
      expectedTitle: z.string().max(120),
      expectedDate: dateSchema,
      expectedEndDate: dateSchema,
      expectedTagIds: tagIdsSchema.default([]),
      expectedCheckedTagIds: tagIdsSchema.default([]),
    })
    .strict(),
  restoreEntry: z
    .object({ deletionId: uuid, previousRange: rangeSchema.optional() })
    .strict(),
};
const querySchemas = {
  listTags: z.object({
    scope: z.enum(["personal", "team"]).default("personal"),
    userId: uuid.optional(),
  }),
  listEntries: z.object({
    teamId: uuid,
    scope: z.enum(["personal", "team"]).default("personal"),
    userId: uuid.optional(),
    from: dateSchema,
    to: dateSchema,
  }),
  listTasks: weeklyScopeSchema.extend({
    q: z.string().max(120).default(""),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  }),
};
export const CALENDAR_ROUTES = [
  {
    name: "getPreferences",
    method: "GET",
    path: "/calendar/preferences",
    status: 200,
  },
  {
    name: "savePreferences",
    method: "PUT",
    path: "/calendar/preferences",
    status: 200,
  },
  {
    name: "getTeam",
    method: "GET",
    path: "/calendar/teams/:teamId",
    status: 200,
  },
  {
    name: "listTags",
    method: "GET",
    path: "/calendar/teams/:teamId/tags",
    status: 200,
  },
  {
    name: "createTag",
    method: "POST",
    path: "/calendar/teams/:teamId/tags",
    status: 201,
  },
  {
    name: "updateTag",
    method: "PATCH",
    path: "/calendar/tags/:id",
    status: 200,
  },
  {
    name: "deleteTag",
    method: "DELETE",
    path: "/calendar/tags/:id",
    status: 200,
  },
  {
    name: "saveRule",
    method: "PUT",
    path: "/calendar/teams/:teamId/rule",
    status: 200,
  },
  {
    name: "listEntries",
    method: "GET",
    path: "/calendar",
    status: 200,
  },
  {
    name: "listTasks",
    method: "GET",
    path: "/calendar/tasks",
    status: 200,
  },
  {
    name: "addWeekly",
    method: "POST",
    path: "/calendar/weekly",
    status: 200,
  },
  {
    name: "importWeekly",
    method: "POST",
    path: "/calendar/import",
    status: 200,
  },
  {
    name: "createEntry",
    method: "POST",
    path: "/calendar/entries",
    status: 201,
  },
  {
    name: "copyEntry",
    method: "POST",
    path: "/calendar/entries/:id/copy",
    status: 201,
  },
  {
    name: "getEntry",
    method: "GET",
    path: "/calendar/entries/:id",
    status: 200,
  },
  {
    name: "updateEntry",
    method: "PATCH",
    path: "/calendar/entries/:id",
    status: 200,
  },
  {
    name: "checkTag",
    method: "PATCH",
    path: "/calendar/entries/:id/tags/:tagId",
    status: 200,
  },
  {
    name: "deleteEntry",
    method: "DELETE",
    path: "/calendar/entries/:id",
    status: 200,
  },
  {
    name: "restoreEntry",
    method: "POST",
    path: "/calendar/entries/:id/restore",
    status: 200,
  },
  {
    name: "getTask",
    method: "GET",
    path: "/calendar/tasks/:id",
    status: 200,
  },
];
const routes = new Map(CALENDAR_ROUTES.map((route) => [route.name, route]));
export function matchCalendarRoute(path, method) {
  for (const route of CALENDAR_ROUTES) {
    if (route.method !== method) continue;
    const names = [];
    const pattern = route.path.replace(/:([a-zA-Z]+)/g, (_, name) => {
      names.push(name);
      return "([^/]+)";
    });
    const matched = new RegExp("^" + pattern + "$").exec(path);
    if (matched)
      return {
        name: route.name,
        params: Object.fromEntries(
          names.map((name, i) => [name, decodeURIComponent(matched[i + 1])]),
        ),
      };
  }
  return null;
}
// Ordinary calendar command boundary: authorization context, validation and
// policies are shared; repositories retain their engine's transaction semantics.
export class CalendarBusinessService {
  constructor(repository, user) {
    this.repository = repository;
    this.user = user;
  }
  execute(operation, { params = {}, body = {}, query = {} } = {}) {
    requireThat(routes.has(operation), 404, "등록되지 않은 일정 기능입니다.");
    const values =
      query instanceof URLSearchParams ? Object.fromEntries(query) : query;
    this.repository.authorizeCommand?.(operation, this.user, params);
    const request = {
      params,
      body: bodySchemas[operation]?.parse(body) || body,
      query: querySchemas[operation]?.parse(values) || values,
    };
    return this.repository.execute(operation, this.user, request);
  }
  getPreferences(request) {
    return this.execute("getPreferences", request);
  }
  savePreferences(request) {
    return this.execute("savePreferences", request);
  }
  getTeam(request) {
    return this.execute("getTeam", request);
  }
  listTags(request) {
    return this.execute("listTags", request);
  }
  createTag(request) {
    return this.execute("createTag", request);
  }
  updateTag(request) {
    return this.execute("updateTag", request);
  }
  deleteTag(request) {
    return this.execute("deleteTag", request);
  }
  saveRule(request) {
    return this.execute("saveRule", request);
  }
  listEntries(request) {
    return this.execute("listEntries", request);
  }
  listTasks(request) {
    return this.execute("listTasks", request);
  }
  addWeekly(request) {
    return this.execute("addWeekly", request);
  }
  importWeekly(request) {
    return this.execute("importWeekly", request);
  }
  createEntry(request) {
    return this.execute("createEntry", request);
  }
  copyEntry(request) {
    return this.execute("copyEntry", request);
  }
  getEntry(request) {
    return this.execute("getEntry", request);
  }
  updateEntry(request) {
    return this.execute("updateEntry", request);
  }
  checkTag(request) {
    return this.execute("checkTag", request);
  }
  deleteEntry(request) {
    return this.execute("deleteEntry", request);
  }
  restoreEntry(request) {
    return this.execute("restoreEntry", request);
  }
  getTask(request) {
    return this.execute("getTask", request);
  }
}
export function requireCalendarWrite(user, teamId, userId) {
  requireThat(
    userId === null ||
      canManageTeam(user, teamId) ||
      (user.id === userId && canContribute(user, teamId)),
    403,
    "본인 일정 또는 팀장 권한으로만 수정할 수 있습니다.",
  );
}
export function prepareCalendarTagUpdate(before, body) {
  const next = {
    name: body.name,
    color: body.color,
    kind: body.kind ?? before.kind,
  };
  const unchanged =
    before.name === next.name &&
    before.color === next.color &&
    before.kind === next.kind;
  requireThat(
    before.revision === body.expectedRevision || unchanged,
    409,
    "다른 사용자가 태그를 변경했습니다. 목록을 새로고침한 뒤 다시 확인하세요.",
  );
  return unchanged ? null : next;
}
export function requireCalendarRange(date, endDate, { query = false } = {}) {
  dateSchema.parse(date);
  dateSchema.parse(endDate);
  requireThat(
    date <= endDate &&
      (!query || endDate <= addDays(date, CALENDAR_MAX_RANGE_DAYS - 1)),
    400,
    query
      ? "캘린더는 최대 62일 범위로 조회하세요."
      : "종료일은 시작일 이후여야 합니다.",
  );
}

export function selectCalendarImport(candidates, { userId, weekStart }, rule) {
  const years = new Set([
    Number(weekStart.slice(0, 4)),
    Number(addDays(weekStart, 6).slice(0, 4)),
  ]);
  let unassigned = 0;
  const ids = [];
  for (const task of candidates) {
    if (
      !task.years.some((year) => years.has(year)) ||
      !matchesPropertyFilter(task.filterValue ?? "", rule.values, rule.mode)
    )
      continue;
    if (!task.owner) unassigned++;
    if (task.owner === userId) ids.push(task.id);
  }
  return { ids, unassigned };
}
export function calendarConnectedLayout(entries, ranges) {
  const found = new Map();
  for (const seed of ranges) {
    let date = seed.date,
      endDate = seed.endDate,
      changed = true;
    while (changed) {
      changed = false;
      for (const entry of entries) {
        if (entry.date > endDate || entry.endDate < date) continue;
        found.set(entry.id, entry);
        if (entry.date < date) {
          date = entry.date;
          changed = true;
        }
        if (entry.endDate > endDate) {
          endDate = entry.endDate;
          changed = true;
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}
export function prepareCalendarPlacement(entries, id, range) {
  return range
    ? placeCalendarEntry(entries, {
        ...entries.find((item) => item.id === id),
        ...range,
      })
    : compactCalendarEntries(entries);
}

// Both the grab point and the drop target are within a <=62-day view.
// A long card can therefore reach up to 61 days beyond either endpoint.
export function dragLayoutRange(range, view) {
  const extend = (date, days) =>
    new Date(
      Math.max(
        Date.parse("0000-01-01T12:00:00Z"),
        Math.min(
          Date.parse("9999-12-31T12:00:00Z"),
          Date.parse(`${date}T12:00:00Z`) + days * 86400000,
        ),
      ),
    )
      .toISOString()
      .slice(0, 10);
  return {
    date: extend(
      range.date,
      view
        ? -daysBetween(
            view.date,
            range.endDate < view.endDate ? range.endDate : view.endDate,
          )
        : 1 - CALENDAR_MAX_RANGE_DAYS,
    ),
    endDate: extend(
      range.endDate,
      view
        ? daysBetween(
            range.date > view.date ? range.date : view.date,
            view.endDate,
          )
        : CALENDAR_MAX_RANGE_DAYS - 1,
    ),
  };
}

export function calendarViewRange(entries, view) {
  return entries.reduce((range, item) => {
    const reachable = dragLayoutRange(item, view);
    return {
      date: reachable.date < range.date ? reachable.date : range.date,
      endDate:
        reachable.endDate > range.endDate ? reachable.endDate : range.endDate,
    };
  }, view);
}

export function calendarPreview(markdown) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[이미지]")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "")
    .replace(/[#*`>\[\]_~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}
