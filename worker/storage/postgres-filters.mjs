import { savedFilter } from "../../shared/domain.js";
import { requireThat } from "../../shared/validation.js";
import { settingsFor, stamp } from "../task-view.mjs";
import {
  normalizeFilterInput,
  canEditSavedFilter,
  requireFilterEditor,
  currentFilterSelection,
} from "../../server/storage/filter-service.mjs";
export async function filterRows(s, user, settings) {
  const shared = (await s.list("filter")).map((row) => ({
      ...row,
      scope: "team",
    })),
    own = (await s.list("personalFilter"))
      .filter((row) => row.key[1] === user.id)
      .map((row) => ({ ...row, scope: "personal" }));
  return [...shared, ...own]
    .map((row) => ({
      id: row.key[0],
      name: row.payload.name,
      scope: row.scope,
      canEdit: canEditSavedFilter(user, s.teamId, row.scope),
      data: savedFilter(row.payload.data, settings),
      updatedAt: stamp(row),
    }))
    .sort(
      (a, b) =>
        b.scope.localeCompare(a.scope) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
}
export class PostgresFilterRepository {
  constructor({ context }) {
    this.context = context;
    this.committedResources = [];
  }
  resourceChanges() {
    return this.committedResources;
  }
  actor(user) {
    requireThat(
      user.id === this.context.user.id,
      403,
      "요청 사용자 정보가 일치하지 않습니다.",
    );
    return this.context;
  }
  async write(user, teamId, input, shared, work) {
    const ctx = this.actor(user);
    this.committedResources = [];
    const before = ctx.lastCommittedChange?.sequence || 0;
    const value = await ctx.data(teamId, work, {
      write: true,
      allowViewer: true,
      privateWrite: !shared,
      body: input,
      action: shared ? "filter" : undefined,
    });
    const committed = ctx.lastCommittedChange;
    if (committed?.sequence > before)
      this.committedResources = ["team:" + committed.teamId];
    return value;
  }
  list(user, { teamId }) {
    return this.actor(user).data(teamId, async (s) => {
      const settings = await settingsFor(s),
        filters = await filterRows(s, user, settings),
        row = await s.get("filterState", [user.id]);
      return {
        filters,
        current: currentFilterSelection(
          filters,
          row?.payload.selectedId,
          row?.payload.data,
          settings,
        ),
      };
    });
  }
  current(user, input) {
    return this.write(user, input.teamId, input, false, async (s) => {
      const settings = await settingsFor(s),
        filters = await filterRows(s, user, settings);
      requireThat(
        !input.selectedId || filters.some((f) => f.id === input.selectedId),
        404,
        "저장된 필터를 찾을 수 없습니다.",
      );
      await s.put(
        "filterState",
        [user.id],
        {
          selectedId: input.selectedId || "",
          data: normalizeFilterInput(input.data, settings),
        },
        { shared: false },
      );
      return { ok: true };
    });
  }
  save(user, input) {
    requireFilterEditor(user, input.teamId, input.scope);
    return this.write(
      user,
      input.teamId,
      input,
      input.scope === "team",
      async (s) => {
        const settings = await settingsFor(s),
          filters = await filterRows(s, user, settings),
          old = filters.find(
            (f) => f.scope === input.scope && f.name === input.name,
          ),
          id = old?.id || crypto.randomUUID();
        await s.put(
          input.scope === "team" ? "filter" : "personalFilter",
          input.scope === "team" ? [id] : [id, user.id],
          {
            name: input.name,
            data: normalizeFilterInput(input.data, settings),
          },
        );
        return { ok: true };
      },
    );
  }
  async editable(user, id) {
    const ctx = this.actor(user);
    for (const team of await ctx.teams()) {
      if (team.status !== "active") continue;
      const row = await ctx.data(team.id, async (s) => {
        const shared = await s.get("filter", [id]);
        if (shared && !shared.deleted) return shared;
        const personal = await s.get("personalFilter", [id, user.id]);
        return personal && !personal.deleted ? personal : null;
      });
      if (row) {
        const scope = row.entity === "filter" ? "team" : "personal";
        requireFilterEditor(user, team.id, scope);
        return { row, teamId: team.id, scope };
      }
    }
    requireThat(false, 404, "저장된 필터를 찾을 수 없습니다.");
  }
  async update(user, id, input) {
    const found = await this.editable(user, id);
    return this.write(
      user,
      found.teamId,
      input,
      found.scope === "team",
      async (s) => {
        const row = await s.get(found.row.entity, found.row.key);
        requireThat(
          row && !row.deleted,
          404,
          "저장된 필터를 찾을 수 없습니다.",
        );
        const settings = await settingsFor(s),
          name = input.name ?? row.payload.name;
        requireThat(
          !(await filterRows(s, user, settings)).some(
            (f) => f.id !== id && f.scope === found.scope && f.name === name,
          ),
          409,
          "같은 구분에 같은 이름의 필터가 이미 있습니다.",
        );
        await s.put(row.entity, row.key, {
          name,
          data:
            input.data === undefined
              ? row.payload.data
              : normalizeFilterInput(input.data, settings),
        });
        return { ok: true };
      },
    );
  }
  async remove(user, id) {
    const found = await this.editable(user, id);
    return this.write(
      user,
      found.teamId,
      {},
      found.scope === "team",
      async (s) => {
        const row = await s.get(found.row.entity, found.row.key);
        requireThat(
          row && !row.deleted,
          404,
          "저장된 필터를 찾을 수 없습니다.",
        );
        await s.put(row.entity, row.key, row.payload, { deleted: true });
        return { ok: true };
      },
    );
  }
}
