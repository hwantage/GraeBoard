import {
  CONTROL_ROUTES,
  matchBusinessRoute,
} from "../shared/business-routes.js";
import { ControlBusinessService } from "../server/storage/control-service.mjs";
import { deploymentSite } from "../shared/site-mode.js";
import { PostgresControlRepository } from "./storage/postgres-control.mjs";
import { assertDatabaseCapacity, capacityLimits } from "./capacity.mjs";
import {
  DEFAULT_SETTINGS,
  canContribute,
  canManageTeam,
} from "../shared/domain.js";
import { assert, verifySetupToken, HttpError } from "./access.mjs";
import { controlTransaction, databaseFor, withData } from "./data.mjs";
import { profiles, profileFor, siteTeamId } from "../shared/sync-profiles.js";
import { authenticateSite } from "./site-auth.mjs";
import { R2ImageStore } from "./images.mjs";
import { profileFields } from "../shared/profiles.js";
import { z } from "zod";

import { PostgresControlStore, userRecord } from "./storage/control-store.mjs";
export { userRecord } from "./storage/control-store.mjs";
export async function authenticate(env, identity, request) {
  if (siteTeamId(env)) return authenticateSite(env, identity, request);
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
      site: deploymentSite(env, "external"),
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
  constructor(env, user, identity, request, execution, { controlStore } = {}) {
    this.controlStore = controlStore || new PostgresControlStore(env);
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
    return this.controlStore.teams(this.user);
  }
  async team(
    teamId,
    { write = false, manage = false, allowUnready = false } = {},
  ) {
    const siteTeam = siteTeamId(this.env);
    if (siteTeam)
      assert(
        teamId === siteTeam && this.user.teamIds.includes(teamId),
        403,
        "이 사이트의 팀만 사용할 수 있습니다.",
      );
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
      const row = await this.controlStore.teamRow(teamId);
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
  async profile(teamId) {
    const team = await this.team(teamId);
    return profileFor(this.env, team.profile_id, teamId, {
      databaseOnly: this.controlStore.authenticationMode === "password",
    });
  }
  async imageStore(teamId) {
    const profile = await this.profile(teamId);
    return new R2ImageStore(this.env[profile.bucketBinding], teamId);
  }
  async data(teamId, work, options = {}) {
    const team = await this.team(teamId, {
        write: options.write && !options.allowViewer,
      }),
      profile = await this.profile(teamId);
    const people =
      options.write && !options.privateWrite
        ? await this.controlStore.members(teamId, { activeOnly: true })
        : [];
    const database = databaseFor(this.env, profile);
    if (options.write)
      await assertDatabaseCapacity(database, teamId, capacityLimits(this.env));
    let businessChanged = false;
    const result = await withData(
      database,
      teamId,
      async (s) => {
        if (options.write && !options.privateWrite) {
          const everyone = [
            ...people,
            { id: this.user.id, name: this.user.name },
          ];
          // One query reads every member's record; the loop then reads the
          // session cache, so the check costs the same for any team size.
          await s.getMany(
            "person",
            everyone.map((person) => [person.id]),
          );
          for (const person of everyone)
            if (!(await s.get("person", [person.id])))
              await s.put("person", [person.id], { name: person.name });
        }
        const value = await work(s);
        businessChanged = s.changes.size > 0;
        return value;
      },
      {
        ...options,
        limits: capacityLimits(this.env),
        actorId: this.user.id,
        validateImages: async (value) =>
          (await this.imageStore(teamId)).validate(value),
      },
    );
    if (businessChanged) {
      this.changedTeams.add(teamId);
      this.lastCommittedChange = {
        sequence: (this.lastCommittedChange?.sequence || 0) + 1,
        teamId,
      };
    }
    return result;
  }
  async locate(entity, id, { write = false } = {}) {
    for (const team of await this.teams()) {
      if (team.status !== "active") continue;
      if (write && !canContribute(this.user, team.id)) continue;
      const row = await this.data(team.id, (s) => s.get(entity, [id]));
      if (row && !row.deleted) return { teamId: team.id, row };
    }
    throw new HttpError(404, "자료를 찾을 수 없습니다.");
  }
  bootstrap() {
    return new ControlBusinessService(
      new PostgresControlRepository({ context: this }),
      this.user,
    ).bootstrap();
  }
}
export function controlRoutes(ctx, path, method, body) {
  if (path === "/auth/login") return { user: ctx.user, authMode: "access" };
  if (path === "/auth/logout")
    return { ok: true, logoutUrl: "/cdn-cgi/access/logout" };
  if (path === "/auth/password")
    throw new HttpError(400, "외부 사이트는 Google 로그인을 사용합니다.");
  const service = new ControlBusinessService(
    new PostgresControlRepository({ context: ctx }),
    ctx.user,
  );
  const match = matchBusinessRoute(CONTROL_ROUTES, path, method);
  if (match) return service.execute(match.route.name, body, match.params.id);
}
