// A disposable cache per storage backend. Cached pixels convey no access:
// the file service checks the caller and the live file on every request.
import { Buffer } from "node:buffer";
import { requireThat } from "../../../shared/validation.js";

const caches = new WeakMap();
const maxCharacters = 6 * 1024 * 1024;
const prefix = "data:image/jpeg;base64,";

export function validSlideThumbnail(image) {
  if (image === "") return true; // Empty canvas.
  if (
    typeof image !== "string" ||
    image.length > 160 * 1024 ||
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
        requireThat(
          validSlideThumbnail(value),
          400,
          "올바르지 않은 미리보기입니다.",
        );
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
