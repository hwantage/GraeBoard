import { randomUUID } from "node:crypto";
import { equal, entityId, initialToken } from "./protocol.mjs";
export function entityReferences(entity, key, payload) {
  const refs = [];
  if (entity === "cell") refs.push(["task", [key[0]]]);
  if (entity === "document") {
    const parent =
      key[0] === "task"
        ? "task"
        : key[0] === "calendar"
          ? "calendar"
          : key[0].startsWith("report")
            ? "report"
            : null;
    if (parent) refs.push([parent, [key[1]]]);
  }
  if (payload?.createdBy) refs.push(["person", [payload.createdBy]]);
  if (payload?.userId) refs.push(["person", [payload.userId]]);
  if (entity === "calendar")
    for (const tag of payload?.tags || []) refs.push(["tag", [tag.id]]);
  if (entity === "weekly") refs.push(["person", [key[0]]], ["task", [key[2]]]);
  return refs;
}

export function makeOperation({
  link,
  actorRef,
  before,
  after,
  prior = {},
  getPrior,
  opId = randomUUID(),
  createdAt = new Date().toISOString(),
  resolves,
}) {
  const changes = [],
    depends = new Set();
  for (const [key, next] of Object.entries(after)) {
    const previous = before[key] || null;
    if (
      equal(previous?.payload ?? null, next?.payload ?? null) &&
      !!previous?.deleted === !!next?.deleted
    )
      continue;
    const sample = next || previous;
    if (!sample) continue;
    const dependencies = [
      key,
      ...entityReferences(sample.entity, sample.key, next?.payload).map(
        ([entity, key]) => entityId(entity, key),
      ),
    ];
    for (const reference of dependencies) {
      const dependency = getPrior?.(reference) || prior[reference];
      if (dependency) depends.add(dependency);
    }
    const base = previous?.payload ?? null,
      desired = next?.payload ?? null;
    const action = !previous
      ? "create"
      : !next || next.deleted
        ? "delete"
        : previous.deleted
          ? "restore"
          : "edit";
    changes.push({
      entity: sample.entity,
      key: sample.key,
      generation:
        action === "restore"
          ? opId
          : previous?.generation ||
            initialToken(
              link.bootstrap_id || link.bootstrapId,
              sample.entity,
              sample.key,
            ),
      baseVersion: previous?.version || null,
      action,
      base,
      desired,
      fields: [
        ...new Set([...Object.keys(base || {}), ...Object.keys(desired || {})]),
      ].filter((field) => !equal(base?.[field], desired?.[field])),
    });
  }
  if (!changes.length && !resolves?.length) return null;
  return {
    protocol: 1,
    reducer: 1,
    repoId: link.repo_id || link.repoId,
    teamId: link.team_id || link.teamId,
    opId,
    writerEpoch: link.writer_epoch || link.writerEpoch,
    actorRef,
    createdAt,
    dependsOn: [...depends],
    changes,
    objects: [],
    ...(resolves ? { resolves } : {}),
  };
}
