import { normalizeSettings } from "../../shared/domain.js";
import { validateCellValue, requireThat } from "../../shared/validation.js";
import {
  prepareSettings,
  changedSettingsProperties,
  convertSettingsValue,
  normalizeSettingsAuxiliary,
} from "../../server/storage/settings-service.mjs";
import { entityId } from "../../server/sync/protocol.mjs";

export async function savePostgresSettings(session, input, people) {
  const row = await session.get("team", []);
  requireThat(row, 409, "팀 공유 설정이 없습니다.");
  const { previous, settings } = prepareSettings(
    { ...normalizeSettings(row.payload.settings), revision: row.revision },
    input,
    { requireRevision: true },
  );
  delete settings.revision;
  const allowed = new Set(
    people.filter((p) => p.role !== "viewer").map((p) => p.id),
  );
  const changed = changedSettingsProperties(previous, settings.properties);
  if (changed.length) {
    const cells = await session.list("cell", { deleted: true });
    const projected = cells.some((row) => row.deleted)
      ? await session.projected()
      : null;
    for (const property of changed) {
      const old = previous.properties.find((p) => p.id === property.id);
      for (const cell of cells) {
        if (cell.key[1] !== property.id) continue;
        if (
          cell.deleted &&
          projected?.entities[entityId("cell", cell.key)]?.deleted
        )
          continue;
        const next = convertSettingsValue(
          old,
          property,
          cell.payload.value,
          people,
          (next) =>
            validateCellValue(
              null,
              session.teamId,
              property.id,
              next,
              settings,
              undefined,
              allowed,
            ),
        );
        await session.put(
          "cell",
          cell.key,
          { ...cell.payload, value: next },
          { locallyHidden: cell.deleted },
        );
        await session.touch("task", [cell.key[0]]);
      }
    }
  }
  for (const entity of ["view", "filter", "personalFilter", "filterState"])
    for (const item of await session.list(entity)) {
      const value =
        entity === "view"
          ? normalizeSettingsAuxiliary("view", item.payload, settings)
          : {
              ...item.payload,
              data: normalizeSettingsAuxiliary(
                "filter",
                item.payload.data,
                settings,
              ),
            };
      await session.put(entity, item.key, value);
    }
  const saved = await session.put("team", [], { ...row.payload, settings });
  return { ...saved.payload.settings, revision: saved.revision };
}
export class PostgresSettingsRepository {
  constructor({ context }) {
    this.context = context;
    this.committedResources = [];
  }
  resourceChanges() {
    return this.committedResources;
  }
  async run(user, teamId, input, general) {
    const ctx = this.context;
    requireThat(
      user.id === ctx.user.id,
      403,
      "요청 사용자 정보가 일치하지 않습니다.",
    );
    await ctx.team(teamId, { manage: true });
    this.committedResources = [];
    const sequence = ctx.lastCommittedChange?.sequence || 0;
    const people = await ctx.controlStore.members(teamId);
    const value = await ctx.data(
      teamId,
      async (s) => {
        if (!general)
          return { settings: await savePostgresSettings(s, input, people) };
        const row = await s.get("team", []);
        requireThat(row, 409, "팀 공유 설정이 없습니다.");
        if (
          input.theme !== undefined &&
          input.theme !== row.payload.settings?.theme
        )
          await savePostgresSettings(
            s,
            {
              theme: input.theme,
              revision: input.settingsRevision ?? row.revision,
            },
            people,
          );
        const current = await s.get("team", []);
        await s.put("team", [], { ...current.payload, name: input.name });
        return { ok: true };
      },
      {
        write: true,
        body: input,
        action: general ? "team-update" : "settings",
      },
    );
    const committed = ctx.lastCommittedChange;
    if (committed?.sequence > sequence)
      this.committedResources = ["team:" + committed.teamId];
    return value;
  }
  save(user, teamId, input) {
    return this.run(user, teamId, input, false);
  }
  general(user, teamId, input) {
    return this.run(user, teamId, input, true);
  }
}
