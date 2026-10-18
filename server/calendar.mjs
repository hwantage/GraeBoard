import { createHash } from "node:crypto";
import { z } from "zod";
import { audit, json, now, parse, transaction, usersWithTeams } from "./db.mjs";
import {
  dateSchema,
  documentSchema,
  propertyFilterValuesSchema,
  propertyFilterModeSchema,
  requireThat,
} from "./validation.mjs";
import {
  canContribute,
  canManageTeam,
  matchesPropertyFilter,
  todayKey,
} from "../shared/domain.js";
import { normalizeSearchQuery } from "../shared/search.js";
import {
  compactCalendarEntries,
  firstCalendarLane,
  mergeCalendarLayout,
  placeCalendarEntry,
} from "../shared/calendar-layout.js";
import {
  addDays,
  calendarWeek,
  calendarRuleProblem,
  CALENDAR_DAYS,
  CALENDAR_MAX_RANGE_DAYS,
} from "../shared/calendar.js";
import {
  readDocumentVersion,
  storeDocumentVersion,
  pruneDocumentVersions,
} from "./document-storage.mjs";
import { validateDocumentImages } from "./document-images.mjs";
import {
  CALENDAR_TAG_COLORS,
  CALENDAR_TAG_LIMIT,
} from "../shared/calendar-tags.js";

const uuid = z.string().uuid();
const titleSchema = z.string().trim().min(1).max(120);
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
const scopeSchema = z.object({ teamId: uuid, userId: uuid });
const weeklyScopeSchema = scopeSchema.extend({
  weekStart: dateSchema.refine(
    (date) => calendarWeek(date) === date,
    "대상 주는 일요일 날짜로 선택하세요.",
  ),
});
const saveSchema = z
  .object({
    ...documentSchema.shape,
    expectedRevision: revisionSchema,
    operationId: uuid,
  })
  .strict();
const entryColumns = `id,team_id AS teamId,user_id AS userId,date,end_date AS endDate,lane,title,preview,revision,updated_at AS updatedAt,
  (SELECT json_group_array(tag_id) FROM (SELECT tag_id FROM calendar_entry_tags WHERE entry_id=calendar_entries.id ORDER BY position)) AS tagIds,
  (SELECT json_group_array(tag_id) FROM (SELECT tag_id FROM calendar_entry_tags WHERE entry_id=calendar_entries.id AND checked=1 ORDER BY position)) AS checkedTagIds`;
const tagColumns = `id,team_id AS teamId,user_id AS userId,name,color,kind,revision,
  (SELECT count(*) FROM calendar_entry_tags et JOIN calendar_entries e ON e.id=et.entry_id WHERE et.tag_id=calendar_tags.id AND e.deleted_at IS NULL) AS usageCount`;
const entryJson = (row) => ({
  ...row,
  tagIds: parse(row.tagIds, []),
  checkedTagIds: parse(row.checkedTagIds, []),
});
const rangeSchema = z.object({ date: dateSchema, endDate: dateSchema });
const nextStamp = (row) =>
  new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1)).toISOString();
function validRange(data) {
  requireThat(
    data.date <= data.endDate,
    400,
    "종료일은 시작일 이후여야 합니다.",
  );
}

export function installCalendarRoutes(
  app,
  { db, teamAccess, managedTeam, taskAccess, documentImagesDir },
) {
  db.function(
    "normalize_search_text",
    { deterministic: true },
    normalizeSearchQuery,
  );
  function member(teamId, userId) {
    requireThat(
      db
        .prepare(
          "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=? AND m.user_id=? AND u.active=1",
        )
        .get(teamId, userId),
      404,
      "현재 팀의 활성 구성원을 선택하세요.",
    );
  }
  function writable(user, teamId, userId) {
    teamAccess(user, teamId);
    if (userId === null) return;
    member(teamId, userId);
    requireThat(
      canManageTeam(user, teamId) ||
        (user.id === userId && canContribute(user, teamId)),
      403,
      "본인 일정 또는 팀장 권한으로만 수정할 수 있습니다.",
    );
  }
  function entryAccess(user, id, edit = false, includeDeleted = false) {
    const row = db.prepare("SELECT * FROM calendar_entries WHERE id=?").get(id);
    requireThat(
      row && (includeDeleted || !row.deleted_at),
      404,
      "일정을 찾을 수 없습니다. 삭제되었을 수 있습니다.",
    );
    teamAccess(user, row.team_id);
    if (row.user_id !== null) member(row.team_id, row.user_id);
    if (edit) writable(user, row.team_id, row.user_id);
    return row;
  }
  function ruleFor(teamId) {
    const rule = db
      .prepare("SELECT * FROM calendar_rules WHERE team_id=?")
      .get(teamId);
    return rule
      ? {
          propertyId: rule.property_id,
          values: parse(rule.filter_values, []),
          mode: rule.filter_mode,
          revision: rule.revision,
        }
      : { propertyId: "", values: [], mode: "include", revision: 0 };
  }
  function summary(id) {
    return entryJson(
      db
        .prepare(`SELECT ${entryColumns} FROM calendar_entries WHERE id=?`)
        .get(id),
    );
  }
  function weeklyItems(teamId, userId, from, to) {
    return db
      .prepare(
        `SELECT w.user_id AS userId,w.week_start AS weekStart,w.task_id AS taskId,w.title AS savedTitle,w.imported_at AS importedAt,t.deleted_at,t.id AS found,c.value AS currentTitle
      FROM calendar_weekly_items w LEFT JOIN tasks t ON t.id=w.task_id AND t.team_id=w.team_id LEFT JOIN cells c ON c.task_id=t.id AND c.key='title'
      WHERE w.team_id=? AND w.week_start BETWEEN ? AND ?${userId ? " AND w.user_id=?" : ""}
      AND w.user_id IN (SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=? AND u.active=1)
      ORDER BY w.week_start,w.imported_at,w.task_id`,
      )
      .all(
        teamId,
        calendarWeek(from),
        calendarWeek(to),
        ...(userId ? [userId] : []),
        teamId,
      )
      .map(({ deleted_at, found, currentTitle, savedTitle, ...item }) => ({
        ...item,
        title:
          found && !deleted_at
            ? String(parse(currentTitle, savedTitle))
            : savedTitle,
        unavailable: !found || !!deleted_at,
      }));
  }
  function addWeeklyItems({ teamId, userId, weekStart }, tasks) {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO calendar_weekly_items VALUES(?,?,?,?,?,?)",
    );
    let added = 0;
    for (const task of tasks)
      added += Number(
        insert.run(
          teamId,
          userId,
          weekStart,
          task.id,
          String(parse(task.title, "제목 없음")),
          now(),
        ).changes,
      );
    return {
      added,
      existing: tasks.length - added,
      weekly: weeklyItems(teamId, userId, weekStart, weekStart),
    };
  }
  function tagsFor(teamId, userId) {
    return db
      .prepare(
        `SELECT ${tagColumns} FROM calendar_tags WHERE team_id=? AND user_id IS ? ORDER BY name,id`,
      )
      .all(teamId, userId);
  }
  const placementColumns = "id,date,end_date AS endDate,lane";
  function overlappingPlacements(teamId, userId, range) {
    return db
      .prepare(
        `SELECT ${placementColumns} FROM calendar_entries WHERE team_id=? AND user_id IS ? AND deleted_at IS NULL AND end_date>=? AND date<=?`,
      )
      .all(teamId, userId, range.date, range.endDate);
  }
  function placements(teamId, userId, ranges) {
    const found = new Map();
    const covered = [];
    const before = db.prepare(
      `SELECT ${placementColumns} FROM calendar_entries WHERE team_id=? AND user_id IS ? AND deleted_at IS NULL AND end_date>=? AND end_date<?`,
    );
    const after = db.prepare(
      `SELECT ${placementColumns} FROM calendar_entries WHERE team_id=? AND user_id IS ? AND deleted_at IS NULL AND date>? AND date<=?`,
    );
    for (const seed of ranges) {
      if (
        covered.some(
          (range) => range.date <= seed.date && range.endDate >= seed.endDate,
        )
      )
        continue;
      let date = seed.date,
        endDate = seed.endDate;
      let pending = overlappingPlacements(teamId, userId, seed);
      while (pending.length) {
        let nextDate = date,
          nextEnd = endDate;
        for (const item of pending) {
          found.set(item.id, item);
          if (item.date < nextDate) nextDate = item.date;
          if (item.endDate > nextEnd) nextEnd = item.endDate;
        }
        // Only visit the newly reached endpoint bands. Every connected entry
        // is read once per seed, including chains extending beyond the view.
        pending = [
          ...(nextDate < date
            ? before.all(teamId, userId, nextDate, date)
            : []),
          ...(nextEnd > endDate
            ? after.all(teamId, userId, endDate, nextEnd)
            : []),
        ];
        date = nextDate;
        endDate = nextEnd;
      }
      covered.push({ date, endDate });
    }
    return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  // Both the grab point and the drop target are within a <=62-day view.
  // A long card can therefore reach up to 61 days beyond either endpoint.
  function dragLayoutRange(range) {
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
      date: extend(range.date, 1 - CALENDAR_MAX_RANGE_DAYS),
      endDate: extend(range.endDate, CALENDAR_MAX_RANGE_DAYS - 1),
    };
  }
  const rowRange = (row) => ({ date: row.date, endDate: row.end_date });
  function placementResult(teamId, userId, layout, changed) {
    const previewLayout = changed
      ? placements(teamId, userId, [dragLayoutRange(changed)])
      : [];
    return {
      placements: layout.map(({ id, lane }) => ({ id, lane })),
      layout: mergeCalendarLayout(previewLayout, layout).sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    };
  }
  function savePlacement(row, range, expected) {
    const before = placements(row.team_id, row.user_id, [
      rowRange(row),
      ...(range?.date ? [range] : []),
      ...(expected ? [expected] : []),
    ]);
    const current = before.find((item) => item.id === row.id);
    const next = range
      ? placeCalendarEntry(before, { ...current, ...range })
      : compactCalendarEntries(before);
    const update = db.prepare("UPDATE calendar_entries SET lane=? WHERE id=?");
    for (let i = 0; i < next.length; i++) {
      if (next[i].lane !== before[i].lane) update.run(next[i].lane, next[i].id);
    }
    // Include unchanged positions within the affected components so a lost
    // response can be retried without fetching unrelated calendar history.
    const changed = range && next.find((item) => item.id === row.id);
    return placementResult(row.team_id, row.user_id, next, changed);
  }
  function tagSummary(id) {
    return db
      .prepare(`SELECT ${tagColumns} FROM calendar_tags WHERE id=?`)
      .get(id);
  }
  function tagIdsFor(id) {
    return db
      .prepare(
        "SELECT tag_id FROM calendar_entry_tags WHERE entry_id=? ORDER BY position",
      )
      .all(id)
      .map((row) => row.tag_id);
  }
  function validateTags(teamId, userId, ids) {
    const count = db
      .prepare(
        "SELECT count(*) AS total FROM calendar_tags WHERE team_id=? AND user_id IS ? AND id IN (SELECT value FROM json_each(?))",
      )
      .get(teamId, userId, json(ids)).total;
    requireThat(
      count === ids.length,
      400,
      "이 캘린더에 속한 태그만 지정할 수 있습니다. 태그 목록을 새로고침해 주세요.",
    );
  }
  function checkedTagIdsFor(id) {
    return db
      .prepare(
        "SELECT tag_id FROM calendar_entry_tags WHERE entry_id=? AND checked=1 ORDER BY position",
      )
      .all(id)
      .map((row) => row.tag_id);
  }
  function validateChecks(teamId, userId, ids, checkedIds) {
    requireThat(
      checkedIds.every((id) => ids.includes(id)),
      400,
      "지정된 태그만 체크할 수 있습니다.",
    );
    const count = db
      .prepare(
        "SELECT count(*) AS total FROM calendar_tags WHERE team_id=? AND user_id IS ? AND kind='check' AND id IN (SELECT value FROM json_each(?))",
      )
      .get(teamId, userId, json(checkedIds)).total;
    requireThat(
      count === checkedIds.length,
      400,
      "체크 태그만 체크할 수 있습니다.",
    );
  }
  function setTags(id, ids, checkedIds = checkedTagIdsFor(id)) {
    const checked = new Set(checkedIds);
    db.prepare("DELETE FROM calendar_entry_tags WHERE entry_id=?").run(id);
    const insert = db.prepare(
      "INSERT INTO calendar_entry_tags(entry_id,tag_id,position,checked) VALUES(?,?,?,?)",
    );
    ids.forEach((tagId, position) =>
      insert.run(id, tagId, position, Number(checked.has(tagId))),
    );
  }
  function manageTags(user, teamId, userId) {
    teamAccess(user, teamId);
    if (userId !== null) writable(user, teamId, userId);
  }
  function uniqueTag(teamId, userId, name, id) {
    requireThat(
      !db
        .prepare(
          "SELECT 1 FROM calendar_tags WHERE team_id=? AND user_id IS ? AND name=? AND id<>?",
        )
        .get(teamId, userId, name, id),
      409,
      "같은 이름의 태그가 이미 있습니다.",
    );
  }
  function document(row) {
    return {
      markdown: readDocumentVersion(db, row.version_id)?.markdown || "",
      revision: row.revision,
      updatedAt: row.updated_at,
    };
  }
  app.get("/api/calendar/preferences", (req, res) => {
    const row = db
      .prepare("SELECT weekdays FROM calendar_preferences WHERE user_id=?")
      .get(req.user.id);
    res.json({ weekdays: row ? parse(row.weekdays) : CALENDAR_DAYS });
  });
  app.put("/api/calendar/preferences", (req, res) => {
    const { weekdays } = z
      .object({
        weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      })
      .strict()
      .parse(req.body);
    const days = [...new Set(weekdays)].sort();
    db.prepare(
      "INSERT INTO calendar_preferences VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET weekdays=excluded.weekdays",
    ).run(req.user.id, json(days));
    res.json({ weekdays: days });
  });
  app.get("/api/calendar/teams/:teamId", (req, res) => {
    const team = teamAccess(req.user, req.params.teamId);
    const members = usersWithTeams(
      db,
      db
        .prepare(
          "SELECT u.* FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.team_id=? AND u.active=1 ORDER BY u.name,u.id",
        )
        .all(team.id),
    );
    const rule = ruleFor(team.id);
    res.json({
      members,
      settings: team.settings,
      rule,
      tags: db
        .prepare(
          `SELECT ${tagColumns} FROM calendar_tags WHERE team_id=? ORDER BY name,id`,
        )
        .all(team.id),
      ruleProblem: calendarRuleProblem(rule, team.settings.properties),
    });
  });
  app.get("/api/calendar/teams/:teamId/tags", (req, res) => {
    const team = teamAccess(req.user, req.params.teamId);
    const query = z
      .object({
        scope: z.enum(["personal", "team"]).default("personal"),
        userId: uuid.optional(),
      })
      .parse(req.query);
    requireThat(
      query.scope !== "team" || !query.userId,
      400,
      "팀 공용 태그에는 개인 소유자를 지정할 수 없습니다.",
    );
    const userId = query.scope === "team" ? null : query.userId || req.user.id;
    if (userId !== null) member(team.id, userId);
    res.json({ tags: tagsFor(team.id, userId) });
  });
  app.post("/api/calendar/teams/:teamId/tags", (req, res) => {
    const teamId = req.params.teamId;
    const data = tagSchema
      .extend({ id: uuid, userId: uuid.nullable().optional() })
      .strict()
      .parse(req.body);
    const userId = data.userId === undefined ? req.user.id : data.userId;
    manageTags(req.user, teamId, userId);
    const tag = transaction(db, () => {
      const existing = tagSummary(data.id);
      if (existing) {
        requireThat(
          existing.teamId === teamId &&
            existing.userId === userId &&
            existing.name === data.name &&
            existing.color === data.color &&
            existing.kind === data.kind,
          409,
          "이미 처리된 태그 요청입니다. 목록을 새로고침해 주세요.",
        );
        return existing;
      }
      uniqueTag(teamId, userId, data.name, data.id);
      requireThat(
        db
          .prepare(
            "SELECT count(*) AS total FROM calendar_tags WHERE team_id=? AND user_id IS ?",
          )
          .get(teamId, userId).total < 200,
        400,
        "태그는 각 개인·팀 공용 목록에 최대 200개까지 만들 수 있습니다.",
      );
      db.prepare(
        "INSERT INTO calendar_tags(id,team_id,user_id,name,color,kind) VALUES(?,?,?,?,?,?)",
      ).run(data.id, teamId, userId, data.name, data.color, data.kind);
      const saved = tagSummary(data.id);
      audit(
        db,
        req.user.id,
        teamId,
        "calendar-tag-create",
        data.id,
        null,
        saved,
      );
      return saved;
    });
    res.status(201).json(tag);
  });
  app.patch("/api/calendar/tags/:id", (req, res) => {
    const data = tagSchema
      .extend({
        kind: tagSchema.shape.kind.removeDefault().optional(),
        expectedRevision: revisionSchema,
      })
      .strict()
      .parse(req.body);
    const tag = transaction(db, () => {
      const before = tagSummary(req.params.id);
      requireThat(
        before,
        404,
        "태그를 찾을 수 없습니다. 삭제되었을 수 있습니다.",
      );
      manageTags(req.user, before.teamId, before.userId);
      const kind = data.kind ?? before.kind;
      const unchanged =
        before.name === data.name &&
        before.color === data.color &&
        before.kind === kind;
      requireThat(
        before.revision === data.expectedRevision || unchanged,
        409,
        "다른 사용자가 태그를 변경했습니다. 목록을 새로고침한 뒤 다시 확인하세요.",
      );
      if (unchanged) return before;
      uniqueTag(before.teamId, before.userId, data.name, before.id);
      db.prepare(
        "UPDATE calendar_tags SET name=?,color=?,kind=?,revision=revision+1 WHERE id=?",
      ).run(data.name, data.color, kind, before.id);
      if (before.kind === "check" && kind === "label")
        db.prepare(
          "UPDATE calendar_entry_tags SET checked=0 WHERE tag_id=?",
        ).run(before.id);
      const saved = tagSummary(before.id);
      audit(
        db,
        req.user.id,
        before.teamId,
        "calendar-tag-update",
        before.id,
        before,
        saved,
      );
      return saved;
    });
    res.json(tag);
  });
  app.delete("/api/calendar/tags/:id", (req, res) => {
    const { expectedRevision } = z
      .object({ expectedRevision: revisionSchema })
      .strict()
      .parse(req.body);
    transaction(db, () => {
      const tag = tagSummary(req.params.id);
      requireThat(tag, 404, "태그를 찾을 수 없습니다. 삭제되었을 수 있습니다.");
      manageTags(req.user, tag.teamId, tag.userId);
      requireThat(
        tag.revision === expectedRevision,
        409,
        "다른 사용자가 태그를 변경했습니다. 목록을 새로고침한 뒤 다시 확인하세요.",
      );
      db.prepare("DELETE FROM calendar_tags WHERE id=?").run(tag.id);
      audit(
        db,
        req.user.id,
        tag.teamId,
        "calendar-tag-delete",
        tag.id,
        tag,
        null,
      );
    });
    res.json({ ok: true });
  });
  app.put("/api/calendar/teams/:teamId/rule", (req, res) => {
    const team = managedTeam(req.user, req.params.teamId);
    const data = z
      .object({
        propertyId: z.string().min(1).max(80),
        values: propertyFilterValuesSchema,
        mode: propertyFilterModeSchema.default("include"),
        expectedRevision: revisionSchema,
      })
      .strict()
      .parse(req.body);
    const problem = calendarRuleProblem(data, team.settings.properties);
    requireThat(!problem, 400, problem);
    const rule = transaction(db, () => {
      const before = ruleFor(team.id);
      requireThat(
        before.revision === data.expectedRevision,
        409,
        "다른 사용자가 기준을 변경했습니다. 기준 창을 다시 열어 확인하세요.",
      );
      const values = [...new Set(data.values)];
      const revision = before.revision + 1;
      db.prepare(
        "INSERT INTO calendar_rules(team_id,property_id,filter_values,filter_mode,revision) VALUES(?,?,?,?,?) ON CONFLICT(team_id) DO UPDATE SET property_id=excluded.property_id,filter_values=excluded.filter_values,filter_mode=excluded.filter_mode,revision=excluded.revision",
      ).run(team.id, data.propertyId, json(values), data.mode, revision);
      const after = {
        propertyId: data.propertyId,
        values,
        mode: data.mode,
        revision,
      };
      audit(db, req.user.id, team.id, "calendar-rule", team.id, before, after);
      return after;
    });
    res.json({ rule, ruleProblem: "" });
  });
  app.get("/api/calendar", (req, res) => {
    const query = z
      .object({
        teamId: uuid,
        scope: z.enum(["personal", "team"]).default("personal"),
        userId: uuid.optional(),
        from: dateSchema,
        to: dateSchema,
      })
      .parse(req.query);
    teamAccess(req.user, query.teamId);
    requireThat(
      query.scope !== "team" || !query.userId,
      400,
      "팀 공용 일정에는 개인 소유자를 지정할 수 없습니다.",
    );
    if (query.userId) member(query.teamId, query.userId);
    requireThat(
      query.from <= query.to &&
        query.to <= addDays(query.from, CALENDAR_MAX_RANGE_DAYS - 1),
      400,
      "캘린더는 최대 62일 범위로 조회하세요.",
    );
    const args = [
      query.teamId,
      query.from,
      query.to,
      ...(query.userId ? [query.userId] : []),
    ];
    const users =
      query.scope === "team"
        ? " AND user_id IS NULL"
        : " AND user_id IN (SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=? AND u.active=1)";
    const entries = db
      .prepare(
        `SELECT ${entryColumns} FROM calendar_entries WHERE team_id=? AND deleted_at IS NULL AND end_date>=? AND date<=?${query.userId ? " AND user_id=?" : ""}${users} ORDER BY date,updated_at,id`,
      )
      .all(...args, ...(query.scope === "team" ? [] : [query.teamId]))
      .map(entryJson);
    const weekly =
      query.scope === "team"
        ? []
        : weeklyItems(query.teamId, query.userId, query.from, query.to);
    const viewRange = entries.reduce(
      (range, item) => ({
        date: item.date < range.date ? item.date : range.date,
        endDate: item.endDate > range.endDate ? item.endDate : range.endDate,
      }),
      { date: query.from, endDate: query.to },
    );
    const layout =
      query.userId || query.scope === "team"
        ? placements(
            query.teamId,
            query.scope === "team" ? null : query.userId,
            [entries.length ? dragLayoutRange(viewRange) : viewRange],
          )
        : [];
    res.json({ entries, weekly, layout });
  });
  app.get("/api/calendar/tasks", (req, res) => {
    const query = weeklyScopeSchema
      .extend({
        q: z.string().max(120).default(""),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .parse(req.query);
    teamAccess(req.user, query.teamId);
    member(query.teamId, query.userId);
    // Manual selection spans years, statuses and assignees so past omissions
    // and future plans can refer to the same original task.
    const rows = db
      .prepare(
        `SELECT t.id,t.years,c.value AS title,
      EXISTS(SELECT 1 FROM calendar_weekly_items w WHERE w.team_id=t.team_id AND w.user_id=? AND w.week_start=? AND w.task_id=t.id) AS added
      FROM tasks t LEFT JOIN cells c ON c.task_id=t.id AND c.key='title'
        WHERE t.team_id=? AND t.deleted_at IS NULL AND instr(normalize_search_text(COALESCE(json_extract(c.value,'$'),'')),?)>0
      ORDER BY t.position,t.id LIMIT 51 OFFSET ?`,
      )
      .all(
        query.userId,
        query.weekStart,
        query.teamId,
        normalizeSearchQuery(query.q),
        query.offset,
      );
    res.json({
      tasks: rows.slice(0, 50).map((row) => ({
        id: row.id,
        title: String(parse(row.title, "제목 없음")),
        years: parse(row.years, []),
        added: !!row.added,
      })),
      nextOffset: rows.length > 50 ? query.offset + 50 : null,
    });
  });
  app.post("/api/calendar/weekly", (req, res) => {
    const data = weeklyScopeSchema
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
      .strict()
      .parse(req.body);
    writable(req.user, data.teamId, data.userId);
    const result = transaction(db, () => {
      const tasks = db
        .prepare(
          `SELECT t.id,c.value AS title FROM tasks t LEFT JOIN cells c ON c.task_id=t.id AND c.key='title'
        WHERE t.team_id=? AND t.deleted_at IS NULL AND t.id IN (SELECT value FROM json_each(?))`,
        )
        .all(data.teamId, json(data.taskIds));
      requireThat(
        tasks.length === data.taskIds.length,
        400,
        "삭제되었거나 다른 팀의 업무가 포함되어 있습니다. 업무 목록을 다시 확인하세요.",
      );
      const byId = new Map(tasks.map((task) => [task.id, task]));
      return addWeeklyItems(
        data,
        data.taskIds.map((id) => byId.get(id)),
      );
    });
    res.json(result);
  });
  app.post("/api/calendar/import", (req, res) => {
    const data = weeklyScopeSchema.strict().parse(req.body);
    writable(req.user, data.teamId, data.userId);
    requireThat(
      data.weekStart === calendarWeek(todayKey()),
      400,
      "조건에 따른 가져오기는 이번 주에만 가능합니다. 다른 주에는 업무 추가에서 직접 선택하세요.",
    );
    const team = teamAccess(req.user, data.teamId);
    const rule = ruleFor(team.id);
    const problem = calendarRuleProblem(rule, team.settings.properties);
    requireThat(!problem, 400, problem);
    // The owner field fixes the scope before applying the configurable rule.
    // Supporting or reviewing a task does not make it an owned task.
    const candidates = db
      .prepare(
        `SELECT t.id,t.years,c.value AS filter_value,o.value AS owner,n.value AS title
      FROM tasks t LEFT JOIN cells c ON c.task_id=t.id AND c.key=?
      LEFT JOIN cells o ON o.task_id=t.id AND o.key='owner'
      LEFT JOIN cells n ON n.task_id=t.id AND n.key='title'
      WHERE t.team_id=? AND t.deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM json_each(t.years) y WHERE y.value IN (?,?))`,
      )
      .all(
        rule.propertyId,
        team.id,
        Number(data.weekStart.slice(0, 4)),
        Number(addDays(data.weekStart, 6).slice(0, 4)),
      );
    let unassigned = 0;
    const matched = candidates.filter((task) => {
      if (
        !matchesPropertyFilter(
          parse(task.filter_value, "") ?? "",
          rule.values,
          rule.mode,
        )
      )
        return false;
      const owner = parse(task.owner, "");
      if (!owner) unassigned++;
      return owner === data.userId;
    });
    const result = transaction(db, () => addWeeklyItems(data, matched));
    res.json({
      weekStart: data.weekStart,
      weekEnd: addDays(data.weekStart, 6),
      annualWeek: addDays(data.weekStart, 1),
      matched: matched.length,
      ...result,
      unassigned,
    });
  });
  app.post("/api/calendar/entries", (req, res) => {
    const data = scopeSchema
      .extend({
        userId: uuid.nullable(),
        id: uuid,
        date: dateSchema,
        endDate: dateSchema.optional(),
        title: titleSchema,
        tagIds: tagIdsSchema.default([]),
        checkedTagIds: tagIdsSchema.default([]),
      })
      .strict()
      .parse(req.body);
    writable(req.user, data.teamId, data.userId);
    const endDate = data.endDate || data.date;
    validRange({ date: data.date, endDate });
    const entry = transaction(db, () => {
      validateTags(data.teamId, data.userId, data.tagIds);
      validateChecks(data.teamId, data.userId, data.tagIds, data.checkedTagIds);
      const previous = db
        .prepare("SELECT * FROM calendar_entries WHERE id=?")
        .get(data.id);
      if (previous) {
        requireThat(
          !previous.deleted_at &&
            previous.team_id === data.teamId &&
            previous.user_id === data.userId &&
            previous.date === data.date &&
            previous.end_date === endDate &&
            previous.title === data.title &&
            json(tagIdsFor(previous.id)) === json(data.tagIds) &&
            json([...checkedTagIdsFor(previous.id)].sort()) ===
              json([...data.checkedTagIds].sort()),
          409,
          "이 일정 요청은 이미 처리되었습니다. 일정을 다시 확인하세요.",
        );
      } else {
        db.prepare(
          "INSERT INTO calendar_entries(id,team_id,user_id,date,end_date,lane,title,updated_at,actor_id) VALUES(?,?,?,?,?,?,?,?,?)",
        ).run(
          data.id,
          data.teamId,
          data.userId,
          data.date,
          endDate,
          firstCalendarLane(
            overlappingPlacements(data.teamId, data.userId, {
              date: data.date,
              endDate,
            }),
            { date: data.date, endDate },
          ),
          data.title,
          now(),
          req.user.id,
        );
        setTags(data.id, data.tagIds, data.checkedTagIds);
      }
      return summary(data.id);
    });
    res.status(201).json(entry);
  });
  app.get("/api/calendar/entries/:id", (req, res) => {
    const row = entryAccess(req.user, req.params.id);
    const previous =
      req.query.from !== undefined || req.query.to !== undefined
        ? rangeSchema.parse({ date: req.query.from, endDate: req.query.to })
        : null;
    if (previous) validRange(previous);
    res.json({
      ...summary(row.id),
      ...(req.query.placements === "1"
        ? {
            ...placementResult(
              row.team_id,
              row.user_id,
              placements(row.team_id, row.user_id, [
                rowRange(row),
                ...(previous ? [previous] : []),
              ]),
              rowRange(row),
            ),
          }
        : {}),
    });
  });
  app.patch("/api/calendar/entries/:id", (req, res) => {
    const data = z
      .union([
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
        z
          .object({ tagIds: tagIdsSchema, expectedTagIds: tagIdsSchema })
          .strict(),
      ])
      .parse(req.body);
    const row = entryAccess(req.user, req.params.id, true);
    if ("lane" in data) {
      requireThat(
        (row.lane === data.expectedLane || row.lane === data.lane) &&
          row.date === data.expectedDate &&
          row.end_date === data.expectedEndDate,
        409,
        "다른 사용자가 일정 위치나 기간을 변경했습니다. 최신 위치를 확인하세요.",
        {
          currentRange: {
            date: row.date,
            endDate: row.end_date,
            lane: row.lane,
          },
        },
      );
      const saved = transaction(db, () => {
        const positions = savePlacement(row, { lane: data.lane });
        return { ...summary(row.id), ...positions };
      });
      return res.json(saved);
    }
    if ("tagIds" in data) {
      const saved = transaction(db, () => {
        validateTags(row.team_id, row.user_id, data.tagIds);
        const before = tagIdsFor(row.id);
        requireThat(
          json(before) === json(data.expectedTagIds) ||
            json(before) === json(data.tagIds),
          409,
          "다른 사용자가 일정 태그를 변경했습니다. 최신 태그를 확인하고 다시 선택하세요.",
          {
            currentTagIds: before,
            currentCheckedTagIds: checkedTagIdsFor(row.id),
          },
        );
        if (json(before) !== json(data.tagIds)) {
          setTags(row.id, data.tagIds);
          db.prepare("UPDATE calendar_entries SET updated_at=? WHERE id=?").run(
            nextStamp(row),
            row.id,
          );
        }
        return summary(row.id);
      });
      return res.json(saved);
    }
    if ("date" in data) {
      validRange(data);
      requireThat(
        (row.date === data.expectedDate &&
          row.end_date === data.expectedEndDate) ||
          (row.date === data.date && row.end_date === data.endDate),
        409,
        "다른 사용자가 일정 기간을 수정했습니다. 최신 기간을 확인하세요.",
        { currentRange: { date: row.date, endDate: row.end_date } },
      );
      const saved = transaction(db, () => {
        const positions = savePlacement(
          row,
          {
            date: data.date,
            endDate: data.endDate,
          },
          { date: data.expectedDate, endDate: data.expectedEndDate },
        );
        if (row.date !== data.date || row.end_date !== data.endDate)
          db.prepare(
            "UPDATE calendar_entries SET date=?,end_date=?,updated_at=? WHERE id=?",
          ).run(data.date, data.endDate, nextStamp(row), row.id);
        return { ...summary(row.id), ...positions };
      });
      return res.json(saved);
    }
    requireThat(
      row.title === data.expectedTitle || row.title === data.title,
      409,
      "다른 사용자가 제목을 수정했습니다. 입력을 복사한 뒤 일정을 다시 열어 확인하세요.",
      { currentTitle: row.title },
    );
    db.prepare(
      "UPDATE calendar_entries SET title=?,updated_at=? WHERE id=?",
    ).run(data.title, nextStamp(row), row.id);
    res.json(summary(row.id));
  });
  app.patch("/api/calendar/entries/:id/tags/:tagId", (req, res) => {
    const data = z
      .object({ checked: z.boolean(), expectedChecked: z.boolean() })
      .strict()
      .parse(req.body);
    const tagId = uuid.parse(req.params.tagId);
    const saved = transaction(db, () => {
      const entry = entryAccess(req.user, req.params.id, true);
      const tag = db
        .prepare(
          "SELECT t.kind,et.checked FROM calendar_entry_tags et JOIN calendar_tags t ON t.id=et.tag_id WHERE et.entry_id=? AND et.tag_id=? AND t.team_id=? AND t.user_id IS ?",
        )
        .get(entry.id, tagId, entry.team_id, entry.user_id);
      requireThat(
        tag,
        409,
        "일정에서 태그가 제거되었습니다. 일정을 다시 열어 확인하세요.",
      );
      requireThat(tag.kind === "check", 400, "체크 태그만 체크할 수 있습니다.");
      requireThat(
        Boolean(tag.checked) === data.expectedChecked ||
          Boolean(tag.checked) === data.checked,
        409,
        "체크 상태가 변경되었습니다. 일정을 다시 열어 확인하세요.",
      );
      let updatedAt = entry.updated_at;
      if (Boolean(tag.checked) !== data.checked) {
        db.prepare(
          "UPDATE calendar_entry_tags SET checked=? WHERE entry_id=? AND tag_id=?",
        ).run(Number(data.checked), entry.id, tagId);
        updatedAt = nextStamp(entry);
        db.prepare("UPDATE calendar_entries SET updated_at=? WHERE id=?").run(
          updatedAt,
          entry.id,
        );
      }
      return { tagId, checked: data.checked, updatedAt };
    });
    res.json(saved);
  });
  app.delete("/api/calendar/entries/:id", (req, res) => {
    const data = z
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
      .strict()
      .parse(req.body);
    const result = transaction(db, () => {
      const row = entryAccess(req.user, req.params.id, true, true);
      // The request ID also survives restoration: an old delete retry must
      // never delete an entry that was already brought back with Undo.
      if (row.deleted_at || row.deletion_id === data.deletionId) {
        requireThat(
          row.deleted_at && row.deletion_id === data.deletionId,
          409,
          "이미 삭제되었거나 복구된 일정입니다. 일정을 다시 확인하세요.",
        );
        return { deletionId: row.deletion_id, ...savePlacement(row) };
      }
      requireThat(
        row.updated_at === data.expectedUpdatedAt &&
          row.revision === data.expectedRevision &&
          row.title === data.expectedTitle &&
          row.date === data.expectedDate &&
          row.end_date === data.expectedEndDate &&
          json(tagIdsFor(row.id)) === json(data.expectedTagIds) &&
          json([...checkedTagIdsFor(row.id)].sort()) ===
            json([...data.expectedCheckedTagIds].sort()),
        409,
        "다른 사용자가 일정을 수정했습니다. 다시 열어 확인하세요.",
      );
      const stamp = nextStamp(row);
      db.prepare(
        "UPDATE calendar_entries SET deleted_at=?,deletion_id=?,updated_at=? WHERE id=?",
      ).run(stamp, data.deletionId, stamp, row.id);
      return { deletionId: data.deletionId, ...savePlacement(row) };
    });
    res.json({ ok: true, ...result });
  });
  app.post("/api/calendar/entries/:id/restore", (req, res) => {
    const data = z
      .object({ deletionId: uuid, previousRange: rangeSchema.optional() })
      .strict()
      .parse(req.body);
    if (data.previousRange) validRange(data.previousRange);
    const result = transaction(db, () => {
      const row = entryAccess(req.user, req.params.id, true, true);
      requireThat(
        row.deletion_id === data.deletionId,
        409,
        "이후 삭제 이력이 있어 되돌릴 수 없습니다. 일정을 다시 확인하세요.",
      );
      if (row.deleted_at) {
        db.prepare(
          "UPDATE calendar_entries SET deleted_at=NULL,updated_at=? WHERE id=?",
        ).run(nextStamp(row), row.id);
        // Give the restored card priority at its old row, then pack overlaps.
        const positions = savePlacement(
          row,
          { lane: row.lane },
          data.previousRange,
        );
        return { ...summary(row.id), ...positions };
      }
      // A lost restore response may be retried after another edit. Return the
      // latest values and positions without replaying the old arrangement.
      return {
        ...summary(row.id),
        ...placementResult(
          row.team_id,
          row.user_id,
          placements(row.team_id, row.user_id, [
            rowRange(row),
            ...(data.previousRange ? [data.previousRange] : []),
          ]),
          rowRange(row),
        ),
      };
    });
    res.json(result);
  });
  app.get("/api/calendar/entries/:id/document", (req, res) =>
    res.json(document(entryAccess(req.user, req.params.id))),
  );
  app.put("/api/calendar/entries/:id/document", (req, res) => {
    const data = saveSchema.parse(req.body);
    const result = transaction(db, () => {
      const row = entryAccess(req.user, req.params.id, true);
      const current = document(row);
      const hash = createHash("sha256")
        .update(JSON.stringify(data))
        .digest("hex");
      const replay =
        row.operation_id === data.operationId &&
        row.actor_id === req.user.id &&
        row.request_hash === hash;
      requireThat(
        replay || current.revision === data.expectedRevision,
        409,
        "다른 사용자가 일정을 수정했습니다. 입력은 보존됩니다. 최신 문서를 확인하세요.",
        { current },
      );
      if (!replay && current.markdown !== data.markdown) {
        validateDocumentImages(data.markdown, row.team_id, documentImagesDir);
        const version = storeDocumentVersion(db, {
          teamId: row.team_id,
          documentId: `calendar:${row.id}`,
          markdown: data.markdown,
          actorId: req.user.id,
        });
        const preview = data.markdown
          .replace(/!\[[^\]]*\]\([^)]*\)/g, "[이미지]")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
          .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "")
          .replace(/[#*`>\[\]_~|]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 160);
        db.prepare(
          "UPDATE calendar_entries SET version_id=?,preview=?,revision=revision+1,updated_at=?,actor_id=?,operation_id=?,request_hash=? WHERE id=?",
        ).run(
          version,
          preview,
          nextStamp(row),
          req.user.id,
          data.operationId,
          hash,
          row.id,
        );
        pruneDocumentVersions(
          db,
          row.team_id,
          row.version_id ? [row.version_id] : [],
        );
      }
      return {
        ...document(entryAccess(req.user, row.id)),
        entry: summary(row.id),
      };
    });
    res.json(result);
  });
  app.get("/api/calendar/tasks/:id", (req, res) =>
    res.json({ task: taskAccess(req.user, req.params.id) }),
  );
  return {
    calendarImageAccess: (req) =>
      entryAccess(req.user, req.params.id, true).team_id,
  };
}
