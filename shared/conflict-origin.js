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
 * @param {Map<string, {actorRef: string, createdAt: string}>} local
 */
export function conflictPeople(conflicts, local) {
  const people = new Set();
  for (const conflict of conflicts)
    if (conflict.operation?.actorRef) people.add(conflict.operation.actorRef);
  for (const op of local.values()) if (op.actorRef) people.add(op.actorRef);
  return [...people];
}

/**
 * @param {"internal" | "external"} site this server's site
 * @param {Map<string, {actorRef: string, createdAt: string}>} local this
 *   site's own operations among conflictOpIds()
 * @param {Map<string, string>} names person ID → name
 * @param {string} [writerEpoch] this site's current writer epoch
 */
export function conflictOrigin(conflict, { site, local, names, writerEpoch }) {
  const actor = (ref) => (ref && names.get(ref)) || null;
  const operation = conflict.operation || {};
  const held = {
    site:
      local.has(conflict.opId) ||
      (writerEpoch && operation.writerEpoch === writerEpoch)
        ? site
        : PEER_SITE[site],
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
        ? { site: null, initial: true, actor: null, createdAt: null }
        : own
          ? { site, actor: actor(own.actorRef), createdAt: own.createdAt }
          : { site: PEER_SITE[site], actor: null, createdAt: null };
  }
  return { held, writers };
}
