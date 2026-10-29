import {
  audit,
  getTasksById,
  id,
  json,
  now,
  parse,
  pruneStyles,
  readFormatting,
  touchTasks,
  upsertCellStatement,
  writeFormatting,
} from "./db.mjs";
import { canEdit, canManageTeam } from "../shared/domain.js";
import { STYLE_KEYS, sameStyle } from "../shared/compact.js";
import { scopeKey, scopeMatches, scopesOverlap } from "../shared/formatting.js";
import { storeCellOperation } from "./cell-operations.mjs";
import { requireThat, validCellKey } from "../shared/validation.js";

function snapshots(db, operation) {
  const stored = parse(operation.response);
  requireThat(
    stored?.kind === "format-audit",
    409,
    "공통 서식 변경 작업이 아닙니다.",
  );
  const row = db
    .prepare(
      "SELECT * FROM audit WHERE id=? AND actor_id=? AND target=? AND action='format'",
    )
    .get(stored.refs[0].id, operation.actor_id, operation.id);
  requireThat(row, 410, "복원할 서식 이력이 없습니다. 최신 내용을 확인하세요.");
  return {
    stored,
    before: parse(row.before_json),
    after: parse(row.after_json),
  };
}

export function replayFormatOperation(db, operation) {
  const { stored, before, after } = snapshots(db, operation);
  return {
    cells: after.cells,
    before: before.cells,
    formatting: after.formatting,
    formatTeamId: stored.refs[0].teamId,
    formatOperation: true,
    formatRevision: after.formatting.revision,
    previousFormatRevision: before.formatting.revision,
    operationId: operation.id,
    savedAt: stored.savedAt,
    updatedAt: stored.updatedAt,
  };
}

// Called inside the same transaction as cells and audit. Only existing cell
// exceptions are visited; blank weeks never become cell records.
export function applyFormatting(db, user, request, team, restoreEntry) {
  const d = request.format,
    current = readFormatting(db, team.id);
  requireThat(
    d.expectedRevision === current.revision,
    409,
    "공통 서식이 변경되었습니다. 최신 내용을 확인한 뒤 다시 적용하세요.",
  );
  let scopes, rules, restored;
  if (d.restore) {
    let source;
    if (restoreEntry) {
      source = {
        stored: { refs: [{ teamId: restoreEntry.team_id }] },
        before: parse(restoreEntry.before_json),
        after: parse(restoreEntry.after_json),
      };
    } else {
      const operation = db
        .prepare("SELECT * FROM operations WHERE id=?")
        .get(d.restore);
      requireThat(
        operation && operation.actor_id === user.id,
        403,
        "자신의 서식 변경만 실행취소할 수 있습니다.",
      );
      source = snapshots(db, operation);
    }
    requireThat(
      source.stored.refs[0].teamId === team.id,
      403,
      "같은 팀의 서식만 복원할 수 있습니다.",
    );
    requireThat(
      json(source.after.formatting.rules) === json(current.rules),
      409,
      "이후 서식 변경이 있어 되돌릴 수 없습니다.",
    );
    rules = source.before.formatting.rules;
    restored = source.before.cells;
    const beforeById = new Map(rules.map((r) => [r.id, r]));
    const afterById = new Map(current.rules.map((r) => [r.id, r]));
    scopes = [...new Set([...beforeById.keys(), ...afterById.keys()])]
      .filter((id) => json(beforeById.get(id)) !== json(afterById.get(id)))
      .map((id) => beforeById.get(id) || afterById.get(id));
  } else {
    scopes = d.scopes
      .filter((scope) => scope.reset || Object.keys(scope.style).length)
      .map((scope) => ({
        ...scope,
        rows: scope.rows === null ? null : [...new Set(scope.rows)].sort(),
        keys: scope.keys === null ? null : [...new Set(scope.keys)].sort(),
        excludeKeys: [...new Set(scope.excludeKeys || [])].sort(),
      }));
    const map = new Map(current.rules.map((rule) => [scopeKey(rule), rule]));
    for (const scope of scopes) {
      for (const key of [...(scope.keys || []), ...scope.excludeKeys])
        requireThat(
          validCellKey(key, team.settings),
          400,
          "서식을 적용할 열을 확인하세요.",
        );
      const selector = scopeKey(scope),
        old = map.get(selector);
      const names = scope.reset
        ? Object.keys(STYLE_KEYS)
        : Object.keys(scope.style);
      const style = scope.reset
        ? { ...scope.style }
        : { ...old?.style, ...scope.style };
      const orders = { ...old?.orders };
      for (const name of names) {
        const desired = Object.hasOwn(style, name)
          ? { [name]: style[name] }
          : {};
        const previous =
          old && Object.hasOwn(old.style, name)
            ? { [name]: old.style[name] }
            : {};
        const conflict = [...map.values()].some(
          (r) =>
            r.id !== old?.id &&
            (r.orders[name] ?? -1) > (old?.orders[name] ?? -1) &&
            scopesOverlap(r, scope) &&
            !sameStyle(
              Object.hasOwn(r.style, name) ? { [name]: r.style[name] } : {},
              desired,
            ),
        );
        if (
          !old ||
          orders[name] === undefined ||
          !sameStyle(previous, desired) ||
          conflict
        )
          orders[name] = current.revision + 1;
      }
      map.set(selector, {
        id: old?.id || id(),
        rows: scope.rows,
        keys: scope.keys,
        excludeKeys: scope.excludeKeys,
        style,
        orders,
      });
    }
    rules = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  const global = scopes.some((scope) => scope.rows === null);
  if (global)
    requireThat(
      canManageTeam(user, team.id),
      403,
      "팀 전체 열 서식은 팀장 권한이 필요합니다.",
    );
  const ids = global
    ? db
        .prepare("SELECT id FROM tasks WHERE team_id=? AND deleted_at IS NULL")
        .all(team.id)
        .map((r) => r.id)
    : [
        ...new Set([
          ...scopes.flatMap((s) => s.rows),
          ...(restored || []).map((c) => c.taskId),
        ]),
      ];
  const tasks = new Map(
    getTasksById(db, ids)
      .filter((t) => !t.deletedAt && t.teamId === team.id)
      .map((t) => [t.id, t]),
  );
  requireThat(
    tasks.size === ids.length,
    404,
    "서식을 적용할 업무를 찾지 못했습니다.",
  );
  for (const task of tasks.values()) {
    requireThat(
      canEdit(user, task),
      403,
      "선택 범위에 편집 권한이 없는 업무가 있습니다.",
    );
    if (!d.restore)
      requireThat(
        d.expectedTasks?.[task.id] === task.updatedAt,
        409,
        "선택한 업무가 변경되었습니다. 최신 내용을 확인한 뒤 다시 적용하세요.",
      );
  }
  const before = [],
    cells = [];
  if (restored) {
    for (const c of restored) {
      const prior = tasks.get(c.taskId).cells[c.key] || {
        value: "",
        style: {},
        version: 0,
      };
      requireThat(
        d.expectedCells?.[`${c.taskId}:${c.key}`] === prior.version,
        409,
        "이후 셀 변경이 있어 되돌릴 수 없습니다.",
      );
      before.push({ taskId: c.taskId, key: c.key, ...prior });
      cells.push({ ...c, version: prior.version + 1 });
    }
  } else {
    for (const task of tasks.values()) {
      const targets = scopes.filter((s) => scopeMatches(s, task.id));
      for (const [key, prior] of Object.entries(task.cells)) {
        const style = { ...prior.style };
        for (const scope of targets)
          if (scopeMatches(scope, task.id, key))
            for (const name of scope.reset
              ? Object.keys(STYLE_KEYS)
              : Object.keys(scope.style))
              delete style[name];
        if (sameStyle(style, prior.style)) continue;
        before.push({ taskId: task.id, key, ...prior });
        cells.push({
          taskId: task.id,
          key,
          value: prior.value,
          style,
          version: prior.version + 1,
        });
      }
    }
  }
  if (!d.restore && !cells.length && json(rules) === json(current.rules)) {
    const result = {
      cells: [],
      before: [],
      updatedAt: {},
      operationId: request.operationId,
      savedAt: now(),
      formatRevision: current.revision,
    };
    storeCellOperation(db, user.id, result, tasks);
    return result;
  }
  const formatting = { revision: current.revision + 1, rules };
  writeFormatting(db, team.id, formatting);
  const put = upsertCellStatement(db);
  for (const c of cells) put.run(c.taskId, c.key, c.value, c.style, c.version);
  pruneStyles(db, [
    ...current.rules.map((r) => r.style),
    ...before.map((c) => c.style),
  ]);
  const updatedAt = touchTasks(db, [...tasks.values()]),
    savedAt = now();
  const auditId = audit(
    db,
    user.id,
    team.id,
    "format",
    request.operationId,
    { formatting: current, cells: before },
    { formatting, cells, taskIds: ids },
  );
  db.prepare("INSERT INTO operations VALUES(?,?,?,?)").run(
    request.operationId,
    user.id,
    json({
      kind: "format-audit",
      refs: [{ teamId: team.id, id: auditId }],
      savedAt,
      updatedAt,
    }),
    savedAt,
  );
  return {
    cells,
    before,
    formatting,
    formatTeamId: team.id,
    formatOperation: true,
    formatRevision: formatting.revision,
    previousFormatRevision: current.revision,
    operationId: request.operationId,
    savedAt,
    updatedAt,
  };
}
