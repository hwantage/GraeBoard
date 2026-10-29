import { requireThat, validateCellValue } from "../../shared/validation.js";
import { audit, json, parse, touchTasks, transaction } from "../db.mjs";
import { expandStyle } from "../../shared/compact.js";

import {
  prepareSettings,
  changedSettingsProperties,
  convertSettingsValue,
  normalizeSettingsAuxiliary,
} from "./settings-service.mjs";
export function saveSettings(db, team, input, actorId) {
  const { previous, settings } = prepareSettings(team.settings, input),
    properties = settings.properties;
  transaction(db, () => {
    convertChangedKinds(db, team.id, actorId, previous, properties, settings);
    // 보관된 속성의 필터·열을 보기에서 걷어낸다.
    for (const [table, normalize] of [
      ["views", (data) => normalizeSettingsAuxiliary("view", data, settings)],
      [
        "saved_filters",
        (data) => normalizeSettingsAuxiliary("filter", data, settings),
      ],
    ]) {
      const update = db.prepare(`UPDATE ${table} SET data=? WHERE id=?`);
      for (const row of db
        .prepare(`SELECT id,data FROM ${table} WHERE team_id=?`)
        .all(team.id))
        update.run(json(normalize(parse(row.data))), row.id);
    }
    const updateState = db.prepare(
      "UPDATE filter_states SET data=? WHERE user_id=? AND team_id=?",
    );
    for (const row of db
      .prepare("SELECT user_id,data FROM filter_states WHERE team_id=?")
      .all(team.id))
      updateState.run(
        json(normalizeSettingsAuxiliary("filter", parse(row.data), settings)),
        row.user_id,
        team.id,
      );
    db.prepare("UPDATE teams SET settings=? WHERE id=?").run(
      json(settings),
      team.id,
    );
    audit(db, actorId, team.id, "settings", team.id, previous, settings);
  });
  return settings;
}

// 속성 종류(또는 단일·복수)가 바뀌면 기존 셀 값을 새 종류로 바꾼다.
// 하나라도 바꿀 수 없으면 설정 저장 전체를 되돌린다.
function convertChangedKinds(
  db,
  teamId,
  actorId,
  previous,
  properties,
  settings,
) {
  const changed = changedSettingsProperties(previous, properties);
  if (!changed.length) return;
  const users = db
    .prepare(
      "SELECT u.id,u.name,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.team_id=?",
    )
    .all(teamId);
  const updateCell = db.prepare(
    "UPDATE cells SET value=?,version=? WHERE task_id=? AND key=?",
  );
  const changes = [];
  for (const p of changed) {
    const old = previous.properties.find((o) => o.id === p.id);
    const rows = db
      .prepare(
        "SELECT c.*,s.data AS style_data FROM cells c JOIN tasks t ON c.task_id=t.id JOIN styles s ON s.id=c.style_id WHERE t.team_id=? AND c.key=?",
      )
      .all(teamId, p.id);
    for (const row of rows) {
      const value = parse(row.value);
      const next = convertSettingsValue(old, p, value, users, (next) =>
        validateCellValue(db, teamId, p.id, next, settings),
      );
      const prev = {
        taskId: row.task_id,
        key: p.id,
        value,
        style: expandStyle(JSON.parse(row.style_data)),
        version: row.version,
      };
      const updated = { ...prev, value: next, version: prev.version + 1 };
      updateCell.run(json(next), updated.version, row.task_id, p.id);
      changes.push({ prev, next: updated });
    }
  }
  if (!changes.length) return;
  const changedIds = [...new Set(changes.map((c) => c.next.taskId))];
  touchTasks(
    db,
    db
      .prepare(
        `SELECT id,updated_at AS updatedAt FROM tasks WHERE id IN (${changedIds.map(() => "?").join(",")})`,
      )
      .all(...changedIds),
  );
  audit(
    db,
    actorId,
    teamId,
    "property-convert",
    teamId,
    changes.map((c) => c.prev),
    changes.map((c) => c.next),
  );
}

export class SqliteSettingsRepository {
  constructor({ db, managedTeam }) {
    Object.assign(this, { db, managedTeam });
    this.committedResources = [];
  }
  resourceChanges() {
    return this.committedResources;
  }
  save(user, teamId, input) {
    this.committedResources = [];
    const team = this.managedTeam(user, teamId),
      settings = saveSettings(this.db, team, input, user.id);
    this.committedResources = ["team:" + teamId];
    return { settings };
  }
  general(user, teamId, input) {
    this.committedResources = [];
    const team = this.managedTeam(user, teamId),
      settings = team.settings,
      themeChanged =
        input.theme !== undefined && input.theme !== settings.theme;
    if (themeChanged && input.settingsRevision !== undefined)
      requireThat(
        input.settingsRevision === (settings.revision || 0),
        409,
        "팀 설정이 변경되었습니다. 관리 화면을 다시 열어 최신 설정을 확인하세요.",
      );
    transaction(this.db, () => {
      this.db
        .prepare("UPDATE teams SET name=? WHERE id=?")
        .run(input.name, teamId);
      if (themeChanged)
        this.db.prepare("UPDATE teams SET settings=? WHERE id=?").run(
          json({
            ...settings,
            theme: input.theme,
            revision: (settings.revision || 0) + 1,
          }),
          teamId,
        );
      audit(
        this.db,
        user.id,
        teamId,
        "team-update",
        teamId,
        { id: teamId, name: team.name, theme: settings.theme },
        { ...input, theme: input.theme ?? settings.theme },
      );
    });
    this.committedResources = ["team:" + teamId];
    return { ok: true };
  }
}
