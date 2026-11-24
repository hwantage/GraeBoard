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
    // More JSON files of the same commit ({file, value, maxBytes, decode}). Each
    // is compared by its canonical text; one the parent lacks counts as changed.
    more = [],
    // Further files a changed publication writes, given the parent's decoded
    // `more` values (null where absent). The parent tree keeps every other file.
    attachments = () => ({}),
    cacheKey = digest(
      more.length ? [value, ...more.map((d) => d.value)] : value,
    ),
    expiresAt = () => now() + 60000,
    now = () => Date.now(),
    conflictMessage = "Metadata changed concurrently; retry synchronization",
  },
) {
  const documents = [{ file, value, maxBytes }, ...more].map((document) => {
    const serialized = canonical(document.value);
    if (Buffer.byteLength(serialized) > document.maxBytes)
      throw new Error("Synchronization metadata exceeds byte limit");
    return { ...document, serialized };
  });
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
    let others = more.map(() => null);
    if (parent) {
      const previous = decode(await transport.readFile(parent, file));
      if (more.length) {
        const present = new Set(
          (await transport.readCommit(parent)).files.map((f) => f.path),
        );
        others = await Promise.all(
          more.map(async (document) =>
            present.has(document.file)
              ? document.decode(await transport.readFile(parent, document.file))
              : null,
          ),
        );
      }
      if (
        unchanged(previous, value) &&
        others.every(
          (other, i) =>
            other && canonical(other) === documents[i + 1].serialized,
        )
      )
        return remember(parent, previous);
    }
    const candidate = await transport.createCandidate(
      parent,
      {
        ...(await attachments(others)),
        ...Object.fromEntries(documents.map((d) => [d.file, d.serialized])),
      },
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
