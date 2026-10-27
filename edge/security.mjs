import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

export function secretMatches(value, expected) {
  if (typeof expected !== "string" || expected.length < 32) return false;
  const a = Buffer.from(value || ""),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const privateHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function failure(status, message) {
  return Response.json({ error: message }, { status, headers: privateHeaders });
}
