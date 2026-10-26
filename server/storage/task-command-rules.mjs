import { requireThat } from "../validation.mjs";
import {
  propertiesFor,
  fieldsFor,
  isAssignable,
  emptyPropertyValue,
  periodYears,
  groupValue,
} from "../../shared/domain.js";

export function taskCreationFields(settings, user, request) {
  const self = isAssignable(user, request.teamId) ? user.id : "";
  return {
    ...Object.fromEntries(
      propertiesFor(settings)
        .map((p) => [
          p.id,
          p.id === "title"
            ? "새 업무"
            : p.id === "owner" && request.sourceId
              ? self
              : emptyPropertyValue(p),
        ])
        .filter(
          ([, value]) =>
            value !== "" && (!Array.isArray(value) || value.length),
        ),
    ),
    ...request.fields,
  };
}
export function validatePersonalView(data, settings) {
  const keys = fieldsFor(settings).map((f) => f.key),
    properties = propertiesFor(settings);
  requireThat(
    (data.visibleFields || []).every((key) => keys.includes(key)),
    400,
    "이 팀의 표시 열을 선택하세요.",
  );
  requireThat(
    !data.groupBy || properties.some((p) => p.id === data.groupBy),
    400,
    "이 팀의 묶음 속성을 선택하세요.",
  );
  requireThat(
    [
      ...Object.keys(data.propertyFilters || {}),
      ...Object.keys(data.propertyFilterModes || {}),
    ].every((key) => properties.some((p) => p.id === key)),
    400,
    "이 팀의 속성 필터를 선택하세요.",
  );
}
export function planTaskReorder(tasks, request, settings) {
  const requested = request.tasks || [
      { id: request.taskId, updatedAt: request.updatedAt },
    ],
    ids = new Set(requested.map((t) => t.id)),
    years = periodYears(request.year, request.startMonth),
    target = tasks.find((t) => t.id === request.targetId),
    sources = requested.map((r) => tasks.find((t) => t.id === r.id));
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
  requireThat(
    target && sources.every(Boolean),
    404,
    "업무를 찾을 수 없습니다.",
  );
  requireThat(
    sources.every(
      (source) =>
        source.teamId === target.teamId &&
        source.years.some((year) => years.includes(year)),
    ) && target.years.some((year) => years.includes(year)),
    400,
    "같은 팀과 연도의 업무를 선택하세요.",
  );
  requireThat(
    sources.every(
      (source, index) => source.updatedAt === requested[index].updatedAt,
    ) && target.updatedAt === request.targetUpdatedAt,
    409,
    "업무가 변경되었습니다. 새로고침 후 순서를 다시 변경하세요.",
  );
  requireThat(
    !request.groupBy ||
      propertiesFor(settings).some((p) => p.id === request.groupBy),
    400,
    "유효한 묶음 속성을 선택하세요.",
  );
  requireThat(
    !request.groupBy ||
      sources.every(
        (source) =>
          groupValue(source, request.groupBy) ===
          groupValue(target, request.groupBy),
      ),
    400,
    "묶음 보기에서는 같은 묶음 안에서만 이동할 수 있습니다.",
  );
  const all = tasks
      .filter(
        (t) => !t.deletedAt && t.years.some((year) => years.includes(year)),
      )
      .sort(
        (a, b) =>
          a.position - b.position ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      )
      .map((task) => ({ ...task })),
    moving = all.filter((t) => ids.has(t.id)),
    rebased = [];
  const neighbors = () => {
    const rows = all.filter(
        (t) =>
          !ids.has(t.id) &&
          (!request.groupBy ||
            groupValue(t, request.groupBy) ===
              groupValue(target, request.groupBy)),
      ),
      index =
        rows.findIndex((t) => t.id === target.id) +
        (request.placement === "after" ? 1 : 0);
    return [rows[index - 1], rows[index]];
  };
  let [before, after] = neighbors();
  if (
    before &&
    after &&
    (after.position - before.position) / (moving.length + 1) < 0.000001
  ) {
    all.forEach((task, index) => {
      task.position = (index + 1) * 1000;
      rebased.push(task);
    });
    [before, after] = neighbors();
  }
  const step =
      before && after
        ? (after.position - before.position) / (moving.length + 1)
        : 100,
    start = before
      ? before.position
      : after.position - step * (moving.length + 1);
  moving.forEach((task, index) => {
    task.position = start + step * (index + 1);
  });
  return {
    moving,
    rebased: rebased.filter((task) => !ids.has(task.id)),
    target,
  };
}

export function taskInsertionPlan(rows, targetId, placement) {
  const ordered = rows.map((row) => ({ ...row })),
    target = ordered.findIndex((row) => row.id === targetId);
  requireThat(target >= 0, 409, "기준 행이 변경되었습니다. 다시 선택하세요.");
  const index = target + (placement === "after" ? 1 : 0);
  const calculate = () => {
    const before = ordered[index - 1]?.position,
      after = ordered[index]?.position;
    return before === undefined
      ? after - 100
      : after === undefined
        ? before + 100
        : before + (after - before) / 2;
  };
  let position = calculate();
  if (
    Number.isFinite(position) &&
    (!ordered[index - 1] || position > ordered[index - 1].position) &&
    (!ordered[index] || position < ordered[index].position)
  )
    return { position, rebased: [] };
  ordered.forEach((row, index) => {
    row.position = (index + 1) * 1000;
  });
  position = calculate();
  return { position, rebased: ordered };
}
