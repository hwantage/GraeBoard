import { gzipSync, gunzipSync } from "node:zlib";
import { canonical } from "./protocol.mjs";

import { SYNC_SNAPSHOT_MAX_BYTES as MAX_SNAPSHOT_BYTES } from "../../shared/sync-limits.js";
export function encodeSnapshot(value) {
  const source = Buffer.from(canonical(value));
  if (source.length > MAX_SNAPSHOT_BYTES)
    throw new Error("Snapshot exceeds uncompressed byte budget");
  const bytes = gzipSync(source, { level: 1 });
  if (bytes.length > MAX_SNAPSHOT_BYTES)
    throw new Error("Snapshot exceeds Git object byte budget");
  return bytes;
}
export function decodeSnapshot(bytes) {
  if (!bytes || bytes.byteLength > MAX_SNAPSHOT_BYTES)
    throw new Error("Snapshot exceeds byte budget");
  const source =
    bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes, { maxOutputLength: MAX_SNAPSHOT_BYTES })
      : bytes;
  return JSON.parse(new TextDecoder().decode(source));
}
// The frozen pre-publication snapshot is restart state, not link metadata.
// Compress it before sending across the Node worker boundary or storing TEXT.
export function encodeStoredSnapshot(value) {
  return canonical({
    encoding: "gzip-base64",
    data: encodeSnapshot(value).toString("base64"),
  });
}
export function decodeStoredSnapshot(text) {
  const value = JSON.parse(text);
  return value.encoding === "gzip-base64"
    ? decodeSnapshot(Buffer.from(value.data, "base64"))
    : value;
}
