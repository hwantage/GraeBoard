import { normalizeSearchQuery } from "../../shared/search.js";
import {
  CALENDAR_ROUTES,
  requireCalendarWrite,
  prepareCalendarTagUpdate,
  requireCalendarRange,
  selectCalendarImport,
  calendarConnectedLayout,
  prepareCalendarPlacement,
  calendarViewRange,
  calendarPreview,
  uuid as idSchema,
  titleSchema,
} from "../../server/storage/calendar-service.mjs";
import { z } from "zod";
import { dateSchema } from "../../shared/validation.js";
import { canManageTeam, todayKey } from "../../shared/domain.js";
import {
  addDays,
  calendarWeek,
  calendarRuleProblem,
  nextCalendarCopyTitle,
  CALENDAR_DAYS,
} from "../../shared/calendar.js";
import { firstCalendarLane } from "../../shared/calendar-layout.js";
import { CALENDAR_TAG_COLORS } from "../../shared/calendar-tags.js";
import { equal } from "../../server/sync/protocol.mjs";
import { assert } from "../access.mjs";
import { taskList, taskView, settingsFor, stamp } from "../tasks.mjs";
function validRange(date, endDate, query = false) {
  requireCalendarRange(date, endDate, { query });
}
async function member(ctx, teamId, userId) {
  if (userId === null) return;
  const active = (
    await ctx.controlStore.members(teamId, { activeOnly: true })
  ).some((user) => user.id === userId);
  const reference =
    active || (await ctx.data(teamId, (s) => s.get("person", [userId])));
  assert(reference, 404, "현재 팀의 활성 구성원을 선택하세요.");
}
async function writable(ctx, teamId, userId) {
  await ctx.team(teamId);
  await member(ctx, teamId, userId);
  requireCalendarWrite(ctx.user, teamId, userId);
}
async function locateEntry(ctx, id, includeDeleted = false) {
  for (const team of await ctx.teams()) {
    if (team.status !== "active") continue;
    const row = await ctx.data(team.id, (s) => s.get("calendar", [id]));
    if (row && (includeDeleted || (!row.deleted && !row.payload.deletedAt))) {
      await member(ctx, team.id, row.payload.userId);
      return { teamId: team.id, row };
    }
  }
  assert(false, 404, "일정을 찾을 수 없습니다. 삭제되었을 수 있습니다.");
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
    preview: calendarPreview((!doc?.deleted && doc?.payload.markdown) || ""),
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
    .sort(
      (a, b) =>
        a.payload.name.localeCompare(b.payload.name) ||
        a.key[0].localeCompare(b.key[0]),
    )
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
const methods = new Map(
  CALENDAR_ROUTES.map((route) => [route.name, route.method]),
);
async function calendarOperation(ctx, operation, params, body, query) {
  const method = methods.get(operation);
  assert(method, 404, "등록되지 않은 일정 기능입니다.");
  if (["getPreferences", "savePreferences"].includes(operation)) {
    if (method === "PUT")
      return ctx.controlStore.saveCalendarPreferences(
        ctx.user.id,
        [...new Set(body.weekdays)].sort(),
      );
    return ctx.controlStore.calendarPreferences(ctx.user.id);
  }
  if (["getTeam", "listTags", "createTag", "saveRule"].includes(operation)) {
    const teamId = params.teamId;
    const section =
      operation === "getTeam"
        ? null
        : operation === "saveRule"
          ? "rule"
          : "tags";
    await ctx.team(teamId);
    const userId =
      body.userId === null || query.get("scope") === "team"
        ? null
        : body.userId || query.get("userId") || ctx.user.id;
    if (method !== "GET") await writable(ctx, teamId, userId);
    else if (section === "tags") await member(ctx, teamId, userId);
    if (section === "rule")
      assert(
        canManageTeam(ctx.user, teamId),
        403,
        "팀장만 가져오기 기준을 바꿀 수 있습니다.",
      );
    return ctx.data(
      teamId,
      async (s) => {
        if (!section) {
          const settings = await settingsFor(s),
            r = await s.get("rule", []),
            rule = {
              propertyId: "",
              values: [],
              mode: "include",
              ...r?.payload,
              revision: r?.revision || 0,
            };
          const members = await ctx.controlStore.members(teamId, {
            activeOnly: true,
          });
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
        if (section === "tags") {
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
          const previous = await s.get("tag", [id]);
          if (previous) {
            assert(
              !previous.deleted &&
                equal(previous.payload, { userId, name, color, kind }),
              409,
              "태그 생성 요청이 변경되었습니다.",
            );
            return tags.find((t) => t.id === id);
          }
          assert(
            !tags.some(
              (t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase(),
            ) && tags.length < 200,
            409,
            "같은 이름의 태그가 있거나 목록이 가득 찼습니다.",
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
          values: [...new Set(body.values)],
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
        return {
          rule: { ...row.payload, revision: row.revision },
          ruleProblem: "",
        };
      },
      { write: method !== "GET", allowViewer: true, body, action: "calendar" },
    );
  }
  if (["updateTag", "deleteTag"].includes(operation)) {
    const { teamId, row } = await ctx.locate("tag", params.id);
    await writable(ctx, teamId, row.payload.userId);
    return ctx.data(
      teamId,
      async (s) => {
        const t = await s.get("tag", [params.id]);
        if (method === "DELETE") {
          assert(
            t.revision === body.expectedRevision,
            409,
            "태그가 변경되었습니다.",
          );
          for (const e of await s.list("calendar"))
            if (e.payload.tags.some((x) => x.id === params.id))
              await s.put("calendar", e.key, {
                ...e.payload,
                tags: e.payload.tags.filter((x) => x.id !== params.id),
              });
          await s.put("tag", t.key, t.payload, { deleted: true });
          return { ok: true };
        }
        const change = prepareCalendarTagUpdate(
          { ...t.payload, revision: t.revision },
          body,
        );
        if (!change)
          return (await tagsFor(s, t.payload.userId)).find(
            (item) => item.id === params.id,
          );
        const next = { ...t.payload, ...change };
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
              x.id !== params.id &&
              x.name.toLowerCase() === next.name.toLowerCase(),
          ),
          409,
          "같은 이름의 태그가 있습니다.",
        );
        await s.put("tag", t.key, next);
        if (next.kind === "label")
          for (const e of await s.list("calendar"))
            if (e.payload.tags.some((x) => x.id === params.id && x.checked))
              await s.put("calendar", e.key, {
                ...e.payload,
                tags: e.payload.tags.map((x) =>
                  x.id === params.id ? { ...x, checked: false } : x,
                ),
              });
        return (await tagsFor(s, next.userId)).find(
          (item) => item.id === params.id,
        );
      },
      { write: true, allowViewer: true, body, action: "calendar-tag" },
    );
  }
  if (operation === "listEntries") {
    const teamId = query.get("teamId"),
      from = dateSchema.parse(query.get("from")),
      to = dateSchema.parse(query.get("to"));
    validRange(from, to, true);
    if (query.get("userId")) await member(ctx, teamId, query.get("userId"));
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
            ? calendarConnectedLayout(
                await layout(
                  s,
                  query.get("scope") === "team" ? null : query.get("userId"),
                ),
                [
                  calendarViewRange(
                    rows.map((r) => r.payload),
                    { date: from, endDate: to },
                  ),
                ],
              )
            : [],
      };
    });
  }
  if (operation === "listTasks")
    return ctx.data(query.get("teamId"), async (s) => {
      await member(ctx, query.get("teamId"), query.get("userId"));
      const tasks = (await taskList(s)).filter((t) =>
          normalizeSearchQuery(String(t.cells.title?.value || "")).includes(
            normalizeSearchQuery(query.get("q") || ""),
          ),
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
  if (["addWeekly", "importWeekly"].includes(operation)) {
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
        let ids = body.taskIds,
          unassigned = 0;
        if (operation === "importWeekly") {
          assert(
            body.weekStart === calendarWeek(todayKey()),
            400,
            "조건 가져오기는 이번 주에만 가능합니다.",
          );
          const r = await s.get("rule", []),
            rule = r?.payload || {
              propertyId: "",
              values: [],
              mode: "include",
            },
            settings = await settingsFor(s);
          assert(
            !calendarRuleProblem(rule, settings.properties),
            400,
            "가져오기 기준을 확인하세요.",
          );
          const selected = selectCalendarImport(
            (await taskList(s)).map((t) => ({
              id: t.id,
              years: t.years,
              owner: t.cells.owner?.value,
              filterValue: t.cells[rule.propertyId]?.value ?? "",
            })),
            body,
            rule,
          );
          ids = selected.ids;
          unassigned = selected.unassigned;
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
          unassigned,
        };
      },
      { write: true, body, action: "calendar-weekly" },
    );
  }
  if (operation === "createEntry") {
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
  if (
    [
      "getEntry",
      "updateEntry",
      "deleteEntry",
      "restoreEntry",
      "copyEntry",
      "checkTag",
    ].includes(operation)
  ) {
    const { teamId, row: found } = await locateEntry(
      ctx,
      params.id,
      operation === "restoreEntry" || method === "DELETE",
    );
    if (method !== "GET") await writable(ctx, teamId, found.payload.userId);
    return ctx.data(
      teamId,
      async (s) => {
        let row = await s.get("calendar", [params.id]);
        const p = row.payload;
        assert(
          !p.deletedAt || operation === "restoreEntry" || method === "DELETE",
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
        if (operation === "copyEntry") {
          const id = idSchema.parse(body.id),
            old = await s.get("calendar", [id]);
          assert(id !== row.key[0], 400, "새 일정 ID가 필요합니다.");
          if (old) {
            assert(
              !old.deleted &&
                !old.payload.deletedAt &&
                old.payload.userId === p.userId,
              409,
              "이 일정 요청은 이미 처리되었습니다.",
            );
            return entryView(s, old);
          }
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
        if (params.tagId) {
          const tag = await s.get("tag", [params.tagId]),
            selected = p.tags.find((t) => t.id === params.tagId);
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
              t.id === params.tagId
                ? { ...t, checked: z.boolean().parse(body.checked) }
                : t,
            ),
          });
          return {
            tagId: params.tagId,
            checked: body.checked,
            updatedAt: stamp(row),
          };
        }
        if (method === "DELETE") {
          const deletion = await s.get("calendarDeletion", row.key);
          if (p.deletedAt || deletion?.payload.id === body.deletionId) {
            assert(
              p.deletedAt,
              409,
              "이미 복구된 일정입니다. 일정을 다시 확인하세요.",
            );
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
          for (const item of prepareCalendarPlacement(
            calendarConnectedLayout(await layout(s, p.userId), [p]),
            row.key[0],
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
        if (operation === "restoreEntry") {
          assert(
            (await s.get("calendarDeletion", row.key))?.payload.id ===
              body.deletionId,
            409,
            "이후 삭제 이력이 있습니다.",
          );
          if (p.deletedAt || row.deleted) {
            row = await s.put("calendar", row.key, { ...p, deletedAt: null });
            for (const item of prepareCalendarPlacement(
              calendarConnectedLayout(await layout(s, p.userId), [
                p,
                ...(body.previousRange ? [body.previousRange] : []),
              ]),
              row.key[0],
              { lane: p.lane },
            )) {
              const prior = await s.get("calendar", [item.id]);
              await s.put("calendar", prior.key, {
                ...prior.payload,
                lane: item.lane,
              });
            }
            row = await s.get("calendar", row.key);
          }
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
            (p.date === body.expectedDate &&
              p.endDate === body.expectedEndDate) ||
              (body.date !== undefined &&
                p.date === body.date &&
                p.endDate === body.endDate),
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
          const oldLayout = calendarConnectedLayout(await layout(s, p.userId), [
              p,
              next,
            ]),
            changed = {
              id: row.key[0],
              date: next.date,
              endDate: next.endDate,
              lane: next.lane,
            };
          for (const placement of prepareCalendarPlacement(
            oldLayout,
            row.key[0],
            changed,
          )) {
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
  if (operation === "getTask") {
    const { teamId, row } = await ctx.locate("task", params.id);
    return ctx.data(teamId, async (s) => ({
      task: await taskView(s, row),
      settings: await settingsFor(s),
    }));
  }
  return undefined;
}

export class PostgresCalendarRepository {
  constructor({ context }) {
    this.context = context;
    this.committedResources = [];
  }
  resourceChanges() {
    return this.committedResources;
  }
  execute(operation, user, { params = {}, body = {}, query = {} } = {}) {
    assert(
      user.id === this.context.user.id,
      403,
      "요청 사용자 정보가 일치하지 않습니다.",
    );
    const before = this.context.lastCommittedChange?.sequence || 0;
    this.committedResources = [];
    return calendarOperation(
      this.context,
      operation,
      params,
      body,
      new URLSearchParams(
        Object.entries(query).filter(([, value]) => value !== undefined),
      ),
    ).then((value) => {
      const committed = this.context.lastCommittedChange;
      if (committed?.sequence > before)
        this.committedResources = [`team:${committed.teamId}`];
      return value;
    });
  }
}
