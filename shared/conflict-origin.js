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
