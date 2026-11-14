// Where a conflict's two edits came from. Each site keeps the operations it
// published in sync_outbox, so an operation found there was made on this site
// and any other one came from the peer. A current record's version is
// "<opId>:<change index>" of the operation that last wrote it, or an initial
// token from the first publication.
// The Node server is always the internal site and the Edge one the external.

export const PEER_SITE = { internal: "external", external: "internal" };

export function writerOpId(record) {
  const version = record?.version;
  if (typeof version !== "string") return null;
  const colon = version.lastIndexOf(":");
  return colon > 0 ? version.slice(0, colon) : null;
}

/**
 * A conflict without the values of its command and of the current records:
 * what the conflict list shows and what tells where each edit came from. A
 * conflict over a sheet copy carries megabytes per side, so the list leaves
 * the values to the request for one conflict.
 */
export const conflictSummary = (conflict) => ({
  conflictId: conflict.conflictId,
  opId: conflict.opId,
  reason: conflict.reason,
  resolution: conflict.resolution ? true : null,
  operation: {
    ...conflict.operation,
    changes: (conflict.operation?.changes || []).map(({ entity, key }) => ({
      entity,
      key,
    })),
  },
  current:
    conflict.current &&
    Object.fromEntries(
      Object.entries(conflict.current).map(([id, record]) => {
        if (!record || typeof record !== "object") return [id, record];
        const { payload: _payload, ...rest } = record;
        return [id, rest];
      }),
    ),
});

/** Operation IDs to look up in this site's sync_outbox. */
export function conflictOpIds(conflicts) {
  const ids = new Set();
  for (const conflict of conflicts) {
    ids.add(conflict.opId);
    for (const record of Object.values(conflict.current || {})) {
      const id = writerOpId(record);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Person IDs whose names the origins show.
 * @param {...Map<string, {actorRef: string, createdAt: string}>} operations
 */
export function conflictPeople(conflicts, ...operations) {
  const people = new Set();
  for (const conflict of conflicts)
    if (conflict.operation?.actorRef) people.add(conflict.operation.actorRef);
  for (const map of operations)
    for (const op of map.values()) if (op.actorRef) people.add(op.actorRef);
  return [...people];
}

/**
 * @param {"internal" | "external"} site this server's site
 * @param {Map<string, {actorRef: string, createdAt: string}>} local this
 *   site's own operations among conflictOpIds()
 * @param {Map<string, string>} names person ID → name
 * @param {string} [writerEpoch] this site's current writer epoch
 * @param {Map<string, {actorRef: string, createdAt: string}>} [remote] peer
 *   operations this site could read (the internal site's Git clone)
 */
export function conflictOrigin(
  conflict,
  { site, local, names, writerEpoch, remote = new Map() },
) {
  const actor = (ref) => (ref && names.get(ref)) || null;
  const operation = conflict.operation || {};
  const held = {
    site:
      local.has(conflict.opId) ||
      (writerEpoch && operation.writerEpoch === writerEpoch)
        ? site
        : PEER_SITE[site],
    actorId: operation.actorRef || null,
    actor: actor(operation.actorRef),
    createdAt: operation.createdAt || null,
  };
  const writers = {};
  for (const [key, record] of Object.entries(conflict.current || {})) {
    const id = record && writerOpId(record);
    const own = id && local.get(id);
    writers[key] = !record
      ? null
      : !id
        ? {
            site: null,
            initial: true,
            actorId: null,
            actor: null,
            createdAt: null,
          }
        : own
          ? {
              site,
              actorId: own.actorRef || null,
              actor: actor(own.actorRef),
              createdAt: own.createdAt,
            }
          : {
              site: PEER_SITE[site],
              actorId: remote.get(id)?.actorRef || null,
              actor: actor(remote.get(id)?.actorRef),
              createdAt: remote.get(id)?.createdAt || null,
            };
  }
  return { held, writers };
}

export const RESOLUTION_PENDING =
  "이 충돌은 이미 해결 방법을 저장했습니다. 다음 동기화 때 공유됩니다.";

const REJECTED_BECAUSE = {
  "Duplicate name": "같은 이름이 이미 있어",
  "Concurrent field change": "그사이 같은 항목이 다시 바뀌어",
  "Failed dependency": "앞선 수정이 아직 보관된 상태라",
  "Parent task deleted": "상위 업무가 삭제되어",
  "Entity already exists": "같은 항목이 이미 있어",
  "Restore base changed": "복원하려던 항목이 그사이 바뀌어",
  "Entity generation changed": "항목이 그사이 다시 만들어져",
  "Delete conflicts with edit": "삭제하려던 항목이 그사이 고쳐져",
  "Entity deleted": "항목이 삭제되어",
};

/** `details.code` of a refused resolution, for the conflict box guidance. */
export const RESOLUTION_REJECTED = "resolution-rejected";

/**
 * A resolution applied after what is shared and pending that would itself be
 * archived as a new conflict. It would leave this conflict open and add
 * another one, so each retry would only grow the conflict box; both servers
 * refuse it before saving. `reason` is the reducer's conflict reason.
 */
export const resolutionRejected = (reason) => ({
  message: `${rejectedBecause(reason)} 먼저 수정으로 유지하거나 직접 고치기로 고친 뒤 적용하세요.`,
  details: { code: RESOLUTION_REJECTED, reason: reason || null },
});

/** "같은 이름이 이미 있어 반영하면 다시 충돌합니다." for a refused resolution. */
export const rejectedBecause = (reason) =>
  `${REJECTED_BECAUSE[reason] || "그사이 바뀐 내용과 부딪혀"} 반영하면 다시 충돌합니다.`;

// A resolution waiting to be published already decides these conflicts; a
// second one would race it and could itself conflict.
export const resolvesAny = (pending, conflictIds) =>
  pending.some((op) =>
    (op.resolves || []).some((id) => conflictIds.includes(id)),
  );

const changeKey = (change) => JSON.stringify([change.entity, change.key]);

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value ?? null);
}

/**
 * The unpublished resolution of each conflict and what it chose: "current"
 * writes nothing for the conflict's items, "submitted" writes their later
 * values and "edited" anything else.
 * @returns {Map<string, {opId: string, createdAt: string,
 *   choice: "current" | "submitted" | "edited"}>}
 */
export function pendingResolutions(conflicts, pending) {
  const result = new Map();
  for (const conflict of conflicts) {
    const op = pending.find((item) =>
      (item.resolves || []).includes(conflict.conflictId),
    );
    if (!op) continue;
    const later = new Map(
      conflict.operation.changes.map((change) => [
        changeKey(change),
        canonical(change.desired),
      ]),
    );
    const own = (op.changes || []).filter((change) =>
      later.has(changeKey(change)),
    );
    result.set(conflict.conflictId, {
      opId: op.opId,
      createdAt: op.createdAt,
      choice: !own.length
        ? "current"
        : own.every(
              (change) =>
                later.get(changeKey(change)) === canonical(change.desired),
            )
          ? "submitted"
          : "edited",
    });
  }
  return result;
}
