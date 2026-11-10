import { canonical, digest } from "./protocol.mjs";

// These advisory branches are owned by one installation. Cache only a successful
// CAS or verified identical value, and recheck at least once a minute. Canonical
// history publication deliberately does not use this cache.
const verified = new WeakMap();
export async function publishBranchJson(
  transport,
  {
    branch,
    file,
    value,
    maxBytes,
    message,
    decode,
    unchanged = (previous, current) =>
      canonical(previous) === canonical(current),
    cacheKey = digest(value),
    expiresAt = () => now() + 60000,
    now = () => Date.now(),
    conflictMessage = "Metadata changed concurrently; retry synchronization",
  },
) {
  const serialized = canonical(value);
  if (Buffer.byteLength(serialized) > maxBytes)
    throw new Error("Synchronization metadata exceeds byte limit");
  let entries = verified.get(transport);
  if (!entries) verified.set(transport, (entries = new Map()));
  const key = branch + "/" + file,
    cached = entries.get(key);
  if (cached?.value === cacheKey && cached.expiresAt > now()) return cached.oid;
  entries.delete(key);
  const remember = (oid, snapshot) => {
    // Setup metadata is bounded by the number of users, and old branch keys may
    // be replaced after reconnection. Keep transport lifetime storage bounded.
    if (entries.size >= 1024) entries.delete(entries.keys().next().value);
    entries.set(key, { value: cacheKey, oid, expiresAt: expiresAt(snapshot) });
    return oid;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const parent = await transport.readHead(branch);
    if (parent) {
      const previous = decode(await transport.readFile(parent, file));
      if (unchanged(previous, value)) return remember(parent, previous);
    }
    const candidate = await transport.createCandidate(
      parent,
      { [file]: serialized },
      message,
    );
    if (await transport.publish(candidate, parent, branch))
      return remember(candidate, value);
  }
  throw Object.assign(new Error(conflictMessage), {
    status: 409,
    code: "SYNC_PUBLICATION_CONFLICT",
  });
}
