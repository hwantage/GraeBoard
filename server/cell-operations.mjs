import { audit, json, parse } from "./db.mjs";
import { requireThat } from "./validation.mjs";

// The caller commits the cells, audit snapshots and replay references together.
// Normal saves never read old audit rows or compare snapshot contents.
export function storeCellOperation(db, actorId, result, tasks) {
  const teamIds = new Set([...tasks.values()].map((task) => task.teamId));
  const refs = [];
  if (!result.cells.length) {
    // An idempotency marker is sufficient; no empty audit snapshot is written.
  } else if (teamIds.size === 1) {
    const teamId = teamIds.values().next().value;
    refs.push({
      teamId,
      id: audit(
        db,
        actorId,
        teamId,
        "cells",
        result.operationId,
        result.before,
        result.cells,
      ),
    });
  } else {
    // Only mixed-team batches need positions to preserve the original response
    // order. Group by IDs in one pass; never compare cell values or styles.
    const groups = new Map();
    for (let i = 0; i < result.cells.length; i++) {
      const teamId = tasks.get(result.cells[i].taskId).teamId;
      if (!groups.has(teamId))
        groups.set(teamId, { before: [], after: [], positions: [] });
      const group = groups.get(teamId);
      group.before.push(result.before[i]);
      group.after.push(result.cells[i]);
      group.positions.push(i);
    }
    for (const [teamId, group] of groups)
      refs.push({
        teamId,
        id: audit(
          db,
          actorId,
          teamId,
          "cells",
          result.operationId,
          group.before,
          group.after,
        ),
        positions: group.positions,
      });
  }
  db.prepare("INSERT INTO operations VALUES(?,?,?,?)").run(
    result.operationId,
    actorId,
    json({
      kind: "cell-audit",
      refs,
      savedAt: result.savedAt,
      updatedAt: result.updatedAt,
      ...(result.formatRevision !== undefined
        ? { formatRevision: result.formatRevision }
        : {}),
    }),
    result.savedAt,
  );
}

export function replayCellOperation(db, operation) {
  const stored = parse(operation.response);
  requireThat(
    stored?.kind === "cell-audit" && Array.isArray(stored.refs),
    409,
    "셀 저장 요청의 작업 ID가 아닙니다.",
  );
  const read = db.prepare(
    "SELECT before_json,after_json FROM audit WHERE id=? AND target=? AND actor_id=? AND action='cells'",
  );
  let before = [],
    cells = [];
  for (const ref of stored.refs) {
    const row = read.get(ref.id, operation.id, operation.actor_id);
    // Never treat an expired/missing snapshot as permission to apply a retry
    // again. Retention must keep a marker until its replay window has elapsed.
    requireThat(
      row,
      410,
      "재시도에 필요한 변경 이력이 없습니다. 최신 내용을 확인하세요.",
    );
    const previous = parse(row.before_json),
      saved = parse(row.after_json);
    if (stored.refs.length === 1) {
      before = previous;
      cells = saved;
    } else {
      for (let i = 0; i < ref.positions.length; i++) {
        const position = ref.positions[i];
        before[position] = previous[i];
        cells[position] = saved[i];
      }
    }
  }
  return {
    cells,
    before,
    operationId: operation.id,
    savedAt: stored.savedAt,
    updatedAt: stored.updatedAt,
    ...(stored.formatRevision !== undefined
      ? { formatRevision: stored.formatRevision }
      : {}),
  };
}
