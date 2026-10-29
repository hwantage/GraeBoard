import { z } from "zod";
import { THEME_IDS } from "../../shared/themes.js";
import {
  DEFAULT_SETTINGS,
  isSystemAdmin,
  propertiesFor,
  todayKey,
} from "../../shared/domain.js";
import {
  id,
  now,
  json,
  parse,
  passwordHash,
  userWithTeams,
  usersWithTeams,
  teamSettings,
  replaceUserMemberships,
  replaceTeamMembers,
  transaction,
  audit,
} from "../db.mjs";
import { requireThat } from "../../shared/validation.js";
import { profileFields } from "../../shared/profiles.js";
import { deleteTeam } from "../team-deletion.mjs";
import { removeTeamDocumentImages } from "../document-images.mjs";
import {
  loginId,
  credentials,
  systemRoles,
  teamMemberRowsSchema,
  userMembershipRowsSchema,
  teamSchema,
} from "./control-service.mjs";
const string = (max = 100) => z.string().trim().min(1).max(max);

export class SqliteControlRepository {
  constructor(options) {
    this.options = options;
    this.authenticationMode = "password";
  }
  authorizeMembers(user, teamId) {
    this.options.teamAccess(user, teamId);
  }
  execute(user, command, input = {}, targetId) {
    return execute(this.options, user, command, input, targetId);
  }
  watch(user, teamId) {
    this.options.teamAccess(user, teamId);
  }
}
function execute(
  {
    db,
    teamAccess,
    managedTeam,
    requireSystemAdmin,
    referencedUsers,
    documentImagesDir,
    cachedTasks,
  },
  user,
  command,
  input,
  targetId,
) {
  function setUserMemberships(userId, memberships) {
    for (const m of memberships)
      requireThat(
        db.prepare("SELECT id FROM teams WHERE id=?").get(m.teamId),
        400,
        "팀을 확인하세요.",
      );
    replaceUserMemberships(db, userId, memberships);
  }
  function teamMembers(teamId) {
    return db
      .prepare(
        "SELECT user_id AS userId,role FROM memberships WHERE team_id=? ORDER BY rowid",
      )
      .all(teamId);
  }
  function setTeamMembers(teamId, members) {
    const current = new Set(teamMembers(teamId).map((m) => m.userId));
    for (const m of members) {
      const u = db.prepare("SELECT active FROM users WHERE id=?").get(m.userId);
      requireThat(u, 400, "등록된 사용자를 선택하세요.");
      // 이미 소속된 비활성 사용자는 남겨 둘 수 있지만 새로 추가할 수는 없다.
      requireThat(
        u.active || current.has(m.userId),
        400,
        "비활성 사용자는 팀에 추가할 수 없습니다.",
      );
    }
    replaceTeamMembers(db, teamId, members);
  }
  if (command === "bootstrap") {
    // 시스템 관리자는 소속이 없어도 모든 팀에 들어갈 수 있다.
    const teamIds = isSystemAdmin(user)
      ? db
          .prepare("SELECT id FROM teams ORDER BY name")
          .all()
          .map((t) => t.id)
      : user.teamIds;
    const teams = teamIds.map((t) => teamAccess(user, t));
    const users = new Map();
    teams.forEach((t) =>
      referencedUsers(t.id).forEach((u) => users.set(u.id, u)),
    );
    const years = new Set([Number(todayKey().slice(0, 4))]);
    for (const team of teams)
      for (const t of db
        .prepare("SELECT DISTINCT years FROM tasks WHERE team_id=?")
        .all(team.id))
        parse(t.years, []).forEach((y) => years.add(y));
    return {
      user: user,
      teams,
      users: [...users.values()],
      years: [...years].sort((a, b) => b - a),
    };
  }
  if (command === "profile") {
    const d = z
      .object({ name: string(50).optional(), ...profileFields })
      .strict()
      .refine(
        (value) => Object.keys(value).length > 0,
        "변경할 프로필을 입력하세요.",
      )
      .parse(input);
    const u = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
    const next = {
      name: d.name ?? u.name,
      color: d.color ?? u.color,
      avatarInitials: d.avatarInitials ?? u.avatar_initials,
      avatarImage: d.avatarImage ?? u.avatar_image,
    };
    transaction(db, () => {
      db.prepare(
        "UPDATE users SET name=?,color=?,avatar_initials=?,avatar_image=? WHERE id=?",
      ).run(next.name, next.color, next.avatarInitials, next.avatarImage, u.id);
      audit(
        db,
        u.id,
        null,
        "profile",
        u.id,
        {
          name: u.name,
          color: u.color,
          avatarInitials: u.avatar_initials,
          hasAvatarImage: !!u.avatar_image,
        },
        {
          name: next.name,
          color: next.color,
          avatarInitials: next.avatarInitials,
          hasAvatarImage: !!next.avatarImage,
        },
      );
    });
    return {
      user: userWithTeams(
        db,
        db.prepare("SELECT * FROM users WHERE id=?").get(u.id),
      ),
    };
  }
  if (command === "listUsers") {
    requireSystemAdmin(user);
    return {
      users: usersWithTeams(
        db,
        db.prepare("SELECT * FROM users ORDER BY created_at").all(),
      ),
      teams: db
        .prepare("SELECT * FROM teams ORDER BY name")
        .all()
        .map((t) => ({ ...t, settings: teamSettings(t) })),
    };
  }
  if (command === "createUser") {
    requireSystemAdmin(user);
    const d = credentials
      .extend({
        name: string(50),
        ...profileFields,
        active: z.boolean().default(true),
        systemRole: systemRoles.default("user"),
        memberships: userMembershipRowsSchema.default([]),
      })
      .parse(input);
    const userId = id();
    transaction(db, () => {
      requireThat(
        !db
          .prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE")
          .get(d.username),
        409,
        "이미 사용 중인 아이디(이메일)입니다.",
      );
      db.prepare(
        "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        userId,
        d.username,
        d.name,
        passwordHash(d.password),
        d.systemRole,
        now(),
      );
      db.prepare(
        "UPDATE users SET active=?,color=?,avatar_initials=?,avatar_image=? WHERE id=?",
      ).run(
        d.active ? 1 : 0,
        d.color || "#177b70",
        d.avatarInitials || "",
        d.avatarImage || "",
        userId,
      );
      setUserMemberships(userId, d.memberships);
      audit(db, user.id, null, "user-create", userId, undefined, {
        name: d.name,
        systemRole: d.systemRole,
        memberships: d.memberships,
      });
    });
    return {
      user: userWithTeams(
        db,
        db.prepare("SELECT * FROM users WHERE id=?").get(userId),
      ),
    };
  }
  if (command === "updateUser") {
    requireSystemAdmin(user);
    const d = z
      .object({
        name: string(50),
        ...profileFields,
        // 생략한 시스템 권한·팀 소속은 그대로 둔다.
        systemRole: systemRoles.optional(),
        active: z.boolean(),
        memberships: userMembershipRowsSchema.optional(),
        // 생략하면 아이디를 유지한다. 기존 비이메일 아이디도 이메일로 바꿀 수 있다.
        username: loginId.optional(),
        password: credentials.shape.password.optional(),
      })
      .parse(input);
    const u = db.prepare("SELECT * FROM users WHERE id=?").get(targetId);
    requireThat(u, 404, "사용자를 찾을 수 없습니다.");
    const before = userWithTeams(db, u);
    const systemRole = d.systemRole ?? before.systemRole;
    transaction(db, () => {
      if (
        u.active &&
        u.system_role === "admin" &&
        (!d.active || systemRole !== "admin")
      )
        requireThat(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM users WHERE system_role='admin' AND active=1",
            )
            .get().n > 1,
          400,
          "마지막 시스템 관리자는 해제할 수 없습니다.",
        );
      if (d.username && d.username !== u.username.toLowerCase()) {
        requireThat(
          !db
            .prepare(
              "SELECT id FROM users WHERE username=? COLLATE NOCASE AND id<>?",
            )
            .get(d.username, u.id),
          409,
          "이미 사용 중인 아이디(이메일)입니다.",
        );
        db.prepare("UPDATE users SET username=? WHERE id=?").run(
          d.username,
          u.id,
        );
      }
      db.prepare(
        "UPDATE users SET name=?,system_role=?,active=?,password=?,color=?,avatar_initials=?,avatar_image=? WHERE id=?",
      ).run(
        d.name,
        systemRole,
        d.active ? 1 : 0,
        d.password ? passwordHash(d.password) : u.password,
        d.color ?? u.color,
        d.avatarInitials ?? u.avatar_initials,
        d.avatarImage ?? u.avatar_image,
        u.id,
      );
      if (d.memberships) setUserMemberships(u.id, d.memberships);
      if (!d.active || d.password)
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
      audit(
        db,
        user.id,
        null,
        "user-update",
        u.id,
        {
          username: before.username,
          name: before.name,
          systemRole: before.systemRole,
          active: before.active,
          teamRoles: before.teamRoles,
        },
        {
          username: d.username ?? before.username,
          name: d.name,
          systemRole,
          active: d.active,
          teamRoles: d.memberships
            ? Object.fromEntries(d.memberships.map((m) => [m.teamId, m.role]))
            : before.teamRoles,
        },
      );
    });
    return { ok: true };
  }
  if (command === "members") {
    const team = managedTeam(user, targetId);
    // 팀장은 기존 사용자를 팀에 추가할 수 있으므로 전체 사용자 목록이 필요하다.
    // 다른 팀 소속이나 시스템 권한은 시스템 관리자 화면에서만 보여 준다.
    return {
      members: teamMembers(team.id),
      users: db
        .prepare("SELECT * FROM users ORDER BY name")
        .all()
        .map((u) => ({
          id: u.id,
          username: u.username,
          name: u.name,
          active: !!u.active,
          color: u.color,
          avatarInitials: u.avatar_initials || "",
          avatarImage: u.avatar_image || "",
        })),
    };
  }
  if (command === "replaceMembers") {
    const team = managedTeam(user, targetId);
    const d = z
      .object({
        members: teamMemberRowsSchema,
        // 화면이 보고 있던 목록. 그 사이 다른 사람이 바꿨으면 덮어쓰지 않는다.
        previous: teamMemberRowsSchema.optional(),
      })
      .strict()
      .parse(input);
    const key = (list) =>
      list
        .map((m) => `${m.userId}:${m.role}`)
        .sort()
        .join(",");
    transaction(db, () => {
      const before = teamMembers(team.id);
      requireThat(
        !d.previous || key(d.previous) === key(before),
        409,
        "다른 사용자가 구성원을 변경했습니다. 최신 목록을 확인한 뒤 다시 시도하세요.",
      );
      setTeamMembers(team.id, d.members);
      audit(db, user.id, team.id, "team-members", team.id, before, d.members);
    });
    return { members: teamMembers(team.id) };
  }
  if (command === "createTeam") {
    requireSystemAdmin(user);
    const d = teamSchema
      .extend({
        templateTeamId: z.string().uuid().optional(),
        members: teamMemberRowsSchema.default([]),
      })
      .parse(input);
    const teamId = id();
    const template = d.templateTeamId
      ? db
          .prepare("SELECT settings FROM teams WHERE id=?")
          .get(d.templateTeamId)
      : null;
    requireThat(
      !d.templateTeamId || template,
      404,
      "복사할 팀 양식을 찾을 수 없습니다.",
    );
    const initialSettings = template
      ? teamSettings(template)
      : DEFAULT_SETTINGS;
    transaction(db, () => {
      db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
        teamId,
        d.name,
        json({
          ...initialSettings,
          theme: d.theme ?? initialSettings.theme,
          revision: 0,
        }),
      );
      setTeamMembers(teamId, d.members);
      audit(db, user.id, teamId, "team-create", teamId, undefined, d);
    });
    return { id: teamId };
  }
  if (command === "deleteTeam") {
    requireSystemAdmin(user);
    const teamId = z.string().uuid().parse(targetId);
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(input);
    const result = deleteTeam(db, teamId, user.id);
    removeTeamDocumentImages(documentImagesDir, teamId);
    cachedTasks.clearTeam(teamId);
    return result;
  }
  throw new Error("Unsupported control command: " + command);
}
