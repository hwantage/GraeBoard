import {
  BUILTIN_PROPERTIES,
  normalizeSettings,
  PROPERTY_VALUE_MAX_LENGTH,
  normalizeView,
  propertyValue,
  propertyOption,
} from "../shared/domain.js";
import {
  propertiesSchema,
  styleSchema,
  weekHeaderSchema,
  requireThat,
  validateCellValue,
} from "./validation.mjs";
import {
  audit,
  getTask,
  json,
  parse,
  nextTaskStamp,
  transaction,
} from "./db.mjs";
import { z } from "zod";
import { THEME_IDS } from "../shared/themes.js";

export function saveSettings(db, team, rawInput, actorId) {
  const previous = normalizeSettings(team.settings);
  // 이전 클라이언트가 보내는 주차 경계선 설정은 저장하지 않는다.
  const { weekBorders: _legacy, ...input } = rawInput;
  const list = z
    .array(z.string().trim().min(1).max(60))
    .max(100)
    .refine((a) => new Set(a).size === a.length);
  const data = z
    .object({
      theme: z.enum(THEME_IDS).optional(),
      categories: list,
      types: list,
      statuses: list,
      retentionDays: z.number().int().min(30).max(3650),
      properties: propertiesSchema.optional(),
      propertiesVersion: z.literal(3).optional(),
      revision: z.number().int().nonnegative().optional(),
      defaultStyle: styleSchema.optional(),
      defaultDensity: z.enum(["comfortable", "compact", "dense"]).optional(),
      weekHeader: weekHeaderSchema.optional(),
    })
    .strict()
    .parse({
      ...(input.properties && input.propertiesVersion !== 3
        ? normalizeSettings(input)
        : input),
      theme: input.theme === undefined ? previous.theme : input.theme,
    });
  if (data.revision !== undefined)
    requireThat(
      data.revision === (previous.revision || 0),
      409,
      "다른 관리자가 설정을 변경했습니다. 다시 열어 최신 설정을 확인하세요.",
    );
  let properties = data.properties;
  if (!properties) {
    properties = previous.properties.map((p) => {
      const key = BUILTIN_PROPERTIES[p.id];
      if (!key) return p;
      return {
        ...p,
        values: data[key].map(
          (label, i) =>
            p.values.find((v) => v.label === label) || {
              id: `legacy-${Date.now()}-${i}`,
              label,
              backgroundColor: "#edf6f4",
              dotColor: "#177b70",
              emoji: "📌",
            },
        ),
      };
    });
  }
  // Removing an option/column archives its definition so historical cells remain readable.
  properties = properties.map((p) => {
    const old = previous.properties.find((o) => o.id === p.id);
    const requested = input.properties?.find((item) => item.id === p.id);
    return {
      ...p,
      placement:
        requested?.placement ?? old?.placement ?? p.placement ?? "beforeWeeks",
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
  properties = normalizeSettings({
    ...data,
    propertiesVersion: 3,
    properties,
  }).properties;
  propertiesSchema.parse(properties);
  for (const p of properties.filter((p) =>
    ["owner", "supporters"].includes(p.id),
  )) {
    requireThat(
      p.kind === "member" && !!p.multiple === (p.id === "supporters"),
      400,
      "팀원·지원자는 업무 편집 권한과 연결된 Member 속성입니다. 기본 팀원 속성은 삭제할 수 없습니다.",
    );
  }
  for (const p of properties) {
    const old = previous.properties.find((o) => o.id === p.id);
    for (const v of p.values) {
      // Keep existing longer labels readable and allow unrelated settings changes.
      // Newly created or renamed values must follow the current length limit.
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
    ...data,
    propertiesVersion: 3,
    properties,
    defaultStyle: data.defaultStyle ?? previous.defaultStyle,
    defaultDensity: data.defaultDensity ?? previous.defaultDensity,
    weekHeader: data.weekHeader ?? previous.weekHeader,
    revision: (previous.revision || 0) + 1,
  };
  for (const [key, listKey] of Object.entries(BUILTIN_PROPERTIES))
    settings[listKey] =
      properties
        .find((p) => p.id === key)
        ?.values.filter((v) => !v.archived)
        .map((v) => v.label) || [];
  // Built-in cells historically stored labels. Rename all matching cells atomically,
  // preserving styles and advancing versions so stale edits cannot overwrite them.
  transaction(db, () => {
    const changes = [];
    const people = db
      .prepare(
        "SELECT u.id,u.name,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.team_id=?",
      )
      .all(team.id);
    for (const p of properties) {
      const old = previous.properties.find((o) => o.id === p.id);
      if (
        !old ||
        p.archived ||
        (old.kind === p.kind && !!old.multiple === !!p.multiple)
      )
        continue;
      const rows = db
        .prepare(
          "SELECT c.* FROM cells c JOIN tasks t ON c.task_id=t.id WHERE t.team_id=? AND c.key=?",
        )
        .all(team.id, p.id);
      for (const row of rows) {
        const value = parse(row.value);
        const empty = value === "" || (Array.isArray(value) && !value.length);
        const text =
          old.kind === "member"
            ? (Array.isArray(value) ? value : empty ? [] : [value])
                .map((id) => people.find((u) => u.id === id)?.name || id)
                .join(", ")
            : (propertyOption(old, value)?.label ?? String(value));
        let next = empty ? (p.kind === "member" && p.multiple ? [] : "") : text;
        if (!empty && p.kind === "number")
          next =
            text.trim() && Number.isFinite(Number(text)) ? Number(text) : text;
        if (!empty && p.kind === "option") {
          const option = p.values.find(
            (v) =>
              !v.archived &&
              (v.label === text || propertyValue(p, v) === value),
          );
          next = option ? propertyValue(p, option) : text;
        }
        if (!empty && p.kind === "member") {
          const ids = text
            .split(/[,;\n]/)
            .map((n) => n.trim())
            .filter(Boolean)
            .map((n) => {
              const matches = people.filter(
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
          validateCellValue(db, team.id, p.id, next, settings);
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
        db.prepare(
          "UPDATE cells SET value=?,version=? WHERE task_id=? AND key=?",
        ).run(json(next), updated.version, row.task_id, p.id);
        changes.push({ prev, next: updated });
      }
    }
    for (const key of Object.keys(BUILTIN_PROPERTIES)) {
      const before = previous.properties.find((p) => p.id === key),
        after = properties.find((p) => p.id === key);
      if (!before || !after) continue;
      const names = new Map(
        (before.kind === "option" && after.kind === "option"
          ? before.values
          : []
        ).map((v) => [
          v.label,
          after.values.find((n) => n.id === v.id)?.label || v.label,
        ]),
      );
      const rows = db
        .prepare(
          "SELECT c.* FROM cells c JOIN tasks t ON c.task_id=t.id WHERE t.team_id=? AND c.key=?",
        )
        .all(team.id, key);
      for (const c of rows) {
        const old = parse(c.value),
          renamed = names.get(old);
        if (renamed !== undefined && renamed !== old) {
          const prev = {
            taskId: c.task_id,
            key,
            value: old,
            style: parse(c.style),
            version: c.version,
          };
          const next = { ...prev, value: renamed, version: prev.version + 1 };
          db.prepare(
            "UPDATE cells SET value=?,version=? WHERE task_id=? AND key=?",
          ).run(json(renamed), next.version, c.task_id, key);
          changes.push({ prev, next });
        }
      }
      {
        for (const row of db
          .prepare("SELECT id,data FROM views WHERE team_id=?")
          .all(team.id)) {
          const view = parse(row.data);
          if (names.has(view[key]) || view.propertyFilters?.[key]) {
            if (names.has(view[key])) view[key] = names.get(view[key]);
            if (view.propertyFilters?.[key])
              view.propertyFilters[key] = view.propertyFilters[key].map(
                (v) => names.get(v) ?? v,
              );
            db.prepare("UPDATE views SET data=? WHERE id=?").run(
              json(view),
              row.id,
            );
          }
        }
      }
    }
    for (const row of db
      .prepare("SELECT id,data FROM views WHERE team_id=?")
      .all(team.id)) {
      const view = normalizeView(
        normalizeView(parse(row.data), previous),
        settings,
      );
      db.prepare("UPDATE views SET data=? WHERE id=?").run(json(view), row.id);
    }
    for (const taskId of new Set(changes.map((c) => c.next.taskId))) {
      const task = getTask(db, taskId);
      db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(
        nextTaskStamp(task.updatedAt),
        taskId,
      );
    }
    if (changes.length)
      audit(
        db,
        actorId,
        team.id,
        "property-rename",
        team.id,
        changes.map((c) => c.prev),
        changes.map((c) => c.next),
      );
    for (const row of db
      .prepare("SELECT id,data FROM reports WHERE team_id=?")
      .all(team.id)) {
      const report = parse(row.data);
      if (!report.settings)
        db.prepare("UPDATE reports SET data=? WHERE id=?").run(
          json({ ...report, settings: previous }),
          row.id,
        );
    }
    db.prepare("UPDATE teams SET settings=? WHERE id=?").run(
      json(settings),
      team.id,
    );
    audit(db, actorId, team.id, "settings", team.id, previous, settings);
  });
  return settings;
}
