import { z } from "zod";
import { dateSchema } from "../server/validation.mjs";
import {
  canContribute,
  canManageTeam,
  propertiesFor,
  matchesPropertyFilter,
  todayKey,
} from "../shared/domain.js";
import {
  addDays,
  calendarWeek,
  calendarRuleProblem,
  nextCalendarCopyTitle,
  CALENDAR_DAYS,
} from "../shared/calendar.js";
import {
  firstCalendarLane,
  placeCalendarEntry,
  compactCalendarEntries,
} from "../shared/calendar-layout.js";
import { CALENDAR_TAG_COLORS } from "../shared/calendar-tags.js";
import { equal } from "../server/sync/protocol.mjs";
import { assert } from "./access.mjs";
import { controlTransaction } from "./data.mjs";
import { userRecord } from "./control.mjs";
import { taskList, taskView, settingsFor, stamp } from "./tasks.mjs";
const idSchema = z.string().uuid();
const titleSchema = z.string().trim().min(1).max(120);
function validRange(date, endDate) {
  dateSchema.parse(date);
  dateSchema.parse(endDate);
  assert(
    date <= endDate && endDate <= addDays(date, 61),
    400,
    "일정은 최대 62일 범위로 지정하세요.",
  );
}
async function writable(ctx, teamId, userId) {
  await ctx.team(teamId);
  assert(
    userId === null ||
      canManageTeam(ctx.user, teamId) ||
      (userId === ctx.user.id && canContribute(ctx.user, teamId)),
    403,
    "일정을 편집할 권한이 없습니다.",
  );
}
export async function entryView(s, row) {
  const p = row.payload,
    doc = await s.get("document", ["calendar", row.key[0], "main"]);
  return {
    id: row.key[0],
    teamId: s.teamId,
    userId: p.userId,
    date: p.date,
    endDate: p.endDate,
    lane: p.lane,
    title: p.title,
    preview: ((!doc?.deleted && doc?.payload.markdown) || "")
      .replace(/\s+/g, " ")
      .slice(0, 240),
    revision: doc?.revision || 0,
    updatedAt: stamp(row),
    tagIds: (p.tags || []).map((t) => t.id),
    checkedTagIds: (p.tags || []).filter((t) => t.checked).map((t) => t.id),
  };
}
async function layout(s, userId) {
  return (await s.list("calendar"))
    .filter((r) => r.payload.userId === userId && !r.payload.deletedAt)
    .map((r) => ({
      id: r.key[0],
      date: r.payload.date,
      endDate: r.payload.endDate,
      lane: r.payload.lane,
    }));
}
async function placementResult(s, userId) {
  const all = await layout(s, userId);
  return { placements: all.map(({ id, lane }) => ({ id, lane })), layout: all };
}
async function tagsFor(s, userId) {
  const entries = await s.list("calendar");
  return (await s.list("tag"))
    .filter((t) => userId === undefined || t.payload.userId === userId)
    .map((t) => ({
      id: t.key[0],
      teamId: s.teamId,
      ...t.payload,
      revision: t.revision,
      usageCount: entries.filter(
        (e) =>
          !e.payload.deletedAt && e.payload.tags.some((x) => x.id === t.key[0]),
      ).length,
    }));
}
async function checkedTags(s, userId, ids, checked = []) {
  assert(
    Array.isArray(ids) &&
      ids.length <= 20 &&
      new Set(ids).size === ids.length &&
      checked.every((id) => ids.includes(id)),
    400,
    "일정 태그를 확인하세요.",
  );
  const tags = [];
  for (const id of ids) {
    const t = await s.get("tag", [id]);
    assert(
      t && !t.deleted && t.payload.userId === userId,
      400,
      "같은 소유자의 태그를 선택하세요.",
    );
    assert(
      !checked.includes(id) || t.payload.kind === "check",
      400,
      "체크 태그만 체크할 수 있습니다.",
    );
    tags.push({ id, checked: checked.includes(id) });
  }
  return tags;
}
async function weekly(s, userId, from, to) {
  const list = [];
  for (const r of await s.list("weekly")) {
    if (
      (userId && r.key[0] !== userId) ||
      (from && r.key[1] < calendarWeek(from)) ||
      (to && r.key[1] > to)
    )
      continue;
    const t = await s.get("task", [r.key[2]]),
      title = await s.get("cell", [r.key[2], "title"]);
    list.push({
      userId: r.key[0],
      weekStart: r.key[1],
      taskId: r.key[2],
      title:
        t && !t.deleted && !t.payload.deletedAt
          ? String(title?.payload.value || r.payload.title)
          : r.payload.title,
      importedAt: stamp(r),
      unavailable: !t || t.deleted || !!t.payload.deletedAt,
    });
  }
  return list;
}
export async function calendarRoutes(ctx, path, method, body, query) {
  if (path === "/calendar/preferences")
    return controlTransaction(
      ctx.env,
      async (tx) => {
        if (method === "PUT") {
          const weekdays = [
            ...new Set(
              z
                .array(z.number().int().min(0).max(6))
                .min(1)
                .max(7)
                .parse(body.weekdays),
            ),
          ].sort();
          await tx.query(
            "INSERT INTO control_preferences(user_id,payload) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET payload=EXCLUDED.payload",
            [ctx.user.id, JSON.stringify({ weekdays })],
          );
          return { weekdays };
        }
        const r = (
          await tx.query(
            "SELECT payload FROM control_preferences WHERE user_id=$1",
            [ctx.user.id],
          )
        ).rows[0];
        return r ? JSON.parse(r.payload) : { weekdays: CALENDAR_DAYS };
      },
      { write: method === "PUT" },
    );
  const team = /^\/calendar\/teams\/([^/]+)(?:\/(tags|rule))?$/.exec(path);
  if (team) {
    const teamId = team[1];
    await ctx.team(teamId);
    const userId =
      body.userId === null || query.get("scope") === "team"
        ? null
        : body.userId || query.get("userId") || ctx.user.id;
    if (method !== "GET") await writable(ctx, teamId, userId);
    if (team[2] === "rule")
      assert(
        canManageTeam(ctx.user, teamId),
        403,
        "팀장만 가져오기 기준을 바꿀 수 있습니다.",
      );
    return ctx.data(
      teamId,
      async (s) => {
        if (!team[2]) {
          const settings = await settingsFor(s),
            r = await s.get("rule", []),
            rule = {
              propertyId: "status",
              values: [],
              mode: "include",
              ...r?.payload,
              revision: r?.revision || 0,
            };
          const members = await controlTransaction(ctx.env, async (tx) =>
            Promise.all(
              (
                await tx.query(
                  "SELECT u.* FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.team_id=$1 AND u.active=TRUE ORDER BY u.name",
                  [teamId],
                )
              ).rows.map((r) => userRecord(tx, r)),
            ),
          );
          const known = new Set(members.map((m) => m.id));
          for (const p of await s.list("person"))
            if (!known.has(p.key[0]))
              members.push({
                id: p.key[0],
                name: p.payload.name,
                active: false,
                systemRole: "user",
                teamIds: [],
                teamRoles: {},
              });
          return {
            members,
            settings,
            rule,
            tags: await tagsFor(s),
            ruleProblem: calendarRuleProblem(rule, settings.properties),
          };
        }
        if (team[2] === "tags") {
          if (method === "GET") return { tags: await tagsFor(s, userId) };
          const id = idSchema.parse(body.id),
            name = z.string().trim().min(1).max(40).parse(body.name),
            color = body.color || "default",
            kind = body.kind || "label";
          assert(
            CALENDAR_TAG_COLORS.some((c) => c.id === color) &&
              ["check", "label"].includes(kind),
            400,
            "태그 색상과 종류를 확인하세요.",
          );
          const tags = await tagsFor(s, userId);
          assert(
            !tags.some(
              (t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase(),
            ) && tags.length < 200,
            409,
            "같은 이름의 태그가 있거나 목록이 가득 찼습니다.",
          );
          const previous = await s.get("tag", [id]);
          assert(
            !previous || equal(previous.payload, { userId, name, color, kind }),
            409,
            "태그 생성 요청이 변경되었습니다.",
          );
          const row = await s.put("tag", [id], { userId, name, color, kind });
          return {
            id,
            teamId,
            ...row.payload,
            revision: row.revision,
            usageCount: 0,
          };
        }
        const current = await s.get("rule", []);
        assert(
          (current?.revision || 0) === body.expectedRevision,
          409,
          "가져오기 기준이 변경되었습니다.",
        );
        const rule = {
          propertyId: body.propertyId,
          values: body.values,
          mode: body.mode,
        };
        assert(
          Array.isArray(rule.values) &&
            ["include", "exclude"].includes(rule.mode),
          400,
          "가져오기 기준을 확인하세요.",
        );
        const problem = calendarRuleProblem(
          rule,
          (await settingsFor(s)).properties,
        );
        assert(!problem, 400, problem);
        const row = await s.put("rule", [], rule);
        return { ...row.payload, revision: row.revision };
      },
      { write: method !== "GET", allowViewer: true, body, action: "calendar" },
    );
  }
  const tag = /^\/calendar\/tags\/([^/]+)$/.exec(path);
  if (tag) {
    const { teamId, row } = await ctx.locate("tag", tag[1]);
    await writable(ctx, teamId, row.payload.userId);
    return ctx.data(
      teamId,
      async (s) => {
        const t = await s.get("tag", [tag[1]]);
        assert(
          t.revision === body.expectedRevision,
          409,
          "태그가 변경되었습니다.",
        );
        if (method === "DELETE") {
          for (const e of await s.list("calendar"))
            if (e.payload.tags.some((x) => x.id === tag[1]))
              await s.put("calendar", e.key, {
                ...e.payload,
                tags: e.payload.tags.filter((x) => x.id !== tag[1]),
              });
          await s.put("tag", t.key, t.payload, { deleted: true });
          return { ok: true };
        }
        const next = {
          ...t.payload,
          ...Object.fromEntries(
            ["name", "color", "kind"]
              .filter((k) => body[k] !== undefined)
              .map((k) => [k, body[k]]),
          ),
        };
        z.string().trim().min(1).max(40).parse(next.name);
        assert(
          CALENDAR_TAG_COLORS.some((c) => c.id === next.color) &&
            ["check", "label"].includes(next.kind),
          400,
          "태그를 확인하세요.",
        );
        assert(
          !(await tagsFor(s, next.userId)).some(
            (x) =>
              x.id !== tag[1] &&
              x.name.toLowerCase() === next.name.toLowerCase(),
          ),
          409,
          "같은 이름의 태그가 있습니다.",
        );
        const saved = await s.put("tag", t.key, next);
        if (next.kind === "label")
          for (const e of await s.list("calendar"))
            if (e.payload.tags.some((x) => x.id === tag[1] && x.checked))
              await s.put("calendar", e.key, {
                ...e.payload,
                tags: e.payload.tags.map((x) =>
                  x.id === tag[1] ? { ...x, checked: false } : x,
                ),
              });
        return {
          id: tag[1],
          teamId,
          ...saved.payload,
          revision: saved.revision,
          usageCount: 0,
        };
      },
      { write: true, allowViewer: true, body, action: "calendar-tag" },
    );
  }
  if (path === "/calendar" && method === "GET") {
    const teamId = query.get("teamId"),
      from = dateSchema.parse(query.get("from")),
      to = dateSchema.parse(query.get("to"));
    validRange(from, to);
    assert(
      !(query.get("scope") === "team" && query.get("userId")),
      400,
      "공용 일정에는 개인 소유자를 지정할 수 없습니다.",
    );
    return ctx.data(teamId, async (s) => {
      const rows = (await s.list("calendar")).filter(
        (r) =>
          !r.payload.deletedAt &&
          (query.get("scope") === "team"
            ? r.payload.userId === null
            : r.payload.userId !== null) &&
          (!query.get("userId") || r.payload.userId === query.get("userId")) &&
          r.payload.date <= to &&
          r.payload.endDate >= from,
      );
      return {
        entries: await Promise.all(rows.map((r) => entryView(s, r))),
        weekly:
          query.get("scope") === "team"
            ? []
            : await weekly(s, query.get("userId"), from, to),
        layout:
          query.get("scope") === "team" || query.get("userId")
            ? await layout(
                s,
                query.get("scope") === "team" ? null : query.get("userId"),
              )
            : [],
      };
    });
  }
  if (path === "/calendar/tasks" && method === "GET")
    return ctx.data(query.get("teamId"), async (s) => {
      const tasks = (await taskList(s)).filter((t) =>
          String(t.cells.title?.value || "")
            .toLowerCase()
            .includes((query.get("q") || "").trim().toLowerCase()),
        ),
        items = await weekly(
          s,
          query.get("userId"),
          query.get("weekStart"),
          query.get("weekStart"),
        ),
        offset = Math.max(0, Number(query.get("offset") || 0));
      return {
        tasks: tasks.slice(offset, offset + 50).map((t) => ({
          id: t.id,
          title: String(t.cells.title?.value || "제목 없음"),
          years: t.years,
          added: items.some((w) => w.taskId === t.id),
        })),
        nextOffset: offset + 50 < tasks.length ? offset + 50 : null,
      };
    });
  if (
    ["/calendar/weekly", "/calendar/import"].includes(path) &&
    method === "POST"
  ) {
    await writable(ctx, body.teamId, body.userId);
    dateSchema.parse(body.weekStart);
    assert(
      calendarWeek(body.weekStart) === body.weekStart,
      400,
      "주 시작일을 확인하세요.",
    );
    return ctx.data(
      body.teamId,
      async (s) => {
        let ids = body.taskIds;
        if (path.endsWith("/import")) {
          assert(
            body.weekStart === calendarWeek(todayKey()),
            400,
            "조건 가져오기는 이번 주에만 가능합니다.",
          );
          const r = await s.get("rule", []),
            rule = r?.payload || {
              propertyId: "status",
              values: [],
              mode: "include",
            },
            settings = await settingsFor(s);
          assert(
            !calendarRuleProblem(rule, settings.properties),
            400,
            "가져오기 기준을 확인하세요.",
          );
          ids = (await taskList(s))
            .filter(
              (t) =>
                t.cells.owner?.value === body.userId &&
                matchesPropertyFilter(
                  t.cells[rule.propertyId]?.value || "",
                  rule.values,
                  rule.mode,
                ),
            )
            .map((t) => t.id);
        }
        assert(
          Array.isArray(ids) &&
            ids.length <= 20000 &&
            new Set(ids).size === ids.length,
          400,
          "업무 목록을 확인하세요.",
        );
        let added = 0;
        for (const id of ids) {
          const task = await s.get("task", [id]);
          assert(
            task && !task.deleted && !task.payload.deletedAt,
            400,
            "다른 팀 또는 삭제된 업무입니다.",
          );
          const key = [body.userId, body.weekStart, id];
          if (!(await s.get("weekly", key))) {
            await s.put("weekly", key, {
              title: String(
                (await s.get("cell", [id, "title"]))?.payload.value ||
                  "제목 없음",
              ),
            });
            added++;
          }
        }
        return {
          added,
          existing: ids.length - added,
          weekly: await weekly(s, body.userId, body.weekStart, body.weekStart),
          weekStart: body.weekStart,
          weekEnd: addDays(body.weekStart, 6),
          annualWeek: addDays(body.weekStart, 1),
          matched: ids.length,
          unassigned: 0,
        };
      },
      { write: true, body, action: "calendar-weekly" },
    );
  }
  if (path === "/calendar/entries" && method === "POST") {
    const teamId = body.teamId,
      userId = body.userId;
    assert(
      userId === null || typeof userId === "string",
      400,
      "일정 소유자를 확인하세요.",
    );
    await writable(ctx, teamId, userId);
    const id = idSchema.parse(body.id),
      date = dateSchema.parse(body.date),
      endDate = body.endDate || date,
      title = titleSchema.parse(body.title);
    validRange(date, endDate);
    return ctx.data(
      teamId,
      async (s) => {
        const tags = await checkedTags(
            s,
            userId,
            body.tagIds || [],
            body.checkedTagIds || [],
          ),
          previous = await s.get("calendar", [id]);
        if (previous) {
          assert(
            !previous.deleted &&
              equal(
                { ...previous.payload, lane: 0 },
                {
                  userId,
                  date,
                  endDate,
                  lane: 0,
                  title,
                  tags,
                  deletedAt: null,
                },
              ),
            409,
            "일정 생성 요청이 변경되었습니다.",
          );
          return entryView(s, previous);
        }
        const lane = firstCalendarLane(await layout(s, userId), {
            date,
            endDate,
          }),
          row = await s.put("calendar", [id], {
            userId,
            date,
            endDate,
            lane,
            title,
            tags,
            deletedAt: null,
          });
        return entryView(s, row);
      },
      { write: true, allowViewer: true, body, action: "calendar-create" },
    );
  }
  const entry =
    /^\/calendar\/entries\/([^/]+)(?:\/(copy|restore)|\/tags\/([^/]+))?$/.exec(
      path,
    );
  if (entry) {
    const { teamId, row: found } = await ctx.locate("calendar", entry[1]);
    if (method !== "GET") await writable(ctx, teamId, found.payload.userId);
    return ctx.data(
      teamId,
      async (s) => {
        let row = await s.get("calendar", [entry[1]]);
        const p = row.payload;
        assert(
          !p.deletedAt || entry[2] === "restore" || method === "DELETE",
          404,
          "삭제된 일정입니다.",
        );
        if (method === "GET")
          return {
            ...(await entryView(s, row)),
            ...(query.get("placements") === "1"
              ? await placementResult(s, p.userId)
              : {}),
          };
        if (entry[2] === "copy") {
          const id = idSchema.parse(body.id),
            old = await s.get("calendar", [id]);
          if (old) return entryView(s, old);
          const title = nextCalendarCopyTitle(
            p.title,
            (await s.list("calendar"))
              .filter(
                (e) => e.payload.userId === p.userId && !e.payload.deletedAt,
              )
              .map((e) => e.payload.title),
          );
          const saved = await s.put("calendar", [id], {
            ...p,
            title,
            lane: firstCalendarLane(await layout(s, p.userId), p),
          });
          return entryView(s, saved);
        }
        if (entry[3]) {
          const tag = await s.get("tag", [entry[3]]),
            selected = p.tags.find((t) => t.id === entry[3]);
          assert(
            selected && tag?.payload.kind === "check",
            409,
            "체크 태그가 제거되었습니다.",
          );
          assert(
            selected.checked === body.expectedChecked ||
              selected.checked === body.checked,
            409,
            "체크 상태가 변경되었습니다.",
          );
          row = await s.put("calendar", row.key, {
            ...p,
            tags: p.tags.map((t) =>
              t.id === entry[3]
                ? { ...t, checked: z.boolean().parse(body.checked) }
                : t,
            ),
          });
          return {
            tagId: entry[3],
            checked: body.checked,
            updatedAt: stamp(row),
          };
        }
        if (method === "DELETE") {
          const deletion = await s.get("calendarDeletion", row.key);
          if (p.deletedAt) {
            assert(
              deletion?.payload.id === body.deletionId,
              409,
              "삭제 상태가 변경되었습니다.",
            );
            return {
              ok: true,
              deletionId: body.deletionId,
              ...(await placementResult(s, p.userId)),
            };
          }
          const view = await entryView(s, row);
          assert(
            stamp(row) === body.expectedUpdatedAt &&
              view.revision === body.expectedRevision &&
              p.title === body.expectedTitle &&
              p.date === body.expectedDate &&
              p.endDate === body.expectedEndDate &&
              equal(view.tagIds, body.expectedTagIds) &&
              equal(
                [...view.checkedTagIds].sort(),
                [...(body.expectedCheckedTagIds || [])].sort(),
              ),
            409,
            "다른 사용자가 일정을 수정했습니다.",
          );
          idSchema.parse(body.deletionId);
          await s.put(
            "calendarDeletion",
            row.key,
            { id: body.deletionId },
            { shared: false },
          );
          await s.put("calendar", row.key, {
            ...p,
            deletedAt: new Date().toISOString(),
          });
          for (const item of compactCalendarEntries(
            await layout(s, p.userId),
          )) {
            const old = await s.get("calendar", [item.id]);
            await s.put("calendar", old.key, {
              ...old.payload,
              lane: item.lane,
            });
          }
          return {
            ok: true,
            deletionId: body.deletionId,
            ...(await placementResult(s, p.userId)),
          };
        }
        if (entry[2] === "restore") {
          assert(
            (await s.get("calendarDeletion", row.key))?.payload.id ===
              body.deletionId,
            409,
            "이후 삭제 이력이 있습니다.",
          );
          row = await s.put("calendar", row.key, { ...p, deletedAt: null });
          return {
            ...(await entryView(s, row)),
            ...(await placementResult(s, p.userId)),
          };
        }
        const next = { ...p };
        if (body.title !== undefined) {
          assert(
            p.title === body.expectedTitle || p.title === body.title,
            409,
            "일정 제목이 변경되었습니다.",
          );
          next.title = titleSchema.parse(body.title);
        } else if (body.tagIds) {
          assert(
            equal(
              p.tags.map((t) => t.id),
              body.expectedTagIds,
            ) ||
              equal(
                p.tags.map((t) => t.id),
                body.tagIds,
              ),
            409,
            "일정 태그가 변경되었습니다.",
          );
          next.tags = await checkedTags(
            s,
            p.userId,
            body.tagIds,
            p.tags
              .filter((t) => t.checked && body.tagIds.includes(t.id))
              .map((t) => t.id),
          );
        } else {
          assert(
            p.date === body.expectedDate && p.endDate === body.expectedEndDate,
            409,
            "일정 기간이 변경되었습니다.",
          );
          if (body.lane !== undefined) {
            assert(
              p.lane === body.expectedLane || p.lane === body.lane,
              409,
              "일정 위치가 변경되었습니다.",
            );
            next.lane = z.number().int().min(0).max(100000).parse(body.lane);
          } else {
            validRange(body.date, body.endDate);
            next.date = body.date;
            next.endDate = body.endDate;
          }
          const oldLayout = await layout(s, p.userId),
            changed = {
              id: row.key[0],
              date: next.date,
              endDate: next.endDate,
              lane: next.lane,
            };
          for (const placement of placeCalendarEntry(oldLayout, changed)) {
            if (placement.id === row.key[0]) next.lane = placement.lane;
            else {
              const other = await s.get("calendar", [placement.id]);
              await s.put("calendar", other.key, {
                ...other.payload,
                lane: placement.lane,
              });
            }
          }
        }
        row = await s.put("calendar", row.key, next);
        return {
          ...(await entryView(s, row)),
          ...(await placementResult(s, p.userId)),
        };
      },
      { write: method !== "GET", allowViewer: true, body, action: "calendar" },
    );
  }
  const task = /^\/calendar\/tasks\/([^/]+)$/.exec(path);
  if (task && method === "GET") {
    const { teamId, row } = await ctx.locate("task", task[1]);
    return ctx.data(teamId, async (s) => ({
      task: await taskView(s, row),
      settings: await settingsFor(s),
    }));
  }
  return undefined;
}
