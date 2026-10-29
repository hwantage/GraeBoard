import { z } from "zod";
import { yearSchema } from "../../shared/validation.js";
import {
  createTaskSchema,
  updateTaskSchema,
  taskVersionsSchema,
  reorderTaskSchema,
  saveViewSchema,
} from "./task-command-schema.mjs";
import {
  batchSchema,
  periodScopeSchema,
  requireThat,
} from "../../shared/validation.js";
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
  constructor(repository, user, ports) {
    this.repository = repository;
    this.user = user;
    this.documentEvents = ports?.documentEvents;
    this.clientId = ports?.clientId;
  }
  mutate(command, ...args) {
    if (!this.documentEvents || !this.repository.resourceChanges)
      return this.repository[command](this.user, ...args);
    const before = this.repository.resourceRevision(),
      result = this.repository[command](this.user, ...args);
    const committed = (value) => {
      for (const key of this.repository.resourceChanges(
        before,
        command,
        args[0],
      ))
        this.documentEvents.invalidate(key, this.clientId);
      return value;
    };
    return result?.then ? result.then(committed) : committed(result);
  }
  query(query, { ifNoneMatch } = {}) {
    const values =
      query instanceof URLSearchParams ? Object.fromEntries(query) : query;
    this.repository.authorizeTeam?.(this.user, String(values.teamId || ""));
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
    if (!this.documentEvents)
      return this.repository.saveBatch(this.user, request);
    return this.mutate("saveBatch", request);
  }
  create(body) {
    const request = createTaskSchema.parse(body);
    this.repository.authorizeTeam?.(this.user, request.teamId);
    periodScopeSchema.parse(request);
    return this.mutate("create", request);
  }
  update(taskId, body) {
    return this.mutate("update", String(taskId), updateTaskSchema.parse(body));
  }
  remove(body) {
    return this.mutate("remove", taskVersionsSchema.parse(body).tasks);
  }
  removeOne(taskId, body = {}) {
    return this.mutate("remove", [
      { id: String(taskId), updatedAt: body.updatedAt },
    ]);
  }
  restore(body) {
    return this.mutate("restore", taskVersionsSchema.parse(body).tasks);
  }
  restoreOne(taskId, body = {}) {
    const request = z
      .object({ updatedAt: z.string().datetime().optional() })
      .parse(body);
    return this.mutate("restore", [{ id: String(taskId), ...request }]);
  }
  reorder(body) {
    const request = reorderTaskSchema.parse(body);
    periodScopeSchema.parse(request);
    const requested = request.tasks || [{ id: request.taskId }],
      ids = new Set(requested.map((task) => task.id));
    requireThat(
      ids.size === requested.length,
      400,
      "같은 업무를 중복 선택할 수 없습니다.",
    );
    requireThat(
      !ids.has(request.targetId),
      400,
      "이동할 행 밖의 위치를 선택하세요.",
    );
    return this.mutate("reorder", request);
  }
  readViews(query) {
    this.repository.authorizeTeam?.(this.user, String(query.teamId || ""));
    return this.repository.readViews(this.user, {
      teamId: String(query.teamId || ""),
      year: yearSchema.parse(query.year),
    });
  }
  saveView(body) {
    return this.mutate("saveView", saveViewSchema.parse(body));
  }
  getMany(ids, options) {
    return this.repository.getMany(
      this.user,
      z.array(z.string().uuid()).max(20000).parse(ids),
      options,
    );
  }
  locate(id, options) {
    return this.repository.locate(this.user, String(id), options);
  }
  subscribe(query, port) {
    this.repository.authorizeTeam?.(this.user, String(query.teamId || ""));
    const period = periodScopeSchema.parse(query);
    return this.repository.subscribe(
      this.user,
      { teamId: String(query.teamId || ""), ...period },
      port,
    );
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
