import { canonical, entityId } from "./protocol.mjs";
import { documentPayloadImageUrls } from "../../shared/document-image-references.js";
import {
  DOCUMENT_IMAGE_PATTERN,
  documentImageSource,
  isDocumentImage,
} from "../../shared/document-images.js";

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
  const urls = documentPayloadImageUrls(value);
  for (const url of urls)
    if (
      !isDocumentImage(url) ||
      (teamId && DOCUMENT_IMAGE_PATTERN.exec(url)?.[1] !== teamId)
    )
      throw new Error("Foreign or invalid image reference");
  return urls;
}

// Historical audit rows can include arbitrary cell/title strings and older
// serialized shapes. Conservatively protect valid own-team files, but a foreign
// URL in that free text must never abort maintenance or protect another tenant.
export function auditImageReferences(value, teamId) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return [
    ...new Set(
      (
        text?.match(
          /\/api\/document-images\/[a-zA-Z0-9_-]+\/[a-f0-9]{64}\.webp/g,
        ) || []
      ).filter(
        (url) =>
          isDocumentImage(url) &&
          DOCUMENT_IMAGE_PATTERN.exec(url)?.[1] === teamId,
      ),
    ),
  ];
}

export function installImageReferences(
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

// Cleanup and backup restoration retain recoverable local bytes. Receiving a
// Git commit uses installImageReferences instead: historical deletion alone is
// not a reason to download an image into the current site's live image store.
export function activeImageReferences(
  state,
  pending,
  retentions,
  projected = state.entities,
  teamId,
) {
  const urls = installImageReferences(
    state,
    pending,
    retentions,
    projected,
    teamId,
  );
  for (const record of [
    ...Object.values(state.entities || {}),
    ...Object.values(projected),
  ])
    if (record.deleted && !isExcluded(record, projected, retentions))
      for (const url of imageReferences(record.payload, teamId)) urls.add(url);
  for (const url of state.recoveryImages || [])
    if (
      isDocumentImage(url) &&
      (!teamId || DOCUMENT_IMAGE_PATTERN.exec(url)?.[1] === teamId)
    )
      urls.add(documentImageSource(url));
  return urls;
}
export const protectedImageReferences = activeImageReferences;
