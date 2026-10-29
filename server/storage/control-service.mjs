import { z } from "zod";
import { THEME_IDS } from "../../shared/themes.js";
import {
  TEAM_ROLES,
  isSystemAdmin,
  canManageTeam,
} from "../../shared/domain.js";
import { requireThat } from "../../shared/validation.js";
import { profileFields } from "../../shared/profiles.js";

export const loginId = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine(
    (v) => z.email().safeParse(v).success,
    "아이디는 이메일 주소로 입력하세요.",
  );
export const credentials = z.object({
  username: loginId,
  password: z.string().min(10).max(128),
});
export const systemRoles = z.enum(["admin", "user"]);
export const teamMemberRowsSchema = z
  .array(
    z.object({ userId: z.string().uuid(), role: z.enum(TEAM_ROLES) }).strict(),
  )
  .max(1000)
  .refine(
    (rows) => new Set(rows.map((r) => r.userId)).size === rows.length,
    "같은 사용자를 중복으로 추가할 수 없습니다.",
  );
export const userMembershipRowsSchema = z
  .array(
    z.object({ teamId: z.string().uuid(), role: z.enum(TEAM_ROLES) }).strict(),
  )
  .max(50)
  .refine(
    (rows) => new Set(rows.map((r) => r.teamId)).size === rows.length,
    "같은 팀을 중복으로 선택할 수 없습니다.",
  );
const userFields = {
  username: loginId,
  name: z.string().trim().min(1).max(50),
  ...profileFields,
  active: z.boolean(),
  systemRole: systemRoles,
  memberships: userMembershipRowsSchema,
  // Credentials are required by the SQLite authentication adapter. Access
  // controls identities externally, but supplied values still need valid types.
  password: credentials.shape.password.optional(),
};
const createControlUserSchema = z.object({
  ...userFields,
  active: userFields.active.default(true),
  systemRole: systemRoles.default("user"),
  memberships: userMembershipRowsSchema.default([]),
});
const updateControlUserSchema = z
  .object(userFields)
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    "변경할 사용자 정보를 입력하세요.",
  );
export function memberPickerUser(row) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    active: !!row.active,
    color: row.color,
    avatarInitials: row.avatar_initials || "",
    avatarImage: row.avatar_image || "",
  };
}
export const teamSchema = z.object({
  name: z.string().trim().min(1).max(80),
  theme: z.enum(THEME_IDS).optional(),
});
export const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(50).optional(),
    ...profileFields,
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "변경할 프로필을 입력하세요.",
  );

// Authentication is a host port (cookie/password internally, Access externally).
// Authorized control commands use this same service with either engine.
export class ControlBusinessService {
  constructor(repository, user, { documentEvents, clientId } = {}) {
    this.repository = repository;
    this.user = user;
    this.documentEvents = documentEvents;
    this.clientId = clientId;
  }
  execute(command, input = {}, targetId) {
    if (command === "profile") input = profileSchema.parse(input);
    if (
      [
        "listUsers",
        "createUser",
        "updateUser",
        "createTeam",
        "deleteTeam",
      ].includes(command)
    )
      requireThat(
        isSystemAdmin(this.user),
        403,
        "시스템 관리자 권한이 필요합니다.",
      );
    if (targetId) z.string().uuid().parse(targetId);
    if (["members", "replaceMembers"].includes(command))
      this.repository.authorizeMembers?.(this.user, targetId);
    if (["members", "replaceMembers"].includes(command))
      requireThat(
        canManageTeam(this.user, targetId),
        403,
        "팀장 권한이 필요합니다.",
      );
    if (command === "createUser") input = createControlUserSchema.parse(input);
    if (command === "updateUser") input = updateControlUserSchema.parse(input);
    if (command === "replaceMembers")
      input = z
        .object({
          members: teamMemberRowsSchema,
          previous: teamMemberRowsSchema.optional(),
        })
        .strict()
        .parse(input);
    if (command === "createTeam")
      input = teamSchema
        .extend({
          id: z.string().uuid().optional(),
          templateTeamId: z.string().uuid().optional(),
          members: teamMemberRowsSchema.default([]),
        })
        .parse(input);
    if (command === "deleteTeam")
      input = z
        .object({ confirmed: z.literal(true) })
        .strict()
        .parse(input);
    const result = this.repository.execute(this.user, command, input, targetId);
    const done = (value) => {
      if (["replaceMembers", "deleteTeam"].includes(command))
        this.documentEvents?.invalidate("team:" + targetId, this.clientId);
      return value;
    };
    return result && typeof result.then === "function"
      ? result.then(done)
      : done(result);
  }
  bootstrap() {
    return this.execute("bootstrap");
  }
}
