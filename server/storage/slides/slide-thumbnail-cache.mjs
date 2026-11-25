// Card thumbnails as the file service handles them: what a valid one is, the
// bytes a site stores for it, and a memory cache per storage backend in front
// of that store. Stored or cached pixels convey no access: the file service
// checks the caller and the live file on every request.
import { Buffer } from "node:buffer";
import { MAX_SLIDE_THUMBNAIL_LENGTH } from "../../../shared/slides/slide-file-rules.js";

const caches = new WeakMap();
const maxCharacters = 6 * 1024 * 1024;
const prefix = "data:image/jpeg;base64,";

export function validSlideThumbnail(image) {
  if (image === "") return true; // Empty canvas.
  if (
    typeof image !== "string" ||
    image.length > MAX_SLIDE_THUMBNAIL_LENGTH ||
    !image.startsWith(prefix)
  )
    return false;
  const base64 = image.slice(prefix.length);
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(base64)) return false;
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.length < 12 ||
    bytes.readUInt16BE(0) !== 0xffd8 ||
    bytes.readUInt16BE(bytes.length - 2) !== 0xffd9
  )
    return false;
  for (let i = 2; i + 9 < bytes.length && bytes[i] === 0xff;) {
    const marker = bytes[i + 1];
    const length = bytes.readUInt16BE(i + 2);
    if (length < 2 || i + length + 2 > bytes.length) return false;
    if (marker === 0xc0 || marker === 0xc2) {
      const height = bytes.readUInt16BE(i + 5),
        width = bytes.readUInt16BE(i + 7);
      return (
        length >= 8 && width > 0 && width <= 384 && height > 0 && height <= 240
      );
    }
    i += length + 2;
  }
  return false;
}

// What a site stores for a valid thumbnail: the JPEG itself. An empty canvas
// is one zero byte, which no JPEG starts with; an empty object would not do,
// because the external site's bucket takes no empty upload.
export const slideThumbnailBytes = (image) =>
  image === ""
    ? Buffer.alloc(1)
    : Buffer.from(image.slice(prefix.length), "base64");
export const slideThumbnailImage = (bytes) =>
  bytes.length === 1 && bytes[0] === 0
    ? ""
    : prefix +
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
        "base64",
      );

// The first lookup in front of a site's stored thumbnails. The first value
// put under a key stays, as in the store.
export function slideThumbnailCache(scope) {
  if (!caches.has(scope)) {
    const entries = new Map();
    let characters = 0;
    caches.set(scope, {
      get(key) {
        const value = entries.get(key);
        if (value === undefined) return null;
        entries.delete(key);
        entries.set(key, value);
        return value;
      },
      put(key, value) {
        if (entries.has(key)) return;
        entries.set(key, value);
        characters += value.length;
        while (characters > maxCharacters || entries.size > 256) {
          const oldest = entries.keys().next().value;
          characters -= entries.get(oldest).length;
          entries.delete(oldest);
        }
      },
    });
  }
  return caches.get(scope);
}
