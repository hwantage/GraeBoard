import { z } from "zod";
import { requireThat } from "../../shared/validation.js";

export const MAX_ACCESS_TOKENS = 20;
export const accessTokenId = z.uuid();
export const accessTokenInput = z
  .object({
    id: accessTokenId,
    name: z.string().trim().min(1).max(80),
  })
  .strict();
const encode = (bytes) => btoa(String.fromCharCode(...bytes));
const decode = (value) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const encoder = new TextEncoder();
async function encryptionKey(secret) {
  let bytes;
  try {
    bytes = decode(secret || "");
  } catch {}
  requireThat(
    bytes?.length === 32,
    503,
    "접속 토큰 암호화 키 설정이 필요합니다.",
  );
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
const context = (userId, id) =>
  encoder.encode(`graeboard:access-token:${userId}:${id}`);
export async function tokenHash(token) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(token)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
// Existing browser/write endpoints still require login sessions, not these tokens.
export async function prepareAccessToken(input, { userId, key }) {
  const { id, name } = accessTokenInput.parse(input);
  const token =
    "gbt_" +
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: context(userId, id) },
    await encryptionKey(key),
    encoder.encode(token),
  );
  return {
    token,
    hash: await tokenHash(token),
    ciphertext: JSON.stringify({
      v: 1,
      iv: encode(iv),
      data: encode(new Uint8Array(bytes)),
    }),
    metadata: {
      id,
      name,
      prefix: token.slice(0, 12),
      createdAt: new Date().toISOString(),
    },
  };
}
export async function revealAccessToken(row, key) {
  requireThat(
    row.token_ciphertext,
    409,
    "접속 토큰의 암호문을 찾을 수 없습니다.",
  );
  const imported = await encryptionKey(key);
  try {
    const sealed = JSON.parse(row.token_ciphertext);
    if (sealed.v !== 1) throw new Error("Unsupported token envelope");
    const bytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decode(sealed.iv),
        additionalData: context(row.user_id, row.id),
      },
      imported,
      decode(sealed.data),
    );
    const token = new TextDecoder().decode(bytes);
    if ((await tokenHash(token)) !== row.token_hash)
      throw new Error("Token hash mismatch");
    return token;
  } catch {
    requireThat(
      false,
      503,
      "접속 토큰을 복호화하지 못했습니다. 서버의 암호화 키를 확인하세요.",
    );
  }
}
