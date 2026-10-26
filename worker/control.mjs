import { assertDatabaseCapacity, capacityLimits } from "./capacity.mjs";
import {
  DEFAULT_SETTINGS,
  canContribute,
  canManageTeam,
} from "../shared/domain.js";
import { assert, verifySetupToken } from "./access.mjs";
import { controlTransaction, databaseFor, withData } from "./data.mjs";
import { profiles, profileFor } from "./config.mjs";
import { R2ImageStore } from "./images.mjs";
import { profileFields } from "../server/profiles.mjs";
import { z } from "zod";

export async function userRecord(tx, row) {
  const memberships = (
    await tx.query("SELECT team_id,role FROM memberships WHERE user_id=$1", [
      row.id,
    ])
  ).rows;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    systemRole: row.system_role,
    active: row.active,
    color: row.color,
    avatarInitials: row.avatar_initials,
    avatarImage: row.avatar_image,
    teamIds: memberships.map((m) => m.team_id),
    teamRoles: Object.fromEntries(memberships.map((m) => [m.team_id, m.role])),
  };
}
export async function authenticate(env, identity) {
  return controlTransaction(env, async (tx) => {
    const found = (
      await tx.query(
        "SELECT u.* FROM users u JOIN access_identities a ON a.user_id=u.id WHERE a.issuer=$1 AND a.subject=$2",
        [identity.issuer, identity.subject],
      )
    ).rows[0];
    if (found) {
      assert(
        found.active,
        403,
        "비활성화된 사용자입니다. 관리자에게 문의하세요.",
      );
      return userRecord(tx, found);
    }
    const invited = (
      await tx.query(
        "SELECT u.* FROM users u WHERE lower(u.email)=$1 AND NOT EXISTS(SELECT 1 FROM access_identities a WHERE a.user_id=u.id)",
        [identity.email],
      )
    ).rows[0];
    if (
      !invited &&
      !(
        await tx.query(
          "SELECT setup_complete FROM control_meta WHERE singleton=1",
        )
      ).rows[0]?.setup_complete
    )
      assert(false, 401, "초기 관리자 설정이 필요합니다.");
    assert(
      invited?.active,
      403,
      "GraeBoard에 등록된 사용자만 접속할 수 있습니다. 관리자에게 문의하세요.",
    );
    await tx.query(
      "INSERT INTO access_identities(issuer,subject,user_id) VALUES($1,$2,$3)",
      [identity.issuer, identity.subject, invited.id],
    );
    await tx.query(
      "UPDATE control_meta SET revision=revision+1 WHERE singleton=1",
    );
    return userRecord(tx, invited);
  });
}
export async function setupStatus(env, identity) {
  return controlTransaction(env, async (tx) => {
    const row = (
      await tx.query(
        "SELECT setup_complete FROM control_meta WHERE singleton=1",
      )
    ).rows[0];
    return {
      required: !row.setup_complete,
      tokenRequired: true,
      needsSetup: !row.setup_complete,
      setup: !row.setup_complete,
      authMode: "access",
      email: identity.email,
    };
  });
}
export async function setup(env, identity, body) {
  assert(
    verifySetupToken(body.setupToken, env.SETUP_TOKEN),
    403,
    "일회용 설치 토큰을 확인하세요.",
  );
  assert(
    !env.BOOTSTRAP_ADMIN_EMAIL ||
      env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase() === identity.email,
    403,
    "지정된 초기 관리자 계정으로 로그인하세요.",
  );
  assert(
    !env.BOOTSTRAP_ADMIN_SUBJECT ||
      env.BOOTSTRAP_ADMIN_SUBJECT === identity.subject,
    403,
    "지정된 초기 관리자 계정으로 로그인하세요.",
  );
  return controlTransaction(
    env,
    async (tx) => {
      const meta = (
        await tx.query(
          "SELECT setup_complete FROM control_meta WHERE singleton=1 FOR UPDATE",
        )
      ).rows[0];
      assert(
        !meta.setup_complete &&
          !(await tx.query("SELECT 1 FROM users LIMIT 1")).rows.length,
        409,
        "초기 설정이 이미 완료되었습니다.",
      );
      const id = crypto.randomUUID(),
        name = String(body.name || identity.email).trim();
      assert(name.length > 0 && name.length <= 100, 400, "이름을 확인하세요.");
      await tx.query(
        "INSERT INTO users(id,username,email,name,system_role,created_at) VALUES($1,$2,$2,$3,'admin',$4)",
        [id, identity.email, name, new Date().toISOString()],
      );
      await tx.query(
        "INSERT INTO access_identities(issuer,subject,user_id) VALUES($1,$2,$3)",
        [identity.issuer, identity.subject, id],
      );
      await tx.query(
        "UPDATE control_meta SET setup_complete=TRUE WHERE singleton=1",
      );
      return {
        ok: true,
        user: await userRecord(
          tx,
          (await tx.query("SELECT * FROM users WHERE id=$1", [id])).rows[0],
        ),
      };
    },
    { write: true },
  );
}
export class RequestContext {
  constructor(env, user, identity, request, execution) {
    this.env = env;
    this.user = user;
    this.identity = identity;
    this.request = request;
    this.execution = execution;
    this.teamCache = new Map();
    this.changedTeams = new Set();
  }
  admin() {
    assert(
      this.user.systemRole === "admin",
      403,
      "시스템 관리자만 사용할 수 있습니다.",
    );
  }
  async teams() {
    return controlTransaction(
      this.env,
      async (tx) =>
        (
          await tx.query(
            this.user.systemRole === "admin"
              ? "SELECT * FROM teams ORDER BY name"
              : "SELECT t.* FROM teams t JOIN memberships m ON t.id=m.team_id WHERE m.user_id=$1 ORDER BY t.name",
            this.user.systemRole === "admin" ? [] : [this.user.id],
          )
        ).rows,
    );
  }
  async team(
    teamId,
    { write = false, manage = false, allowUnready = false } = {},
  ) {
    assert(
      this.user.systemRole === "admin" || this.user.teamIds.includes(teamId),
      403,
      "이 팀에 접근할 권한이 없습니다.",
    );
    if (write)
      assert(canContribute(this.user, teamId), 403, "편집 권한이 없습니다.");
    if (manage)
      assert(
        canManageTeam(this.user, teamId),
        403,
        "팀장만 관리할 수 있습니다.",
      );
    if (!this.teamCache.has(teamId)) {
      const row = await controlTransaction(
        this.env,
        async (tx) =>
          (await tx.query("SELECT * FROM teams WHERE id=$1", [teamId])).rows[0],
      );
      assert(row, 404, "팀을 찾을 수 없습니다.");
      this.teamCache.set(teamId, row);
    }
    const row = this.teamCache.get(teamId);
    if (!allowUnready)
      assert(
        row.status === "active",
        409,
        "팀 자료를 가져오거나 연결을 확인하세요.",
      );
    return row;
  }
  async data(teamId, work, options = {}) {
    const team = await this.team(teamId, {
        write: options.write && !options.allowViewer,
      }),
      profile = profileFor(this.env, team.profile_id, teamId);
    const people = options.write
      ? await controlTransaction(
          this.env,
          async (tx) =>
            (
              await tx.query(
                "SELECT u.id,u.name FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.team_id=$1 AND u.active=TRUE",
                [teamId],
              )
            ).rows,
        )
      : [];
    const database = databaseFor(this.env, profile);
    await assertDatabaseCapacity(database, teamId, capacityLimits(this.env));
    const result = await withData(
      database,
      teamId,
      async (s) => {
        if (options.write)
          for (const person of [
            ...people,
            { id: this.user.id, name: this.user.name },
          ])
            if (!(await s.get("person", [person.id])))
              await s.put("person", [person.id], { name: person.name });
        return work(s);
      },
      {
        ...options,
        limits: capacityLimits(this.env),
        actorId: this.user.id,
        validateImages: (value) =>
          new R2ImageStore(this.env[profile.bucketBinding], teamId).validate(
            value,
          ),
      },
    );
    if (options.write) this.changedTeams.add(teamId);
    return result;
  }
  async locate(entity, id, { write = false } = {}) {
    for (const team of await this.teams()) {
      if (team.status !== "active") continue;
      if (write && !canContribute(this.user, team.id)) continue;
      const row = await this.data(team.id, (s) => s.get(entity, [id]));
      if (row && !row.deleted) return { teamId: team.id, row };
    }
    throw Object.assign(new Error("자료를 찾을 수 없습니다."), { status: 404 });
  }
  async bootstrap() {
    const teams = [],
      people = new Map(),
      years = new Set([new Date().getFullYear()]);
    const controlUsers = await controlTransaction(this.env, async (tx) => {
      const all = (await tx.query("SELECT * FROM users ORDER BY name")).rows;
      return Promise.all(all.map((row) => userRecord(tx, row)));
    });
    for (const row of await this.teams()) {
      let settings = DEFAULT_SETTINGS,
        name = row.name,
        connectionError = null;
      if (row.status === "active")
        try {
          await this.data(row.id, async (s) => {
            const t = await s.get("team", []);
            settings = {
              ...DEFAULT_SETTINGS,
              ...t?.payload?.settings,
              revision: t?.revision || 0,
            };
            name = t?.payload?.name || name;
            for (const p of await s.list("person"))
              people.set(p.key[0], {
                id: p.key[0],
                name: p.payload.name,
                systemRole: "user",
                teamIds: [],
                teamRoles: {},
                active: false,
                color: "#177b70",
                avatarInitials: "",
                avatarImage: "",
              });
            for (const task of await s.list("task"))
              for (const year of task.payload.years || []) years.add(year);
          });
        } catch {
          connectionError = "팀 업무 DB 연결을 확인하세요.";
        }
      teams.push({
        id: row.id,
        name,
        settings,
        status: row.status,
        ...(connectionError ? { connectionError } : {}),
      });
      for (const user of controlUsers)
        if (user.teamIds.includes(row.id)) people.set(user.id, user);
    }
    return {
      user: this.user,
      teams,
      users: [...people.values()],
      years: [...years].sort((a, b) => b - a),
      authMode: "access",
      site: "external",
    };
  }
}
export async function controlRoutes(ctx, path, method, body) {
  if (path === "/bootstrap" && method === "GET") return ctx.bootstrap();
  if (path === "/auth/login") return { user: ctx.user, authMode: "access" };
  if (path === "/auth/logout")
    return { ok: true, logoutUrl: "/cdn-cgi/access/logout" };
  if (path === "/auth/password")
    throw Object.assign(
      new Error("외부 사이트는 Google 로그인을 사용합니다."),
      { status: 400 },
    );
  if (path === "/auth/profile" && method === "PATCH") {
    z.object(profileFields).parse(body);
    assert(
      typeof body.name === "string" &&
        body.name.trim() &&
        body.name.length <= 100,
      400,
      "이름을 확인하세요.",
    );
    assert(
      !body.avatarImage ||
        (/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(
          body.avatarImage,
        ) &&
          body.avatarImage.length <= 150000),
      400,
      "프로필 이미지를 확인하세요.",
    );
    return controlTransaction(
      ctx.env,
      async (tx) => {
        await tx.query(
          "UPDATE users SET name=$2,color=$3,avatar_initials=$4,avatar_image=$5 WHERE id=$1",
          [
            ctx.user.id,
            body.name.trim(),
            body.color || ctx.user.color,
            body.avatarInitials ?? ctx.user.avatarInitials,
            body.avatarImage ?? ctx.user.avatarImage,
          ],
        );
        return {
          user: await userRecord(
            tx,
            (await tx.query("SELECT * FROM users WHERE id=$1", [ctx.user.id]))
              .rows[0],
          ),
        };
      },
      { write: true },
    );
  }
  if (path === "/admin/users" && method === "GET") {
    ctx.admin();
    const { teams } = await ctx.bootstrap();
    return controlTransaction(ctx.env, async (tx) => ({
      users: await Promise.all(
        (await tx.query("SELECT * FROM users ORDER BY name")).rows.map((row) =>
          userRecord(tx, row),
        ),
      ),
      teams,
    }));
  }
  const userMatch = /^\/admin\/users(?:\/([^/]+))?$/.exec(path);
  if (userMatch && ["POST", "PATCH"].includes(method)) {
    z.object(profileFields).parse(body);
    ctx.admin();
    const id = userMatch[1] || crypto.randomUUID();
    return controlTransaction(
      ctx.env,
      async (tx) => {
        const old = (
          await tx.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id])
        ).rows[0];
        assert(method !== "PATCH" || old, 404, "사용자를 찾을 수 없습니다.");
        const email = String(body.username ?? old?.username ?? "")
            .trim()
            .toLowerCase(),
          name = String(body.name ?? old?.name ?? "").trim(),
          role = body.systemRole ?? old?.system_role ?? "user";
        assert(
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
            email.length <= 254 &&
            name.length > 0 &&
            name.length <= 100 &&
            ["admin", "user"].includes(role),
          400,
          "사용자 정보를 확인하세요.",
        );
        assert(
          !(id === ctx.user.id && (body.active === false || role !== "admin")),
          400,
          "자신의 관리자 권한은 해제할 수 없습니다.",
        );
        await tx.query(
          "INSERT INTO users(id,username,email,name,system_role,active,color,avatar_initials,avatar_image,created_at) VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET username=EXCLUDED.username,email=EXCLUDED.email,name=EXCLUDED.name,system_role=EXCLUDED.system_role,active=EXCLUDED.active,color=EXCLUDED.color,avatar_initials=EXCLUDED.avatar_initials,avatar_image=EXCLUDED.avatar_image",
          [
            id,
            email,
            name,
            role,
            body.active ?? old?.active ?? true,
            body.color ?? old?.color ?? "#177b70",
            body.avatarInitials ?? old?.avatar_initials ?? "",
            body.avatarImage ?? old?.avatar_image ?? "",
            old?.created_at || new Date().toISOString(),
          ],
        );
        if (body.memberships) {
          assert(
            Array.isArray(body.memberships) && body.memberships.length <= 50,
            400,
            "팀 목록을 확인하세요.",
          );
          await tx.query("DELETE FROM memberships WHERE user_id=$1", [id]);
          for (const m of body.memberships) {
            assert(
              ["lead", "member", "viewer"].includes(m.role),
              400,
              "팀 권한을 확인하세요.",
            );
            await tx.query(
              "INSERT INTO memberships(user_id,team_id,role) VALUES($1,$2,$3)",
              [id, m.teamId, m.role],
            );
          }
        }
        const user = await userRecord(
          tx,
          (await tx.query("SELECT * FROM users WHERE id=$1", [id])).rows[0],
        );
        await tx.query(
          "INSERT INTO control_audit(id,actor_id,action,target,payload,created_at) VALUES($1,$2,$3,$4,$5,$6)",
          [
            crypto.randomUUID(),
            ctx.user.id,
            old ? "user-update" : "user-create",
            id,
            JSON.stringify({
              name,
              username: email,
              systemRole: role,
              active: user.active,
            }),
            new Date().toISOString(),
          ],
        );
        return { user };
      },
      { write: true },
    );
  }
  const membership = /^\/teams\/([^/]+)\/members$/.exec(path);
  if (membership) {
    const teamId = membership[1];
    await ctx.team(teamId, { manage: method === "PUT", allowUnready: true });
    return controlTransaction(
      ctx.env,
      async (tx) => {
        if (method === "PUT") {
          assert(
            Array.isArray(body.members) &&
              body.members.length <= 1000 &&
              new Set(body.members.map((m) => m.userId)).size ===
                body.members.length,
            400,
            "구성원 목록을 확인하세요.",
          );
          const current = (
            await tx.query(
              "SELECT user_id,role FROM memberships WHERE team_id=$1",
              [teamId],
            )
          ).rows.map((r) => ({ userId: r.user_id, role: r.role }));
          const key = (rows) =>
            rows
              .map((r) => r.userId + ":" + r.role)
              .sort()
              .join(",");
          assert(
            !body.previous || key(body.previous) === key(current),
            409,
            "다른 사용자가 구성원을 변경했습니다.",
          );
          await tx.query("DELETE FROM memberships WHERE team_id=$1", [teamId]);
          for (const m of body.members) {
            assert(
              ["lead", "member", "viewer"].includes(m.role),
              400,
              "팀 권한을 확인하세요.",
            );
            await tx.query(
              "INSERT INTO memberships(user_id,team_id,role) VALUES($1,$2,$3)",
              [m.userId, teamId, m.role],
            );
          }
        }
        const members = (
          await tx.query(
            "SELECT u.*,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.team_id=$1 ORDER BY u.name",
            [teamId],
          )
        ).rows;
        return {
          members: members.map((m) => ({ userId: m.id, role: m.role })),
          users: await Promise.all(
            (
              await tx.query(
                "SELECT * FROM users WHERE active=TRUE ORDER BY name",
              )
            ).rows.map((row) => userRecord(tx, row)),
          ),
        };
      },
      { write: method === "PUT" },
    );
  }
  if (path === "/admin/teams" && method === "POST") {
    ctx.admin();
    const id = body.id || crypto.randomUUID();
    assert(
      typeof body.name === "string" &&
        body.name.trim() &&
        body.name.length <= 100,
      400,
      "팀 이름을 확인하세요.",
    );
    return controlTransaction(
      ctx.env,
      async (tx) => {
        await tx.query("INSERT INTO teams(id,name) VALUES($1,$2)", [
          id,
          body.name.trim(),
        ]);
        return {
          team: { id, name: body.name.trim(), settings: DEFAULT_SETTINGS },
        };
      },
      { write: true },
    );
  }
  const adminTeam = /^\/admin\/teams\/([^/]+)$/.exec(path);
  if (adminTeam && method === "DELETE") {
    ctx.admin();
    const team = await ctx.team(adminTeam[1], { allowUnready: true });
    assert(
      team.status !== "active",
      409,
      "팀 연결을 해제하고 미전송 자료를 보관한 뒤 삭제하세요.",
    );
    return controlTransaction(
      ctx.env,
      async (tx) => {
        await tx.query("DELETE FROM teams WHERE id=$1", [team.id]);
        return { ok: true };
      },
      { write: true },
    );
  }
  return undefined;
}
