import { canonical, entityId } from "./protocol.mjs";

export const retentionKey = (row) => row.key || JSON.parse(row.entity_key);
export const retentionId = (row) =>
  canonical([row.kind, retentionKey(row), row.generation || ""]);
export function isExcluded(record, state, retentions = []) {
  if (!record) return false;
  const entities = state.entities || state;
  const years = new Set(
    retentions
      .filter((r) => r.kind === "year")
      .map((r) => String(retentionKey(r)[0])),
  );
  if (record.entity === "task")
    return (
      record.payload.years.length > 0 &&
      record.payload.years.every((year) => years.has(String(year)))
    );
  if (record.entity === "report") return years.has(String(record.payload.year));
  if (record.entity === "cell")
    return isExcluded(
      entities[entityId("task", [record.key[0]])],
      entities,
      retentions,
    );
  if (record.entity !== "document") return false;
  if (
    retentions.some(
      (r) =>
        r.kind === "document" &&
        canonical(retentionKey(r)) === canonical(record.key) &&
        r.generation === record.generation,
    )
  )
    return true;
  const [owner, id] = record.key;
  if (owner === "annual") return years.has(String(id));
  const parent =
    owner === "task"
      ? "task"
      : owner.startsWith("report")
        ? "report"
        : "calendar";
  return isExcluded(entities[entityId(parent, [id])], entities, retentions);
}

// URLs are content-addressed. Keep this parser free of Node image/DB dependencies
// so the internal server and Worker apply the same protection rules.
export function imageReferences(value, teamId) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const urls = [
    ...new Set(
      text.match(
        /\/api\/document-images\/[a-zA-Z0-9_-]+\/[a-f0-9]{64}\.webp/g,
      ) || [],
    ),
  ];
  if (
    teamId &&
    urls.some((url) => !url.startsWith(`/api/document-images/${teamId}/`))
  )
    throw new Error("Foreign team image reference");
  return urls;
}

export function activeImageReferences(
  state,
  pending,
  retentions,
  projected = state.entities,
  teamId,
) {
  const urls = new Set();
  for (const record of Object.values(projected))
    if (!record.deleted && !isExcluded(record, projected, retentions)) {
      for (const url of imageReferences(record.payload, teamId)) urls.add(url);
    }
  for (const url of imageReferences(
    {
      pending,
      conflicts: Object.values(state.conflicts || {}).filter(
        (conflict) => !conflict.resolution,
      ),
    },
    teamId,
  ))
    urls.add(url);
  return urls;
}
