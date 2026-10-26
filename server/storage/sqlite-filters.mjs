import { savedFilter } from "../../shared/domain.js";
import { id, json, now, parse, transaction } from "../db.mjs";
import { requireThat } from "../validation.mjs";
import { equal } from "../sync/protocol.mjs";
import {
  normalizeFilterInput,
  canEditSavedFilter,
  requireFilterEditor,
  currentFilterSelection,
} from "./filter-service.mjs";
export function filtersFor(db, user, team) {
  return db
    .prepare(
      "SELECT * FROM saved_filters WHERE team_id=? AND (scope='team' OR owner_id=?) ORDER BY scope DESC,updated_at DESC,id",
    )
    .all(team.id, user.id)
    .map((row) => ({
      id: row.id,
      name: row.name,
      scope: row.scope,
      canEdit: canEditSavedFilter(user, team.id, row.scope),
      data: savedFilter(parse(row.data), team.settings),
      updatedAt: row.updated_at,
    }));
}
export function currentFiltersFor(
  db,
  user,
  team,
  filters = filtersFor(db, user, team),
) {
  const row = db
    .prepare(
      "SELECT data,selected_id FROM filter_states WHERE user_id=? AND team_id=?",
    )
    .get(user.id, team.id);
  return currentFilterSelection(
    filters,
    row?.selected_id,
    parse(row?.data, {}),
    team.settings,
  );
}
export class SqliteFilterRepository {
  constructor({ db, teamAccess }) {
    Object.assign(this, { db, teamAccess });
    this.committedResources = [];
  }
  resourceChanges() {
    return this.committedResources;
  }
  list(user, { teamId }) {
    const team = this.teamAccess(user, teamId),
      filters = filtersFor(this.db, user, team);
    return {
      filters,
      current: currentFiltersFor(this.db, user, team, filters),
    };
  }
  current(user, input) {
    this.committedResources = [];
    const team = this.teamAccess(user, input.teamId),
      data = normalizeFilterInput(input.data, team.settings);
    if (input.selectedId)
      requireThat(
        filtersFor(this.db, user, team).some((f) => f.id === input.selectedId),
        404,
        "저장된 필터를 찾을 수 없습니다.",
      );
    transaction(this.db, () =>
      this.db
        .prepare(
          "INSERT INTO filter_states(user_id,team_id,selected_id,data) VALUES(?,?,?,?) ON CONFLICT(user_id,team_id) DO UPDATE SET selected_id=excluded.selected_id,data=excluded.data",
        )
        .run(user.id, team.id, input.selectedId || null, json(data)),
    );
    return { ok: true };
  }
  save(user, input) {
    this.committedResources = [];
    const team = this.teamAccess(user, input.teamId);
    requireFilterEditor(user, team.id, input.scope);
    const data = normalizeFilterInput(input.data, team.settings),
      owner = input.scope === "personal" ? user.id : null;
    let changed = false;
    transaction(this.db, () => {
      const existing = this.db
        .prepare(
          "SELECT * FROM saved_filters WHERE team_id=? AND scope=? AND owner_id IS ? AND name=?",
        )
        .get(team.id, input.scope, owner, input.name);
      if (existing) {
        if (equal(parse(existing.data), data)) return;
        this.db
          .prepare("UPDATE saved_filters SET data=?,updated_at=? WHERE id=?")
          .run(json(data), now(), existing.id);
      } else
        this.db
          .prepare(
            "INSERT INTO saved_filters(id,team_id,scope,owner_id,name,data,updated_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            id(),
            team.id,
            input.scope,
            owner,
            input.name,
            json(data),
            now(),
          );
      changed = true;
    });
    if (changed && input.scope === "team")
      this.committedResources = ["team:" + team.id];
    return { ok: true };
  }
  editable(user, id) {
    const row = this.db
      .prepare(
        "SELECT * FROM saved_filters WHERE id=? AND (scope='team' OR owner_id=?)",
      )
      .get(id, user.id);
    requireThat(row, 404, "저장된 필터를 찾을 수 없습니다.");
    const team = this.teamAccess(user, row.team_id);
    requireFilterEditor(user, team.id, row.scope);
    return { row, team };
  }
  update(user, id, input) {
    this.committedResources = [];
    const { row, team } = this.editable(user, id),
      name = input.name ?? row.name,
      data =
        input.data === undefined
          ? parse(row.data)
          : normalizeFilterInput(input.data, team.settings);
    requireThat(
      !this.db
        .prepare(
          "SELECT id FROM saved_filters WHERE team_id=? AND scope=? AND owner_id IS ? AND name=? AND id<>?",
        )
        .get(team.id, row.scope, row.owner_id, name, id),
      409,
      "같은 구분에 같은 이름의 필터가 이미 있습니다.",
    );
    if (name === row.name && equal(parse(row.data), data)) return { ok: true };
    transaction(this.db, () =>
      this.db
        .prepare(
          "UPDATE saved_filters SET name=?,data=?,updated_at=? WHERE id=?",
        )
        .run(name, json(data), now(), id),
    );
    if (row.scope === "team") this.committedResources = ["team:" + team.id];
    return { ok: true };
  }
  remove(user, id) {
    this.committedResources = [];
    const { row } = this.editable(user, id);
    transaction(this.db, () =>
      this.db.prepare("DELETE FROM saved_filters WHERE id=?").run(id),
    );
    if (row.scope === "team") this.committedResources = ["team:" + row.team_id];
    return { ok: true };
  }
}
