import {
  normalizeSettings,
  PROPERTY_VALUE_MAX_LENGTH,
  normalizeView,
  savedFilter,
  viewLayout,
  propertyOption,
  splitNames,
} from "../shared/domain.js";
import {
  propertiesSchema,
  styleSchema,
  weekHeaderSchema,
  borderSchema,
  requireThat,
  validateCellValue,
} from "./validation.mjs";
import { audit, json, parse, touchTasks, transaction } from "./db.mjs";
import { z } from "zod";
import { THEME_IDS } from "../shared/themes.js";

const settingsSchema = z
  .object({
    theme: z.enum(THEME_IDS).optional(),
    properties: propertiesSchema.optional(),
    revision: z.number().int().nonnegative().optional(),
    defaultStyle: styleSchema.optional(),
    defaultDensity: z.enum(["comfortable", "compact", "dense"]).optional(),
    weekHeader: weekHeaderSchema.optional(),
    weekBorders: z
      .object({ left: borderSchema.optional(), right: borderSchema.optional() })
      .strict()
      .optional(),
  })
  .strict();

export function saveSettings(db, team, input, actorId) {
  const previous = normalizeSettings(team.settings);
  const data = settingsSchema.parse(input);
  if (data.revision !== undefined)
    requireThat(
      data.revision === (previous.revision || 0),
      409,
      "다른 관리자가 설정을 변경했습니다. 다시 열어 최신 설정을 확인하세요.",
    );
  // 제거한 속성·선택값은 보관(archived)해서 기존 셀을 계속 읽을 수 있게 한다.
  let properties = (data.properties ?? previous.properties).map((p) => {
    const old = previous.properties.find((o) => o.id === p.id);
    return {
      ...p,
      placement: p.placement ?? old?.placement ?? "beforeWeeks",
      values: [
        ...p.values,
        ...(old?.values || [])
          .filter((v) => !p.values.some((n) => n.id === v.id))
          .map((v) => ({ ...v, archived: true })),
      ],
    };
  });
  properties.push(
    ...previous.properties
      .filter((p) => !properties.some((n) => n.id === p.id))
      .map((p) => ({ ...p, archived: true })),
  );
  properties = normalizeSettings({ properties }).properties;
  propertiesSchema.parse(properties);
  for (const p of properties.filter((p) =>
    ["owner", "supporters"].includes(p.id),
  ))
    requireThat(
      p.kind === "member" && !!p.multiple === (p.id === "supporters"),
      400,
      "팀원·지원자는 업무 편집 권한과 연결된 Member 속성입니다. 기본 팀원 속성은 삭제할 수 없습니다.",
    );
  for (const p of properties) {
    const old = previous.properties.find((o) => o.id === p.id);
    for (const v of p.values) {
      // 이름을 바꾸거나 새로 만든 값만 길이 제한을 받는다.
      const unchanged = old?.values.some(
        (o) => o.id === v.id && o.label === v.label,
      );
      requireThat(
        unchanged || v.label.length <= PROPERTY_VALUE_MAX_LENGTH,
        400,
        `${p.name}의 값 이름은 ${PROPERTY_VALUE_MAX_LENGTH}자까지 입력할 수 있습니다.`,
      );
    }
  }
  const settings = {
    theme: data.theme ?? previous.theme,
    properties,
    defaultStyle: data.defaultStyle ?? previous.defaultStyle,
    defaultDensity: data.defaultDensity ?? previous.defaultDensity,
    weekHeader: data.weekHeader ?? previous.weekHeader,
    weekBorders: data.weekBorders ?? previous.weekBorders,
    revision: (previous.revision || 0) + 1,
  };
  transaction(db, () => {
    convertChangedKinds(db, team.id, actorId, previous, properties, settings);
    // 보관된 속성의 필터·열을 보기에서 걷어낸다.
    for (const [table, normalize] of [
      ["views", (data) => viewLayout(normalizeView(data, settings))],
      ["saved_filters", (data) => savedFilter(data, settings)],
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
        json(savedFilter(parse(row.data), settings)),
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
  const changed = properties.filter((p) => {
    const old = previous.properties.find((o) => o.id === p.id);
    return (
      old &&
      !p.archived &&
      (old.kind !== p.kind || !!old.multiple !== !!p.multiple)
    );
  });
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
        "SELECT c.* FROM cells c JOIN tasks t ON c.task_id=t.id WHERE t.team_id=? AND c.key=?",
      )
      .all(teamId, p.id);
    for (const row of rows) {
      const value = parse(row.value);
      const empty = value === "" || (Array.isArray(value) && !value.length);
      const text =
        old.kind === "member"
          ? (Array.isArray(value) ? value : empty ? [] : [value])
              .map((id) => users.find((u) => u.id === id)?.name || id)
              .join(", ")
          : (propertyOption(old, value)?.label ?? String(value));
      let next = empty ? (p.kind === "member" && p.multiple ? [] : "") : text;
      if (!empty && p.kind === "number")
        next =
          text.trim() && Number.isFinite(Number(text)) ? Number(text) : text;
      if (!empty && p.kind === "option") {
        const option = p.values.find(
          (v) => !v.archived && (v.label === text || v.id === value),
        );
        next = option ? option.id : text;
      }
      if (!empty && p.kind === "member") {
        const ids = splitNames(text).map((n) => {
          const matches = users.filter(
            (u) => u.role !== "viewer" && (u.id === n || u.name === n),
          );
          requireThat(
            matches.length === 1,
            400,
            `${p.name}: “${n}”에 해당하는 팀원을 정확히 선택할 수 없습니다.`,
          );
          return matches[0].id;
        });
        requireThat(
          p.multiple || ids.length <= 1,
          400,
          `${p.name}: 여러 팀원이 선택된 값이 있어 단일 선택으로 바꿀 수 없습니다.`,
        );
        next = p.multiple ? [...new Set(ids)] : ids[0] || "";
      }
      try {
        validateCellValue(db, teamId, p.id, next, settings);
      } catch {
        requireThat(
          false,
          400,
          `${p.name}: 기존 값 “${text.slice(0, 40)}”을 새 속성 종류로 바꿀 수 없습니다. 해당 값을 먼저 수정하세요.`,
        );
      }
      const prev = {
        taskId: row.task_id,
        key: p.id,
        value,
        style: parse(row.style),
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
