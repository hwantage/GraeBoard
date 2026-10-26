import { batchSchema, periodScopeSchema, requireThat } from "../validation.mjs";
import { normalizeCellStyle } from "../../shared/formatting.js";
import { sameStyle } from "../../shared/compact.js";

export function validateCellCommandTime(createdAt, time = Date.now()) {
  const stamp = Date.parse(createdAt);
  requireThat(
    stamp > time - 7 * 86400000,
    410,
    "저장 요청의 7일 유효기간이 지났습니다. 입력을 복사해 보관한 뒤 최신 내용을 확인하고 다시 편집하세요.",
  );
  requireThat(
    stamp <= time + 300000,
    400,
    "저장 요청 시각이 올바르지 않습니다. 기기의 날짜와 시간을 확인하세요.",
  );
}

// Ordinary task/cell command contract. Repositories own storage, permissions,
// atomic audit/idempotency/outbox and event delivery; no SQL escapes to callers.
// A synchronous repository stays synchronous, including the SQLite transaction.
export class TaskBusinessService {
  constructor(repository, user) {
    this.repository = repository;
    this.user = user;
  }
  query(query, { ifNoneMatch } = {}) {
    const values =
      query instanceof URLSearchParams ? Object.fromEntries(query) : query;
    const period = periodScopeSchema.parse(values);
    return this.repository.query(this.user, {
      teamId: String(values.teamId || ""),
      ...period,
      deleted: values.deleted === "1",
      ifNoneMatch,
    });
  }
  saveBatch(body) {
    const request = batchSchema.parse(body);
    validateCellCommandTime(request.createdAt);
    return this.repository.saveBatch(this.user, request);
  }
}

// Pure common business rule. The adapter supplies domain validation inputs and
// persistence revision allocation, not an engine-specific branch in the rule.
export function prepareCellChange({
  change,
  task,
  previous,
  formatRevision,
  normalize,
  validateValue,
}) {
  validateValue();
  requireThat(
    previous.version === change.expectedVersion,
    409,
    "다른 사용자가 이 셀을 수정했습니다. 최신 내용을 확인한 뒤 다시 적용하세요.",
    {
      taskId: change.taskId,
      key: change.key,
      current: previous,
      attempted: change,
    },
  );
  if (change.style !== undefined)
    requireThat(
      (change.expectedFormatRevision ?? 0) === formatRevision,
      409,
      "공통 서식이 변경되었습니다. 최신 내용을 확인한 뒤 다시 적용하세요.",
    );
  const value = change.value === undefined ? previous.value : change.value,
    style =
      change.style === undefined
        ? previous.style
        : change.rawStyle
          ? change.style
          : task.formatting?.rules.length || task.rowStyle
            ? normalizeCellStyle(task, change.key, change.style)
            : normalize(change.style, task.defaultStyle);
  if (
    (value === previous.value ||
      (Array.isArray(value) &&
        Array.isArray(previous.value) &&
        value.length === previous.value.length &&
        value.every((v, i) => v === previous.value[i]))) &&
    sameStyle(style, previous.style)
  )
    return null;
  return { value, style };
}
