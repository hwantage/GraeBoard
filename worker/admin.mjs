import { AdminHistoryBusinessService } from "../server/storage/admin-history-service.mjs";
import { PostgresAdminHistoryRepository } from "../server/storage/postgres-admin-history.mjs";
import { PostgresDatabase } from "../server/storage/postgres.mjs";
import { canonical, entityId, digest } from "../server/sync/protocol.mjs";
import { reduce, reduceMany } from "../server/sync/reducer.mjs";
import { assert } from "./access.mjs";
import { profiles, profileFor, siteTeamId } from "./config.mjs";
import {
  controlTransaction,
  databaseFor,
  controlPool,
  DataSession,
} from "./data.mjs";
import { GitHubApiTransport } from "./git.mjs";
import { R2ImageStore } from "./images.mjs";
import { beginProfileSwitch } from "./profile-switch.mjs";
import { runTeam, refreshTeam, importTeam } from "./sync.mjs";

export async function serviceStatus(ctx, { check = false } = {}) {
  ctx.admin();
  const installed = profiles(ctx.env),
    checks = [];
  let database;
  try {
    database = await new PostgresDatabase(controlPool(ctx.env), {
      scope: "control",
      site: !!siteTeamId(ctx.env),
    }).health();
    if (check)
      await controlTransaction(ctx.env, async (tx) => {
        await tx.query("SAVEPOINT connection_probe");
        await tx.query(
          "INSERT INTO connection_probes(id,created_at) VALUES($1,$2)",
          [crypto.randomUUID(), new Date().toISOString()],
        );
        await tx.query("ROLLBACK TO SAVEPOINT connection_probe");
      });
    checks.push({
      name: "관리 PostgreSQL",
      status: "ok",
      message: "관리 스키마와 연결을 확인했습니다.",
    });
  } catch {
    database = { provider: "postgres", status: "error" };
    checks.push({
      name: "관리 PostgreSQL",
      status: "error",
      message: "관리 DB 연결과 마이그레이션을 확인하세요.",
    });
  }
  checks.push({
    name: "Access",
    status: "ok",
    message: "이 요청의 GraeBoard JWT 서명과 audience를 검증했습니다.",
  });
  return {
    site: "external",
    siteName: ctx.env.SITE_NAME || "외부 사이트",
    appOrigin: ctx.env.APP_ORIGIN,
    access: {
      issuer: ctx.env.ACCESS_ISSUER || ctx.env.ACCESS_TEAM_DOMAIN,
      audience: ctx.env.ACCESS_AUDIENCE || ctx.env.ACCESS_AUD,
      configured: true,
    },
    database: { provider: "postgres", ...database },
    profiles: installed.map((p) => ({
      profileId: p.profileId,
      name: p.name,
      teamId: p.teamId,
      repository: "https://github.com/" + p.repository,
      database: {
        provider: "postgres",
        binding: p.databaseBinding,
        status: ctx.env[p.databaseBinding] ? "configured" : "missing",
      },
      images: {
        provider: "r2",
        binding: p.bucketBinding,
        status: ctx.env[p.bucketBinding] ? "configured" : "missing",
      },
      ready: !!(
        ctx.env[p.databaseBinding] &&
        ctx.env[p.bucketBinding] &&
        ctx.env[p.githubSecret]
      ),
    })),
    checks,
    guideUrl: "/api/admin/service-connections/guide",
  };
}
export async function syncStatus(ctx, teamId) {
  const team = await ctx.team(teamId, { allowUnready: true });
  if (!team.profile_id)
    return {
      site: "external",
      siteName: ctx.env.SITE_NAME || "외부 사이트",
      mode: "unlinked",
      pending: 0,
      conflicts: 0,
    };
  const p = profileFor(ctx.env, team.profile_id, teamId),
    snapshot = await databaseFor(ctx.env, p).withTeamTransaction(
      teamId,
      async (tx) => ({
        connection: await tx.sync.readLink(),
        counts: (
          await tx.query(
            "SELECT (SELECT COUNT(*) FROM sync_outbox WHERE team_id=$1 AND status<>'acknowledged') pending,(SELECT COUNT(*) FROM sync_conflicts WHERE team_id=$1 AND resolution IS NULL) conflicts,(SELECT MAX(created_at) FROM sync_outbox WHERE team_id=$1) last_saved",
            [teamId],
          )
        ).rows[0],
      }),
      { readOnly: true },
    ),
    link = snapshot.connection;
  return {
    site: "external",
    siteName: ctx.env.SITE_NAME || "외부 사이트",
    teamId,
    profileId: p.profileId,
    repository: "https://github.com/" + p.repository,
    siteId: link?.installation_id,
    mode: link?.mode || "unlinked",
    pending: Number(snapshot.counts.pending),
    conflicts: Number(snapshot.counts.conflicts),
    lastLocalSavedAt: snapshot.counts.last_saved,
    canonicalHead: link?.canonical_head,
    lastReceivedAt: link?.last_received_at,
    lastPublishedAt: link?.last_published_at,
    lastError: link?.last_error,
    remoteStatus: link?.remote_status
      ? (() => {
          const remote = JSON.parse(link.remote_status),
            age = Date.now() - Date.parse(remote.observedAt);
          return {
            ...remote,
            verified:
              !!remote.verified &&
              age >= 0 &&
              age < 180000 &&
              remote.mode === "active" &&
              (remote.verifiedAgainstHead === link.canonical_head ||
                remote.appliedCanonicalHead === link.canonical_head) &&
              remote.installationId === ctx.env.PEER_INSTALLATION_ID,
          };
        })()
      : null,
    captureEnabled: !!link && link.mode !== "disconnected",
  };
}
async function checkTeam(ctx, teamId) {
  const team = await ctx.team(teamId, { manage: true, allowUnready: true }),
    p = profileFor(ctx.env, team.profile_id, teamId),
    db = databaseFor(ctx.env, p),
    checks = [];
  try {
    await db.health();
    await db.withTeamTransaction(teamId, async (tx) => {
      await tx.query("SAVEPOINT connection_probe");
      await tx.query(
        "INSERT INTO connection_probes(id,created_at) VALUES($1,$2)",
        [crypto.randomUUID(), new Date().toISOString()],
      );
      await tx.query("ROLLBACK TO SAVEPOINT connection_probe");
    });
    checks.push({
      name: "팀 PostgreSQL",
      status: "ok",
      message: "팀 UUID와 스키마, 쓰기 rollback을 확인했습니다.",
    });
  } catch {
    checks.push({
      name: "팀 PostgreSQL",
      status: "error",
      message: "팀 DB UUID와 마이그레이션을 확인하세요.",
    });
  }
  try {
    await new R2ImageStore(ctx.env[p.bucketBinding], teamId).check();
    checks.push({
      name: "R2",
      status: "ok",
      message: "비공개 이미지 임시 파일 쓰기·읽기·삭제를 확인했습니다.",
    });
  } catch {
    checks.push({
      name: "R2",
      status: "error",
      message: "R2 연결을 확인하세요.",
    });
  }
  try {
    const git = new GitHubApiTransport({
        repository: p.repository,
        token: ctx.env[p.githubSecret],
      }),
      result = await git.check();
    if (result.head) {
      const manifest = JSON.parse(
        new TextDecoder().decode(
          await git.readFile(result.head, "manifest.json"),
        ),
      );
      assert(manifest.teamId === teamId, 400, "다른 팀 저장소입니다.");
      const link = await db.readLink(teamId);
      assert(
        !link || link.repo_id === manifest.repoId,
        400,
        "저장소 신원이 바뀌었습니다.",
      );
    }
    checks.push({
      name: "GitHub",
      status: "ok",
      message: "private 저장소와 전용 probe ref 쓰기·삭제를 확인했습니다.",
    });
  } catch (error) {
    checks.push({
      name: "GitHub",
      status: "error",
      message: error.message.startsWith("Git 쓰기")
        ? error.message
        : "GitHub 토큰 권한과 팀 저장소를 확인하세요.",
    });
  }
  return {
    ok: checks.every((c) => c.status === "ok"),
    ready: checks.every((c) => c.status === "ok"),
    checks,
  };
}
export async function adminRoutes(
  ctx,
  path,
  method,
  body,
  query = new URL(ctx.request.url).searchParams,
) {
  if (path === "/admin/service-connections" && method === "GET")
    return serviceStatus(ctx);
  if (path === "/admin/service-connections/check" && method === "POST")
    return serviceStatus(ctx, { check: true });
  if (path === "/admin/sync/import" && method === "POST")
    return importTeam(ctx, body);
  const connection = /^\/admin\/teams\/([^/]+)\/connection$/.exec(path);
  if (connection) {
    ctx.admin();
    const team = await ctx.team(connection[1], { allowUnready: true });
    if (method === "PUT") {
      const p = profileFor(ctx.env, body.profileId, team.id);
      if (
        team.profile_id &&
        team.profile_id !== p.profileId &&
        team.status !== "unconnected"
      )
        return beginProfileSwitch(
          ctx,
          team,
          p.profileId,
          body.expectedRevision,
        );
      await databaseFor(ctx.env, p).health();
      await controlTransaction(
        ctx.env,
        (tx) =>
          tx.query(
            "UPDATE teams SET profile_id=$2,config_revision=config_revision+1 WHERE id=$1",
            [team.id, p.profileId],
          ),
        { write: true },
      );
      team.profile_id = p.profileId;
    }
    const switchJob = await controlTransaction(ctx.env, async (tx) => {
      const row = (
        await tx.query(
          "SELECT * FROM control_jobs WHERE team_id=$1 AND kind='profile-switch' ORDER BY created_at DESC LIMIT 1",
          [team.id],
        )
      ).rows[0];
      return row
        ? {
            jobId: row.id,
            phase: row.phase,
            hasMore: row.phase !== "complete",
            profileId: JSON.parse(row.payload).newProfileId,
          }
        : null;
    });
    return {
      switchJob,
      teamId: team.id,
      profileId: team.profile_id,
      revision: Number(team.config_revision),
      profiles: profiles(ctx.env)
        .filter((p) => p.teamId === team.id)
        .map((p) => ({
          profileId: p.profileId,
          name: p.name,
          teamId: p.teamId,
          replaces: p.replaces,
          repository: "https://github.com/" + p.repository,
        })),
    };
  }
  const sync =
    /^\/teams\/([^/]+)\/sync(?:\/(check|enable|pause|resume|run|pull|refresh|disconnect|checkpoint|conflicts)(?:\/([^/]+)(?:\/(resolve))?)?)?$/.exec(
      path,
    );
  if (sync) {
    const teamId = sync[1];
    await ctx.team(teamId, {
      manage: method !== "GET" && !["pull", "refresh"].includes(sync[2]),
      allowUnready: true,
    });
    if (!sync[2]) return syncStatus(ctx, teamId);
    if (sync[2] === "check") return checkTeam(ctx, teamId);
    const team = await ctx.team(teamId, { allowUnready: true }),
      p = profileFor(ctx.env, team.profile_id, teamId),
      db = databaseFor(ctx.env, p);
    if (sync[2] === "conflicts") {
      if (method === "GET") {
        const state = await db.readState(teamId),
          link = await db.readLink(teamId),
          view = (c) => ({
            conflictId: c.conflictId,
            opId: c.opId,
            createdAt: c.operation.createdAt,
            target: c.operation.changes
              .map((x) => x.entity + " " + x.key.join("/"))
              .join(", "),
            result: c.reason,
            base: c.operation.changes.map((x) => x.base),
            current: c.current,
            desired: c.operation.changes.map((x) => x.desired),
            expectedHead: link.canonical_head,
            frontier: [c.opId],
            resolved: !!c.resolution,
          });
        if (sync[3]) {
          assert(state.conflicts[sync[3]], 404, "충돌을 찾을 수 없습니다.");
          return view(state.conflicts[sync[3]]);
        }
        return { conflicts: Object.values(state.conflicts).map(view) };
      }
      assert(sync[4] === "resolve", 400, "충돌 해결 요청을 확인하세요.");
      return db.withTeamTransaction(teamId, async (tx) => {
        const state = await tx.sync.readState(),
          pending = await tx.sync.readPending(),
          link = await tx.sync.readLink(),
          conflict = state.conflicts[sync[3]];
        assert(
          conflict && !conflict.resolution,
          409,
          "충돌 상태가 변경되었습니다.",
        );
        assert(
          body.expectedHead === link.canonical_head,
          409,
          "최신 공유본을 다시 확인하세요.",
        );
        assert(
          !(
            await tx.query(
              "SELECT 1 FROM site_maintenance_jobs WHERE phase NOT IN ('complete','cancelled')",
            )
          ).rows.length,
          409,
          "팀 자료 정리 중입니다.",
        );
        const frontier = body.frontier || [sync[3]];
        assert(
          Array.isArray(frontier) &&
            frontier.includes(sync[3]) &&
            frontier.every(
              (id) => state.conflicts[id] && !state.conflicts[id].resolution,
            ),
          400,
          "해결 범위를 확인하세요.",
        );
        const choice = body.choice || body.strategy || "current";
        assert(
          [
            "current",
            "submitted",
            "edited",
            "custom",
            "keep",
            "apply",
          ].includes(choice),
          400,
          "충돌 해결 방법을 확인하세요.",
        );
        const changes = [];
        for (const [index, original] of conflict.operation.changes.entries()) {
          if (["current", "keep"].includes(choice)) continue;
          const current =
              state.entities[entityId(original.entity, original.key)],
            desired = ["current", "keep"].includes(choice)
              ? current?.payload
              : ["custom", "edited"].includes(choice)
                ? Array.isArray(body.desired)
                  ? body.desired[index]
                  : (body.desired?.[entityId(original.entity, original.key)] ??
                    body.desired)
                : original.desired;
          assert(
            current || original.action === "create",
            409,
            "대상이 변경되었습니다.",
          );
          changes.push({
            ...original,
            base: current?.payload ?? null,
            baseVersion: current?.version ?? null,
            generation: current?.deleted
              ? crypto.randomUUID()
              : current?.generation || crypto.randomUUID(),
            action: current?.deleted
              ? "restore"
              : current
                ? original.action === "delete" &&
                  !["current", "keep"].includes(choice)
                  ? "delete"
                  : "edit"
                : "create",
            desired,
            fields: [
              ...new Set([
                ...Object.keys(current?.payload || {}),
                ...Object.keys(desired || {}),
              ]),
            ],
          });
        }
        const op = {
          protocol: 1,
          reducer: 1,
          repoId: link.repo_id,
          teamId,
          opId: crypto.randomUUID(),
          writerEpoch: link.writer_epoch,
          actorRef: ctx.user.id,
          createdAt: new Date().toISOString(),
          dependsOn: [],
          changes,
          objects: [],
          resolves: frontier,
        };
        const result = reduce(state, op);
        assert(
          ["applied", "noop"].includes(result.receipt.result),
          409,
          "다시 충돌했습니다. 최신 내용을 확인하세요.",
        );
        await tx.sync.enqueue(op);
        const { materialize } = await import("./sync.mjs");
        await materialize(tx, teamId, {
          state,
          pending: [...pending, op],
          exclusions: await tx.sync.readExclusions(),
        });
        ctx.changedTeams.add(teamId);
        return { ok: true, opId: op.opId };
      });
    }
    if (["run", "pull", "refresh"].includes(sync[2])) {
      if (["pull", "refresh"].includes(sync[2])) await refreshTeam(ctx.env, p);
      else await runTeam(ctx.env, p, { receiveOnly: body.receiveOnly });
      return syncStatus(ctx, teamId);
    }
    if (sync[2] === "enable") {
      ctx.admin();
      return importTeam(ctx, {
        teamId,
        profileId: p.profileId,
        name: team.name,
      });
    }
    if (sync[2] === "checkpoint") {
      const { serviceFor } = await import("./sync.mjs"),
        link = await db.readLink(teamId);
      assert(
        link?.mode === "active",
        409,
        "동기화 활성 상태에서만 checkpoint를 만들 수 있습니다.",
      );
      await serviceFor(ctx.env, p, link).checkpoint();
      return syncStatus(ctx, teamId);
    }
    const modes = {
      pause: "paused",
      resume: "active",
      disconnect: "disconnected",
    };
    if (modes[sync[2]]) {
      if (sync[2] === "disconnect") ctx.admin();
      await db.withTeamTransaction(teamId, async (tx) => {
        const link = await tx.sync.readLink();
        assert(link, 409, "동기화 연결이 없습니다.");
        assert(
          !link.lease_owner || Number(link.lease_until) < Date.now(),
          409,
          "동기화가 진행 중입니다.",
        );
        assert(
          !(
            await tx.query(
              "SELECT 1 FROM site_maintenance_jobs WHERE team_id=$1 AND phase NOT IN ('complete','cancelled')",
              [teamId],
            )
          ).rows.length,
          409,
          "정리가 진행 중입니다.",
        );
        assert(
          sync[2] !== "resume" || link.mode === "paused",
          409,
          "복구 또는 연결 해제 상태는 자동 재개할 수 없습니다.",
        );
        await tx.query(
          "UPDATE team_sync_links SET mode=$2,updated_at=$3,lease_owner=NULL,lease_until=NULL WHERE team_id=$1",
          [teamId, modes[sync[2]], new Date().toISOString()],
        );
      });
      // The next Cron publishes status; administrative state changes do not
      // start an additional full Git cycle in the foreground.
      return syncStatus(ctx, teamId);
    }
  }
  const history = new AdminHistoryBusinessService(
    new PostgresAdminHistoryRepository({ context: ctx }),
    ctx.user,
  );
  if (path === "/admin/audit" && method === "GET") return history.audit(query);
  const audit = /^\/admin\/audit\/([^/]+)$/.exec(path);
  if (audit && method === "GET") return history.auditEntry(audit[1]);
  return undefined;
}
