import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
function key() {
  const raw = Buffer.from(process.env.GRAEBOARD_SYNC_KEY || "", "base64");
  if (raw.length !== 32)
    throw new Error("GRAEBOARD_SYNC_KEY must contain a base64 32-byte key");
  return raw;
}
export function sealToken(token, profileId) {
  if (typeof token !== "string" || !token.trim() || token.length > 10000)
    throw new Error("Invalid Git credential");
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(Buffer.from(profileId));
  const bytes = Buffer.concat([
    cipher.update(token.trim(), "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    version: 1,
    keyId: process.env.GRAEBOARD_SYNC_KEY_ID || "default",
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: bytes.toString("base64"),
  });
}
function openToken(value, profileId) {
  const c = JSON.parse(value);
  if (
    c.version !== 1 ||
    c.keyId !== (process.env.GRAEBOARD_SYNC_KEY_ID || "default")
  )
    throw new Error("Unsupported credential encryption key");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(c.nonce, "base64"),
  );
  decipher.setAAD(Buffer.from(profileId));
  decipher.setAuthTag(Buffer.from(c.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(c.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
export function profileToken(db, profile) {
  const row = db
    .prepare("SELECT ciphertext FROM sync_credentials WHERE profile_id=?")
    .get(profile.profileId);
  return row
    ? openToken(row.ciphertext, profile.profileId)
    : process.env[profile.tokenEnv || "GRAEBOARD_GIT_TOKEN"];
}
