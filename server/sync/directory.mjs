import { canonical, digest } from "./protocol.mjs";

export const DIRECTORY_MAX_BYTES = 512 * 1024;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// This is a one-way directory, outside the editable business history. External
// account approvals and Google identities are never sent back to the intranet.
export function validateDirectory(
  value,
  { teamId, installationId, repoId } = {},
) {
  const valid =
    value?.format === "graeboard-team-directory" &&
    value.version === 1 &&
    uuid.test(value.teamId) &&
    uuid.test(value.installationId) &&
    uuid.test(value.repoId) &&
    (!teamId || value.teamId === teamId) &&
    (!installationId || value.installationId === installationId) &&
    (!repoId || value.repoId === repoId) &&
    Array.isArray(value.members) &&
    value.members.length <= 1000 &&
    Object.keys(value).every((k) =>
      [
        "format",
        "version",
        "teamId",
        "installationId",
        "repoId",
        "members",
      ].includes(k),
    );
  if (!valid) throw new Error("Invalid team directory identity or format");
  const ids = new Set();
  for (const member of value.members) {
    if (
      !member ||
      !uuid.test(member.id) ||
      ids.has(member.id) ||
      typeof member.name !== "string" ||
      !member.name.trim() ||
      member.name.length > 50 ||
      typeof member.email !== "string" ||
      member.email.length > 254 ||
      typeof member.active !== "boolean" ||
      !["lead", "member", "viewer"].includes(member.role) ||
      Object.keys(member).some(
        (k) => !["id", "name", "email", "active", "role"].includes(k),
      )
    )
      throw new Error("Invalid team directory member");
    ids.add(member.id);
  }
  return value;
}
export function decodeDirectory(bytes, identity) {
  if (!bytes || bytes.byteLength > DIRECTORY_MAX_BYTES)
    throw new Error("Team directory exceeds byte limit");
  return validateDirectory(
    JSON.parse(new TextDecoder().decode(bytes)),
    identity,
  );
}
export async function publishDirectory(transport, value) {
  validateDirectory(value);
  const serialized = canonical(value);
  if (new TextEncoder().encode(serialized).byteLength > DIRECTORY_MAX_BYTES)
    throw new Error("Team directory exceeds byte limit");
  const branch = "sync-directory/" + value.installationId;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parent = await transport.readHead(branch);
    if (parent) {
      const previous = decodeDirectory(
        await transport.readFile(parent, "directory.json"),
        value,
      );
      if (digest(previous) === digest(value)) return parent;
    }
    const candidate = await transport.createCandidate(
      parent,
      { "directory.json": serialized },
      "Update team members",
    );
    if (await transport.publish(candidate, parent, branch)) return candidate;
  }
  throw new Error("Team directory changed concurrently; retry synchronization");
}
