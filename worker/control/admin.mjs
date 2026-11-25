import { operationListSummary } from "../../shared/sync/sync-conflict-summaries.mjs";
import { receiptCapacity } from "../../shared/sync/sync-capacity.mjs";
import {
  CONFLICT_PAGE_SIZE,
  conflictPage,
  conflictOpIds,
  conflictOrigin,
  conflictPeople,
  pendingResolutions,
  resolvesAny,
} from "../../shared/sync/conflict-origin.js";
import { plainConflictPayloads } from "../../shared/sheet-clones/sheet-clone-sync-data.js";
import {
  SYSTEM_AUDIT_ROUTES,
  matchBusinessRoute,
  callBusinessRoute,
} from "../../shared/http/business-routes.js";
import { AdminHistoryBusinessService } from "../../server/storage/history/admin-history-service.mjs";
import { PostgresAdminHistoryRepository } from "../storage/history/postgres-admin-history.mjs";
import { PostgresDatabase } from "../storage/postgres.mjs";
import {
  canonical,
  entityId,
  digest,
  protocolVersion,
  PROTOCOL,
} from "../../server/sync/core/protocol.mjs";
import { assert } from "./access.mjs";
import {
  profiles,
  profileFor,
  siteTeamId,
} from "../../shared/sync/sync-profiles.js";
import {
  controlTransaction,
  databaseFor,
  controlPool,
  DataSession,
} from "../storage/data.mjs";
import { GitHubApiTransport } from "../sync/git.mjs";
import { R2ImageStore } from "../documents/images.mjs";
import { beginProfileSwitch } from "../sync/profile-switch.mjs";
import { runTeam, refreshTeam, importTeam } from "../sync/sync.mjs";
import { resolveConflict } from "../sync/sync-resolve.mjs";
import { createExternalSyncLog } from "../sync/sync-log-api.mjs";
const externalSyncLog = createExternalSyncLog();
// Bound PostgreSQL JSON work as well as the number of rows. One large
// conflict must still fit on its own page so the cursor always advances.
const CONFLICT_PAGE_BYTES = 8 * 1024 * 1024;
// Only the fields used by view/conflictOrigin/conflictOpIds/conflictPeople.
// json_to_record skips before/after values instead of building a jsonb tree
// for the entire copy. Full values are read only for detail or a saved choice.
const CONFLICT_SUMMARIES = `SELECT json_build_object(
  'conflictId', c."conflictId", 'opId', c."opId", 'reason', c.reason,
  'resolution', CASE WHEN json_typeof(c.resolution) NOT IN ('null', 'boolean') OR c.resolution::text='true' THEN true END,
  'operation', json_build_object('createdAt', o."createdAt", 'actorRef', o."actorRef", 'writerEpoch', o."writerEpoch", 'changes', COALESCE((
    SELECT json_agg(json_build_object('entity', change.entity, 'key', change.key) ORDER BY n)
    FROM json_array_elements(o.changes) WITH ORDINALITY AS x(value, n)
    CROSS JOIN LATERAL json_to_record(x.value) AS change(entity text, key json)), '[]'::json)),
  'current', CASE WHEN json_typeof(c.current)='object' THEN (
    SELECT COALESCE(json_object_agg(k, CASE WHEN json_typeof(v)='object' THEN json_build_object('version', v->'version') ELSE v END), '{}'::json)
    FROM json_each(c.current) AS e(k, v)) END
)::text AS payload
FROM (SELECT conflict_id, payload FROM sync_conflicts WHERE team_id=$1 AND conflict_id=ANY($2::text[]) OFFSET 0) conflicts
CROSS JOIN LATERAL json_to_record(conflicts.payload::json) AS c("conflictId" text, "opId" text, reason text, resolution json, operation json, current json)
CROSS JOIN LATERAL json_to_record(c.operation) AS o("createdAt" text, "actorRef" text, "writerEpoch" text, changes json)
ORDER BY conflict_id`;

async function serviceStatus(ctx, { check = false } = {}) {
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
async function syncStatus(ctx, teamId) {
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
            "SELECT (SELECT COUNT(*) FROM sync_outbox WHERE team_id=$1 AND status<>'acknowledged') pending,(SELECT COUNT(*) FROM sync_conflicts WHERE team_id=$1 AND resolution IS NULL) conflicts,(SELECT payload FROM sync_entities WHERE team_id=$1 AND entity='protocol' AND deleted=0) protocol_marker,(SELECT created_at FROM sync_outbox WHERE team_id=$1 ORDER BY local_seq DESC LIMIT 1) last_saved,2+(SELECT COALESCE(SUM(octet_length(to_json(op_id)::text)+octet_length(receipt)+2),0) FROM sync_receipts WHERE team_id=$1) receipt_bytes",
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
    receiptCapacity: receiptCapacity(Number(snapshot.counts.receipt_bytes)),
    canonicalHead: link?.canonical_head,
    canonicalHash: link?.canonical_hash,
    protocol:
      JSON.parse(snapshot.counts.protocol_marker || "null")?.version ??
      PROTOCOL,
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
    // A team lead reads the team's connection, as on the internal server.
    // Changing it stays with system admins.
    if (method !== "GET") ctx.admin();
    const team = await ctx.team(connection[1], {
      manage: true,
      allowUnready: true,
    });
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
  const log = /^\/teams\/([^/]+)\/sync\/log$/.exec(path);
  if (log)
    return externalSyncLog(ctx.request, ctx.env, log[1], () =>
      ctx.team(log[1], { manage: true, allowUnready: true }),
    );
  const sync =
    /^\/teams\/([^/]+)\/sync(?:\/(check|enable|pause|resume|run|pull|refresh|disconnect|checkpoint|upgrade|conflicts)(?:\/([^/]+)(?:\/(resolve))?)?)?$/.exec(
      path,
    );
  if (sync) {
    const teamId = sync[1];
    // Conflicts are settled by whoever edits the team's work.
    await ctx.team(teamId, {
      manage:
        method !== "GET" && !["pull", "refresh", "conflicts"].includes(sync[2]),
      write: sync[2] === "conflicts",
      allowUnready: true,
    });
    assert(
      sync[2] !== "enable",
      403,
      "초기 게시는 내부 서버에서만 가능합니다. 외부에서는 서비스 연결의 팀 가져오기를 사용하세요.",
    );
    if (!sync[2]) return syncStatus(ctx, teamId);
    if (sync[2] === "check") return checkTeam(ctx, teamId);
    const team = await ctx.team(teamId, { allowUnready: true }),
      p = profileFor(ctx.env, team.profile_id, teamId),
      db = databaseFor(ctx.env, p);
    if (sync[2] === "conflicts") {
      if (method === "GET") {
        // Only the conflicts themselves: loading C to list them cost the
        // whole team and could exceed the Edge CPU budget.
        const page = conflictPage({
          status: query.get("status") ?? undefined,
          after: query.get("after") ?? undefined,
        });
        const { conflicts, local, names, resolutions, next } =
            await db.withTeamTransaction(
              teamId,
              async (tx) => {
                // Read sizes without parsing JSON: twenty copy conflicts can
                // be hundreds of MB even though their summaries are small.
                const candidates =
                  sync[3] && !tx.readModels
                    ? [{ conflict_id: sync[3], payload_bytes: 0 }]
                    : (
                        await tx.query(
                          `SELECT c.conflict_id,octet_length(c.payload) payload_bytes${tx.readModels ? ",s.summary" : ""} FROM sync_conflicts c ${tx.readModels ? "LEFT JOIN sync_conflict_summaries s USING(team_id,conflict_id)" : ""} WHERE c.team_id=$1 AND c.conflict_id${sync[3] ? "=" : ">"}$2${sync[3] || page.status === "all" ? "" : page.status === "resolved" ? " AND c.resolution IS NOT NULL" : " AND c.resolution IS NULL"} ORDER BY c.conflict_id LIMIT $3`,
                          [
                            teamId,
                            sync[3] || page.after,
                            CONFLICT_PAGE_SIZE + 1,
                          ],
                        )
                      ).rows;
                const cached =
                  tx.readModels &&
                  candidates.every((row) => row.summary != null);
                const ids = [];
                let bytes = 0;
                for (const row of candidates) {
                  const size = Number(row.payload_bytes);
                  if (
                    ids.length >= CONFLICT_PAGE_SIZE ||
                    (!cached &&
                      ids.length &&
                      bytes + size > CONFLICT_PAGE_BYTES)
                  )
                    break;
                  ids.push(row.conflict_id);
                  bytes += size;
                }
                const next = candidates.length > ids.length ? ids.at(-1) : null;
                // v4 lists read only stored summaries; v3 or invalidated rows
                // use the bounded legacy path. Details read one original.
                const summaries = cached
                  ? candidates
                      .slice(0, ids.length)
                      .map((row) => JSON.parse(row.summary))
                  : null;
                const conflicts =
                  cached && !sync[3]
                    ? summaries
                    : (
                        await tx.query(
                          sync[3]
                            ? "SELECT payload FROM sync_conflicts WHERE team_id=$1 AND conflict_id=$2"
                            : CONFLICT_SUMMARIES,
                          sync[3] ? [teamId, sync[3]] : [teamId, ids],
                        )
                      ).rows.map((row) => JSON.parse(row.payload));
                // This site's own operations among the held ones and the
                // current writers; anything else came from the internal site.
                // PostgreSQL extracts the two fields so Edge parses no payload.
                const local = new Map(
                  (
                    await tx.query(
                      tx.readModels
                        ? `SELECT b.op_id,o."actorRef" actor_ref,o."createdAt" created_at FROM sync_outbox b LEFT JOIN sync_outbox_summaries s USING(team_id,op_id) CROSS JOIN LATERAL json_to_record(COALESCE(s.summary,b.payload)::json) AS o("actorRef" text,"createdAt" text) WHERE b.team_id=$1 AND b.op_id=ANY($2::text[])`
                        : 'SELECT op_id,o."actorRef" actor_ref,o."createdAt" created_at FROM sync_outbox CROSS JOIN LATERAL json_to_record(payload::json) AS o("actorRef" text,"createdAt" text) WHERE team_id=$1 AND op_id=ANY($2::text[])',
                      [teamId, conflictOpIds(conflicts)],
                    )
                  ).rows.map((row) => [
                    row.op_id,
                    { actorRef: row.actor_ref, createdAt: row.created_at },
                  ]),
                );
                const names = new Map(
                  (
                    await tx.query(
                      "SELECT entity_key,payload::jsonb->>'name' name FROM sync_entities WHERE team_id=$1 AND entity='person' AND entity_key=ANY($2::text[])",
                      [
                        teamId,
                        conflictPeople(conflicts, local).map((person) =>
                          JSON.stringify([person]),
                        ),
                      ],
                    )
                  ).rows.map((row) => [
                    JSON.parse(row.entity_key)[0],
                    row.name,
                  ]),
                );
                // Resolutions saved here and not yet published.
                const unresolved = conflicts
                  .filter((c) => !c.resolution)
                  .map((c) => c.conflictId);
                const pending = unresolved.length
                  ? (
                      await tx.query(
                        cached
                          ? "SELECT COALESCE(s.summary,b.payload) payload,s.summary IS NULL AS whole FROM sync_outbox b LEFT JOIN sync_outbox_summaries s USING(team_id,op_id) WHERE b.team_id=$1 AND b.status<>'acknowledged' AND EXISTS (SELECT 1 FROM json_array_elements_text(COALESCE(s.summary,b.payload)::json->'resolves') AS r(id) WHERE r.id=ANY($2::text[])) ORDER BY b.local_seq"
                          : "SELECT payload FROM sync_outbox WHERE team_id=$1 AND status<>'acknowledged' AND EXISTS (SELECT 1 FROM json_array_elements_text(payload::json->'resolves') AS r(id) WHERE r.id=ANY($2::text[])) ORDER BY local_seq",
                        [teamId, unresolved],
                      )
                    ).rows.map((row) => {
                      const value = JSON.parse(row.payload);
                      return cached && row.whole
                        ? operationListSummary(value)
                        : value;
                    })
                  : [];
                // v4 compares saved value hashes. Only the legacy fallback
                // reads full values to label a pending resolution.
                const decided = sync[3]
                  ? conflicts
                  : conflicts.filter(
                      (c) =>
                        !c.resolution && resolvesAny(pending, [c.conflictId]),
                    );
                return {
                  next,
                  conflicts,
                  local,
                  names,
                  resolutions: pendingResolutions(
                    cached
                      ? summaries.filter((c) => !c.resolution)
                      : sync[3] || !decided.length
                        ? decided.filter((c) => !c.resolution)
                        : (
                            await tx.query(
                              "SELECT payload FROM sync_conflicts WHERE team_id=$1 AND conflict_id=ANY($2::text[])",
                              [teamId, decided.map((c) => c.conflictId)],
                            )
                          ).rows.map((row) => JSON.parse(row.payload)),
                    pending,
                  ),
                };
              },
              { readOnly: true },
            ),
          link = await db.readLink(teamId),
          view = (c) => ({
            conflictId: c.conflictId,
            opId: c.opId,
            createdAt: c.operation.createdAt,
            target: c.operation.changes
              .map((x) => x.entity + " " + x.key.join("/"))
              .join(", "),
            result: c.reason,
            ...(sync[3] ? plainConflictPayloads(c) : {}),
            expectedHead: link.canonical_head,
            frontier: [c.opId],
            resolved: !!c.resolution,
            origin: conflictOrigin(c, {
              site: "external",
              local,
              names,
              writerEpoch: link.writer_epoch,
            }),
            pendingResolution: resolutions.get(c.conflictId) || null,
          });
        if (sync[3]) {
          assert(conflicts.length, 404, "충돌을 찾을 수 없습니다.");
          return view(conflicts[0]);
        }
        return { conflicts: conflicts.map(view), next };
      }
      assert(sync[4] === "resolve", 400, "충돌 해결 요청을 확인하세요.");
      return resolveConflict(ctx, db, teamId, sync[3], body);
    }
    if (["run", "pull", "refresh"].includes(sync[2])) {
      if (["pull", "refresh"].includes(sync[2])) await refreshTeam(ctx.env, p);
      else {
        // Another run holding the lease means this request did nothing.
        const result = await runTeam(ctx.env, p, {
          receiveOnly: body.receiveOnly,
        });
        if (result?.busy)
          return { ...(await syncStatus(ctx, teamId)), busy: true };
      }
      return syncStatus(ctx, teamId);
    }
    if (sync[2] === "upgrade") {
      assert(method === "POST", 405, "POST 요청으로 실행하세요.");
      assert(
        ctx.user.systemRole === "admin",
        403,
        "시스템 관리자 권한이 필요합니다.",
      );
      const { serviceFor } = await import("../sync/sync.mjs");
      await db.withTeamTransaction(
        teamId,
        async (tx) => {
          const jobs = await tx.query(
            "SELECT 1 FROM site_maintenance_jobs WHERE team_id=$1 AND phase NOT IN ('complete','cancelled')",
            [teamId],
          );
          assert(!jobs.rows.length, 409, "정리·백업 작업을 먼저 완료하세요.");
        },
        { readOnly: true },
      );
      return serviceFor(ctx.env, p, await db.readLink(teamId)).upgrade({
        expectedHead: body.expectedHead,
        expectedHash: body.expectedHash,
        peersStopped: body.peersStopped,
      });
    }
    if (sync[2] === "checkpoint") {
      const { serviceFor } = await import("../sync/sync.mjs"),
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
  const auditRoute = matchBusinessRoute(SYSTEM_AUDIT_ROUTES, path, method);
  if (auditRoute)
    return callBusinessRoute(history, auditRoute.route, {
      params: auditRoute.params,
      body,
      query,
    });
  return undefined;
}
