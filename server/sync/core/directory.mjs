import { publishBranchJson } from "./branch-publication.mjs";
import { digest } from "./protocol.mjs";
import { profileFields } from "../../../shared/identity/profiles.js";

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

// Avatars travel beside directory.json, which keeps version 1 so readers that
// predate them go on applying members (2026-11-24). avatars.json names each
// member's colour, initials and the SHA-256 of their image; the image itself is
// avatars/<id>.txt, written only when that hash changes and emptied when the
// image is removed. An unchanged picture is never written or fetched again.
export const AVATARS_FILE = "avatars.json";
export const avatarFile = (id) => `avatars/${id}.txt`;
const hash = /^[0-9a-f]{64}$/;
const validColor = (value) =>
  typeof value === "string" && profileFields.color.safeParse(value).success;
const validInitials = (value) =>
  typeof value === "string" &&
  profileFields.avatarInitials.safeParse(value).data === value;
export function validateAvatars(value, { teamId, installationId, repoId }) {
  const valid =
    value?.format === "graeboard-team-avatars" &&
    value.version === 1 &&
    value.teamId === teamId &&
    value.installationId === installationId &&
    value.repoId === repoId &&
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
  if (!valid) throw new Error("Invalid team avatars identity or format");
  const ids = new Set();
  for (const member of value.members) {
    if (
      !member ||
      !uuid.test(member.id) ||
      ids.has(member.id) ||
      !validColor(member.color) ||
      !validInitials(member.initials) ||
      (member.image !== "" && !hash.test(member.image)) ||
      Object.keys(member).some(
        (k) => !["id", "color", "initials", "image"].includes(k),
      )
    )
      throw new Error("Invalid team avatar member");
    ids.add(member.id);
  }
  return value;
}
export function decodeAvatars(bytes, identity) {
  if (!bytes || bytes.byteLength > DIRECTORY_MAX_BYTES)
    throw new Error("Team avatars exceed byte limit");
  return validateAvatars(JSON.parse(new TextDecoder().decode(bytes)), identity);
}
// An image file must be the picture its list entry names.
export function decodeAvatarImage(bytes, expected) {
  const image = bytes && new TextDecoder().decode(bytes);
  if (
    !image ||
    digest(image) !== expected ||
    !profileFields.avatarImage.safeParse(image).success
  )
    throw new Error("Invalid team avatar image");
  return image;
}
// The avatar list of a directory from its members' profiles ({id, color,
// avatarInitials, avatarImage}). A member whose stored profile breaks the
// profile rules is left out (skipped), so the other site keeps what it has.
export function teamAvatars(directory, profiles) {
  const members = [],
    images = new Map(),
    skipped = [];
  for (const { id, color, avatarInitials, avatarImage } of profiles) {
    const image = avatarImage || "";
    if (
      !validColor(color) ||
      !validInitials(avatarInitials || "") ||
      (image && !profileFields.avatarImage.safeParse(image).success)
    ) {
      skipped.push(id);
      continue;
    }
    members.push({
      id,
      color,
      initials: avatarInitials || "",
      image: image && digest(image),
    });
    if (image) images.set(id, image);
  }
  return {
    value: {
      format: "graeboard-team-avatars",
      version: 1,
      teamId: directory.teamId,
      installationId: directory.installationId,
      repoId: directory.repoId,
      members,
    },
    images,
    skipped,
  };
}
export async function publishDirectory(transport, value, avatars) {
  validateDirectory(value);
  if (avatars) validateAvatars(avatars.value, value);
  return publishBranchJson(transport, {
    branch: "sync-directory/" + value.installationId,
    file: "directory.json",
    value,
    maxBytes: DIRECTORY_MAX_BYTES,
    message: "Update team members",
    decode: (bytes) => decodeDirectory(bytes, value),
    ...(avatars && {
      more: [
        {
          file: AVATARS_FILE,
          value: avatars.value,
          maxBytes: DIRECTORY_MAX_BYTES,
          decode: (bytes) => decodeAvatars(bytes, value),
        },
      ],
      attachments: ([previous]) => {
        const before = new Map(
          previous?.members.map((member) => [member.id, member.image]),
        );
        return Object.fromEntries(
          avatars.value.members
            .filter((member) => member.image !== (before.get(member.id) || ""))
            .map((member) => [
              avatarFile(member.id),
              avatars.images.get(member.id) || "",
            ]),
        );
      },
    }),
    conflictMessage:
      "Team directory changed concurrently; retry synchronization",
  });
}
