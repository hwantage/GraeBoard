import { z } from "zod";
import { savedFilter, propertiesFor, teamRole } from "../shared/domain.js";
import { id, json, now, parse, transaction } from "./db.mjs";
import { requireThat, savedFilterSchema } from "./validation.mjs";

const nameSchema = z.string().trim().min(1).max(60);
const teamSchema = z.object({ teamId: z.string().uuid() }).strict();

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
      canEdit: row.scope === "personal" || teamRole(user, team.id) === "lead",
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
  const selected = filters.find((f) => f.id === row?.selected_id);
  return {
    selectedId: selected?.id || "",
    data: selected?.data || savedFilter(parse(row?.data, {}), team.settings),
  };
}

export function installFilterRoutes(app, { db, teamAccess }) {
  function validate(data, team) {
    const keys = new Set(propertiesFor(team.settings).map((p) => p.id));
    requireThat(
      [
        ...Object.keys(data.propertyFilters || {}),
        ...Object.keys(data.propertyFilterModes || {}),
      ].every((key) => keys.has(key)),
      400,
      "이 팀의 속성 필터를 선택하세요.",
    );
    return savedFilter(data, team.settings);
  }
  function editable(req) {
    const row = db
      .prepare(
        "SELECT * FROM saved_filters WHERE id=? AND (scope='team' OR owner_id=?)",
      )
      .get(req.params.id, req.user.id);
    requireThat(row, 404, "저장된 필터를 찾을 수 없습니다.");
    const team = teamAccess(req.user, row.team_id);
    requireThat(
      row.scope === "personal" || teamRole(req.user, team.id) === "lead",
      403,
      "팀 공용 필터는 팀장만 수정할 수 있습니다.",
    );
    return { row, team };
  }
  app.get("/api/filters", (req, res) => {
    const { teamId } = teamSchema.parse(req.query);
    const team = teamAccess(req.user, teamId);
    const filters = filtersFor(db, req.user, team);
    res.json({
      filters,
      current: currentFiltersFor(db, req.user, team, filters),
    });
  });
  app.put("/api/filters/current", (req, res) => {
    const d = z
      .object({
        teamId: z.string().uuid(),
        selectedId: z.union([z.literal(""), z.string().uuid()]),
        data: savedFilterSchema,
      })
      .strict()
      .parse(req.body);
    const team = teamAccess(req.user, d.teamId);
    const data = validate(d.data, team);
    if (d.selectedId)
      requireThat(
        filtersFor(db, req.user, team).some((f) => f.id === d.selectedId),
        404,
        "저장된 필터를 찾을 수 없습니다.",
      );
    db.prepare(
      "INSERT INTO filter_states(user_id,team_id,selected_id,data) VALUES(?,?,?,?) ON CONFLICT(user_id,team_id) DO UPDATE SET selected_id=excluded.selected_id,data=excluded.data",
    ).run(req.user.id, team.id, d.selectedId || null, json(data));
    res.json({ ok: true });
  });
  app.put("/api/filters", (req, res) => {
    const d = z
      .object({
        teamId: z.string().uuid(),
        scope: z.enum(["team", "personal"]),
        name: nameSchema,
        data: savedFilterSchema,
      })
      .strict()
      .parse(req.body);
    const team = teamAccess(req.user, d.teamId);
    requireThat(
      d.scope !== "team" || teamRole(req.user, team.id) === "lead",
      403,
      "팀 공용 필터는 팀장만 저장할 수 있습니다.",
    );
    const data = validate(d.data, team);
    const owner = d.scope === "personal" ? req.user.id : null;
    const existing = db
      .prepare(
        "SELECT id FROM saved_filters WHERE team_id=? AND scope=? AND owner_id IS ? AND name=?",
      )
      .get(team.id, d.scope, owner, d.name);
    transaction(db, () => {
    if (existing)
      db.prepare("UPDATE saved_filters SET data=?,updated_at=? WHERE id=?").run(
        json(data),
        now(),
        existing.id,
      );
    else
      db.prepare(
        "INSERT INTO saved_filters(id,team_id,scope,owner_id,name,data,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(id(), team.id, d.scope, owner, d.name, json(data), now());
    });
    res.json({ ok: true });
  });
  app.patch("/api/filters/:id", (req, res) => {
    const d = z
      .object({
        name: nameSchema.optional(),
        data: savedFilterSchema.optional(),
      })
      .strict()
      .refine((v) => v.name !== undefined || v.data !== undefined)
      .parse(req.body);
    const { row, team } = editable(req);
    if (d.name !== undefined)
      requireThat(
        !db
          .prepare(
            "SELECT id FROM saved_filters WHERE team_id=? AND scope=? AND owner_id IS ? AND name=? AND id<>?",
          )
          .get(team.id, row.scope, row.owner_id, d.name, row.id),
        409,
        "같은 구분에 같은 이름의 필터가 이미 있습니다.",
      );
    const data = d.data === undefined ? row.data : json(validate(d.data, team));
    transaction(db, () => db.prepare(
      "UPDATE saved_filters SET name=?,data=?,updated_at=? WHERE id=?",
    ).run(d.name ?? row.name, data, now(), row.id));
    res.json({ ok: true });
  });
  app.delete("/api/filters/:id", (req, res) => {
    const { row } = editable(req);
    transaction(db, () => db.prepare("DELETE FROM saved_filters WHERE id=?").run(row.id));
    res.json({ ok: true });
  });
}
