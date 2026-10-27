import { randomBytes, randomUUID } from "node:crypto";
import { canonical, digest } from "./protocol.mjs";

export const SETUP_KEY_MAX_BYTES = 512 * 1024;
export const SETUP_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const time = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
export function newSetupKey(teamId, userId, now = Date.now()) {
  const id = randomUUID(),
    token = `gbk_${id}.${randomBytes(32).toString("base64url")}`;
  return {
    token,
    record: {
      id,
      teamId,
      userId,
      tokenHash: digest(token),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SETUP_KEY_TTL_MS).toISOString(),
      revokedAt: null,
    },
  };
}
export function setupKeyId(token) {
  const match =
    typeof token === "string" &&
    /^gbk_([a-f0-9-]{36})\.[A-Za-z0-9_-]{43}$/.exec(token);
  return match && uuid.test(match[1]) ? match[1] : null;
}
export function validateSetupKeys(value, identity) {
  if (
    !value ||
    value.format !== "graeboard-setup-keys" ||
    value.version !== 1 ||
    !["teamId", "installationId", "repoId"].every(
      (k) => uuid.test(value[k]) && (!identity || value[k] === identity[k]),
    ) ||
    !Array.isArray(value.keys) ||
    value.keys.length > 1000 ||
    Object.keys(value).some(
      (k) =>
        ![
          "format",
          "version",
          "teamId",
          "installationId",
          "repoId",
          "keys",
        ].includes(k),
    )
  )
    throw new Error("Invalid setup key snapshot identity or format");
  const ids = new Set(),
    users = new Set();
  for (const key of value.keys) {
    if (
      !key ||
      !uuid.test(key.id) ||
      !uuid.test(key.userId) ||
      ids.has(key.id) ||
      users.has(key.userId) ||
      !/^[a-f0-9]{64}$/.test(key.tokenHash) ||
      !time(key.issuedAt) ||
      !time(key.expiresAt) ||
      Date.parse(key.expiresAt) <= Date.parse(key.issuedAt) ||
      Date.parse(key.expiresAt) - Date.parse(key.issuedAt) > SETUP_KEY_TTL_MS ||
      !(key.revokedAt === null || time(key.revokedAt)) ||
      Object.keys(key).some(
        (k) =>
          ![
            "id",
            "userId",
            "tokenHash",
            "issuedAt",
            "expiresAt",
            "revokedAt",
          ].includes(k),
      )
    )
      throw new Error("Invalid setup key verifier");
    ids.add(key.id);
    users.add(key.userId);
  }
  return value;
}
export function readSetupJson(bytes) {
  if (!bytes || bytes.byteLength > SETUP_KEY_MAX_BYTES)
    throw new Error("Setup key metadata exceeds byte limit");
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function publishSetupJson(transport, branch, file, value) {
  const serialized = canonical(value);
  if (Buffer.byteLength(serialized) > SETUP_KEY_MAX_BYTES)
    throw new Error("Setup key metadata exceeds byte limit");
  for (let attempt = 0; attempt < 3; attempt++) {
    const parent = await transport.readHead(branch);
    if (
      parent &&
      canonical(readSetupJson(await transport.readFile(parent, file))) ===
        serialized
    )
      return parent;
    const candidate = await transport.createCandidate(
      parent,
      { [file]: serialized },
      "Update team account linking",
    );
    if (await transport.publish(candidate, parent, branch)) return candidate;
  }
  throw new Error(
    "Setup key metadata changed concurrently; retry synchronization",
  );
}
