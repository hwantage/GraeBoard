import { DEFAULT_SETTINGS } from "../../shared/domain.js";
import { assert } from "../../worker/access.mjs";
import { controlTransaction } from "../../worker/data.mjs";
import { userRecord } from "../../worker/control.mjs";
import { profileSchema, memberPickerUser } from "./control-service.mjs";
import { subscribePostgresEvents } from "./postgres-events.mjs";
import { siteTeamId } from "../../worker/config.mjs";
import { authenticateSite } from "../../worker/site-auth.mjs";
export class PostgresControlRepository {
  constructor({ context }) {
    this.context = context;
    this.authenticationMode = "access";
  }
  resolveUser(userId) {
    if (siteTeamId(this.context.env))
      return authenticateSite(
        this.context.env,
        this.context.identity,
        this.context.request,
      ).then((user) => {
        assert(user.id === userId, 401, "선택한 계정이 변경되었습니다.");
        return user;
      });
    return controlTransaction(this.context.env, async (tx) => {
      const row = (await tx.query("SELECT * FROM users WHERE id=$1", [userId]))
        .rows[0];
      assert(row?.active, 401, "로그인이 필요합니다.");
      return userRecord(tx, row);
    });
  }
  execute(user, command, input = {}, targetId) {
    assert(
      user.id === this.context.user.id,
      403,
      "요청 사용자가 변경되었습니다.",
    );
    return command === "bootstrap"
      ? bootstrapFromTeamStores(this.context)
      : execute(this.context, command, input, targetId);
  }
  async watch(user, teamId) {
    const ctx = this.context;
    assert(user.id === ctx.user.id, 403, "요청 사용자가 변경되었습니다.");
    await ctx.team(teamId, { allowUnready: true });
    const control = await ctx.controlStore.revision();
    const team = await ctx.team(teamId, { allowUnready: true });
    const sequence =
      team.status === "active"
        ? await ctx.data(
            teamId,
            async (s) =>
              (
                await s.tx.query(
                  "SELECT COALESCE(MAX(cursor),0) AS value FROM site_events WHERE team_id=$1",
                  [teamId],
                )
              ).rows[0].value,
          )
        : 0;
    return { revision: `${control}:${sequence}` };
  }
  subscribe(user, teamId, ports) {
    return subscribePostgresEvents({
      ...ports,
      user,
      read: async (currentUser, cursor) => {
        this.context.user = currentUser;
        this.context.teamCache.clear();
        const value = await this.watch(currentUser, teamId),
          next = `pg:team:${teamId}:${value.revision}`;
        return {
          cursor: next,
          events:
            next === cursor
              ? []
              : [{ event: "document", cursor: next, payload: value }],
        };
      },
    });
  }
}
export async function bootstrapFromTeamStores(ctx) {
  const teams = [],
    people = new Map(),
    years = new Set([new Date().getFullYear()]);
  const controlUsers = await ctx.controlStore.users();
  for (const row of await ctx.teams()) {
    let settings = DEFAULT_SETTINGS,
      name = row.name,
      connectionError = null;
    if (row.status === "active")
      try {
        await ctx.data(row.id, async (s) => {
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
          const result = await s.tx.query(
            "SELECT DISTINCT y.value::integer AS year FROM site_entities s CROSS JOIN LATERAL jsonb_array_elements_text(s.payload::jsonb->'years') y(value) WHERE s.team_id=$1 AND s.entity='task' AND s.deleted=0",
            [row.id],
          );
          for (const item of result.rows) years.add(item.year);
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
    user: ctx.user,
    teams,
    users: [...people.values()],
    years: [...years].sort((a, b) => b - a),
    ...(ctx.hostAuthMode === "password"
      ? {}
      : {
          authMode: "access",
          site: "external",
          accountLinking: !!siteTeamId(ctx.env),
        }),
  };
}
async function execute(ctx, command, body, targetId) {
  if (siteTeamId(ctx.env)) {
    assert(
      ![
        "createUser",
        "updateUser",
        "replaceMembers",
        "createTeam",
        "deleteTeam",
      ].includes(command),
      403,
      "팀 구성원과 권한은 사내에서 관리합니다.",
    );
    if (command === "profile" && body.name !== undefined)
      assert(
        body.name === ctx.user.name,
        403,
        "이름은 사내 계정에서 변경하세요.",
      );
  }
  if (command === "profile") {
    body = profileSchema.parse(body);
    return controlTransaction(
      ctx.env,
      async (tx) => {
        await tx.query(
          "UPDATE users SET name=$2,color=$3,avatar_initials=$4,avatar_image=$5 WHERE id=$1",
          [
            ctx.user.id,
            body.name?.trim() ?? ctx.user.name,
            body.color ?? ctx.user.color,
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
  if (command === "listUsers") {
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
  if (["createUser", "updateUser"].includes(command)) {
    ctx.admin();
    const id = targetId || crypto.randomUUID();
    return controlTransaction(
      ctx.env,
      async (tx) => {
        const old = (
          await tx.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id])
        ).rows[0];
        assert(
          command !== "updateUser" || old,
          404,
          "사용자를 찾을 수 없습니다.",
        );
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
        if (
          old?.active &&
          old.system_role === "admin" &&
          (body.active === false || role !== "admin")
        )
          assert(
            Number(
              (
                await tx.query(
                  "SELECT COUNT(*) AS n FROM users WHERE active=TRUE AND system_role='admin'",
                )
              ).rows[0].n,
            ) > 1,
            400,
            "마지막 시스템 관리자는 해제할 수 없습니다.",
          );
        assert(
          !(
            await tx.query(
              "SELECT id FROM users WHERE lower(username)=$1 AND id<>$2",
              [email, id],
            )
          ).rows.length,
          409,
          "이미 사용 중인 아이디(이메일)입니다.",
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
              (await tx.query("SELECT 1 FROM teams WHERE id=$1", [m.teamId]))
                .rows.length,
              400,
              "팀을 확인하세요.",
            );
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
  if (["members", "replaceMembers"].includes(command)) {
    const teamId = targetId;
    await ctx.team(teamId, {
      manage: command === "replaceMembers",
      allowUnready: true,
    });
    return controlTransaction(
      ctx.env,
      async (tx) => {
        if (command === "replaceMembers") {
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
            const member = (
              await tx.query("SELECT active FROM users WHERE id=$1", [m.userId])
            ).rows[0];
            assert(member, 400, "등록된 사용자를 선택하세요.");
            assert(
              member.active || current.some((row) => row.userId === m.userId),
              400,
              "비활성 사용자는 팀에 추가할 수 없습니다.",
            );
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
        if (command === "replaceMembers")
          await tx.query(
            "INSERT INTO control_audit(id,actor_id,action,target,payload,created_at) VALUES($1,$2,'team-members',$3,$4,$5)",
            [
              crypto.randomUUID(),
              ctx.user.id,
              teamId,
              JSON.stringify(body.members),
              new Date().toISOString(),
            ],
          );
        const members = (
          await tx.query(
            "SELECT u.*,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.team_id=$1 ORDER BY u.name",
            [teamId],
          )
        ).rows;
        return {
          members: members.map((m) => ({ userId: m.id, role: m.role })),
          // Team leads need the picker directory, not other teams' authority.
          // Retain inactive users so existing memberships remain identifiable.
          users: (
            await tx.query(
              "SELECT id,username,name,active,color,avatar_initials,avatar_image FROM users ORDER BY name",
            )
          ).rows.map(memberPickerUser),
        };
      },
      { write: command === "replaceMembers" },
    );
  }
  if (command === "createTeam") {
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
        for (const member of body.members || []) {
          const row = (
            await tx.query("SELECT active FROM users WHERE id=$1", [
              member.userId,
            ])
          ).rows[0];
          assert(row?.active, 400, "활성 사용자를 선택하세요.");
          await tx.query(
            "INSERT INTO memberships(user_id,team_id,role) VALUES($1,$2,$3)",
            [member.userId, id, member.role],
          );
        }
        await tx.query(
          "INSERT INTO control_audit(id,actor_id,action,target,payload,created_at) VALUES($1,$2,'team-create',$3,$4,$5)",
          [
            crypto.randomUUID(),
            ctx.user.id,
            id,
            JSON.stringify({ name: body.name }),
            new Date().toISOString(),
          ],
        );
        return {
          id,
          team: { id, name: body.name.trim(), settings: DEFAULT_SETTINGS },
        };
      },
      { write: true },
    );
  }
  if (command === "deleteTeam") {
    ctx.admin();
    const team = await ctx.team(targetId, { allowUnready: true });
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
