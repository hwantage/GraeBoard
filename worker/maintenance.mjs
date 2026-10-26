import {
  MaintenanceService,
  maintenanceRevision,
} from "../server/sync/maintenance.mjs";
import { canonical } from "../server/sync/protocol.mjs";
import { retentionKey } from "../server/sync/retention.mjs";
import { databaseFor } from "./data.mjs";
import { profileFor } from "./config.mjs";
import { materialize } from "./sync.mjs";
import { R2ImageStore } from "./images.mjs";
import { GitHubApiTransport } from "./git.mjs";
import { assert } from "./access.mjs";
const decode = (row) =>
  row
    ? {
        jobId: row.job_id,
        kind: row.kind,
        phase: row.phase,
        manifest: JSON.parse(row.manifest),
        progress: JSON.parse(row.progress),
        createdAt: row.created_at,
      }
    : null;
export function maintenanceAdapter(db, teamId) {
  const localSnapshot = (snapshot) => ({
    ...snapshot,
    exclusions: snapshot.exclusions.filter(
      (row) =>
        (row.site_id || row.siteId) === snapshot.connection?.installation_id,
    ),
  });
  const transaction = (fn) => db.withTeamTransaction(teamId, fn);
  const read = async (tx, id) =>
    decode(
      (
        await tx.query(
          "SELECT * FROM site_maintenance_jobs WHERE team_id=$1 AND job_id=$2",
          [teamId, id],
        )
      ).rows[0],
    );
  const save = (tx, job) =>
    tx.query(
      "UPDATE site_maintenance_jobs SET phase=$3,manifest=$4,progress=$5 WHERE team_id=$1 AND job_id=$2",
      [
        teamId,
        job.jobId,
        job.phase,
        canonical(job.manifest),
        canonical(job.progress),
      ],
    );
  return {
    snapshot: async () => localSnapshot(await db.readSnapshot(teamId)),
    listJob: () =>
      transaction(async (tx) =>
        decode(
          (
            await tx.query(
              "SELECT * FROM site_maintenance_jobs WHERE team_id=$1 AND phase<>'cancelled' ORDER BY created_at DESC LIMIT 1",
              [teamId],
            )
          ).rows[0],
        ),
      ),
    readJob: (id) => transaction((tx) => read(tx, id)),
    savePreview: (job) =>
      transaction((tx) =>
        tx.query(
          "INSERT INTO site_maintenance_jobs(job_id,team_id,kind,phase,manifest,progress,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            job.jobId,
            teamId,
            job.kind,
            job.phase,
            canonical(job.manifest),
            canonical(job.progress),
            job.createdAt,
          ],
        ),
      ),
    begin: (job, { actorId, now, revision }) =>
      transaction(async (tx) => {
        const current = await read(tx, job.jobId);
        assert(
          current?.phase === "cancelled" &&
            current.manifest.preview &&
            current.manifest.actorId === actorId &&
            current.manifest.expiresAt >= now,
          409,
          "미리보기가 만료되었습니다.",
        );
        assert(
          !(
            await tx.query(
              "SELECT 1 FROM site_maintenance_jobs WHERE team_id=$1 AND phase NOT IN ('complete','cancelled')",
              [teamId],
            )
          ).rows.length,
          409,
          "진행 중인 정리 작업이 있습니다.",
        );
        const snapshot = localSnapshot(await tx.sync.readSnapshot());
        assert(
          ["active", "paused"].includes(snapshot.connection?.mode),
          409,
          "연결이 활성 또는 일시중지 상태여야 합니다.",
        );
        assert(
          !(
            await tx.query(
              "SELECT 1 FROM site_entities WHERE entity='uploadLease' AND deleted=0",
            )
          ).rows.length,
          409,
          "이미지 업로드 완료 후 다시 시도하세요.",
        );
        assert(
          !snapshot.connection?.lease_owner,
          409,
          "동기화 완료 후 다시 시도하세요.",
        );
        assert(
          maintenanceRevision(snapshot) === revision,
          409,
          "자료가 변경되었습니다. 미리보기를 다시 확인하세요.",
        );
        current.manifest.preview = false;
        current.phase = current.kind === "restore" ? "restoring" : "verifying";
        await save(tx, current);
        return current;
      }),
    claim: (id, owner, now) =>
      transaction(async (tx) => {
        const job = await read(tx, id);
        assert(
          job && !["cancelled", "complete"].includes(job.phase),
          409,
          "진행할 작업이 없습니다.",
        );
        assert(
          !job.progress.owner,
          409,
          "이 정리 작업이 이미 실행 중입니다. 완료 후 다시 확인하세요.",
        );
        job.progress.owner = owner;
        job.progress.until = now + 600000;
        await save(tx, job);
        return job;
      }),
    changeVisibility: (job, { add, remove, keys, phase, owner }) =>
      transaction(async (tx) => {
        const current = await read(tx, job.jobId);
        assert(
          current?.progress.owner === owner,
          409,
          "정리 실행 소유권이 바뀌었습니다.",
        );
        if (add)
          await tx.sync.putExclusion({
            ...add,
            revision: await tx.sync.nextRevision("retention", [
              add.kind,
              add.key,
              add.generation,
            ]),
            createdAt: new Date().toISOString(),
          });
        if (remove)
          await tx.query(
            "DELETE FROM site_retention WHERE team_id=$1 AND site_id=$2 AND kind=$3 AND entity_key=$4 AND generation=$5 AND revision=$6",
            [
              teamId,
              remove.site_id || remove.siteId,
              remove.kind,
              canonical(retentionKey(remove)),
              remove.generation || "",
              remove.revision,
            ],
          );
        const snapshot = localSnapshot(await tx.sync.readSnapshot());
        await materialize(tx, teamId, {
          state: snapshot,
          pending: snapshot.pending,
          exclusions: snapshot.exclusions,
        });
        current.phase = phase;
        await save(tx, current);
      }),
    finishChunk: (job, owner) =>
      transaction(async (tx) => {
        const current = await read(tx, job.jobId);
        assert(
          current?.progress.owner === owner,
          409,
          "정리 실행 소유권이 바뀌었습니다.",
        );
        delete job.progress.owner;
        delete job.progress.until;
        await save(tx, job);
        if (["complete", "failed"].includes(job.phase))
          await tx.query(
            "INSERT INTO site_audit(id,team_id,actor_id,action,target,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              crypto.randomUUID(),
              teamId,
              job.manifest.actorId || "system",
              "maintenance-" + job.phase,
              job.jobId,
              canonical({
                kind: job.kind,
                jobId: job.jobId,
                deleted: job.progress.deleted || 0,
              }),
              new Date().toISOString(),
            ],
          );
      }),
  };
}
export async function maintenanceRoutes(ctx, path, method, body) {
  const uploadRecovery =
    /^\/admin\/teams\/([^/]+)\/maintenance\/uploads\/recover$/.exec(path);
  if (uploadRecovery) {
    ctx.admin();
    const team = await ctx.team(uploadRecovery[1], { allowUnready: true }),
      profile = profileFor(ctx.env, team.profile_id, team.id),
      db = databaseFor(ctx.env, profile);
    return db.withTeamTransaction(team.id, async (tx) => {
      const rows = (
        await tx.query(
          "SELECT entity_key,payload FROM site_entities WHERE team_id=$1 AND entity='uploadLease' AND deleted=0",
          [team.id],
        )
      ).rows;
      if (method === "GET")
        return {
          leases: rows.map((r) => ({
            leaseId: JSON.parse(r.entity_key)[0],
            ...JSON.parse(r.payload),
          })),
        };
      assert(
        method === "POST" &&
          body.confirmedDrained === true &&
          Array.isArray(body.leaseIds) &&
          body.leaseIds.length <= 1000,
        400,
        "이전 업로드 실행 종료와 복구할 ID를 확인하세요.",
      );
      const ids = new Set(rows.map((r) => JSON.parse(r.entity_key)[0]));
      assert(
        body.leaseIds.every((id) => ids.has(id)),
        409,
        "업로드 실행 목록이 변경되었습니다.",
      );
      await tx.query(
        "DELETE FROM site_entities WHERE team_id=$1 AND entity='uploadLease' AND entity_key=ANY($2::text[])",
        [team.id, body.leaseIds.map((id) => canonical([id]))],
      );
      await tx.query(
        "INSERT INTO site_audit(id,team_id,actor_id,action,target,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          crypto.randomUUID(),
          team.id,
          ctx.user.id,
          "upload-drained-recovery",
          team.id,
          canonical({ leaseIds: body.leaseIds, confirmedDrained: true }),
          new Date().toISOString(),
        ],
      );
      return { removed: body.leaseIds.length };
    });
  }
  const match =
    /^\/admin\/teams\/([^/]+)\/maintenance(?:\/(preview|execute|resume|restore|recover))?$/.exec(
      path,
    );
  if (!match) return undefined;
  ctx.admin();
  const team = await ctx.team(match[1]),
    profile = profileFor(ctx.env, team.profile_id, team.id),
    db = databaseFor(ctx.env, profile),
    link = await db.readLink(team.id);
  const service = new MaintenanceService({
    teamId: team.id,
    siteId: link?.installation_id || "external",
    siteName: ctx.env.SITE_NAME || "외부 사이트",
    teamName: team.name,
    adapter: maintenanceAdapter(db, team.id),
    images: new R2ImageStore(ctx.env[profile.bucketBinding], team.id),
    transport: new GitHubApiTransport({
      repository: profile.repository,
      token: ctx.env[profile.githubSecret],
    }),
  });
  if (!match[2] && method === "GET") return service.listing();
  if (method !== "POST") return undefined;
  if (match[2] === "recover") {
    assert(
      body.dryRun === true || body.confirmedDrained === true,
      400,
      "이전 실행의 종료 확인이 필요합니다.",
    );
    return db.withTeamTransaction(team.id, async (tx) => {
      const row = (
          await tx.query(
            "SELECT * FROM site_maintenance_jobs WHERE team_id=$1 AND job_id=$2",
            [team.id, body.jobId],
          )
        ).rows[0],
        job = decode(row);
      assert(
        job &&
          !["complete", "cancelled"].includes(job.phase) &&
          ["cleanup", "restore", "year", "document", "images"].includes(
            job.kind,
          ),
        409,
        "복구할 정리 작업이 없습니다.",
      );
      if (body.dryRun)
        return {
          jobId: job.jobId,
          phase: job.phase,
          ownerPresent: !!job.progress.owner,
        };
      assert(job.progress.owner, 409, "남아 있는 실행 소유자가 없습니다.");
      job.progress.resumePhase = job.progress.resumePhase || job.phase;
      delete job.progress.owner;
      delete job.progress.until;
      job.phase = "failed";
      await tx.query(
        "UPDATE site_maintenance_jobs SET phase=$3,progress=$4 WHERE team_id=$1 AND job_id=$2",
        [team.id, job.jobId, job.phase, canonical(job.progress)],
      );
      await tx.query(
        "INSERT INTO site_audit(id,team_id,actor_id,action,target,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          crypto.randomUUID(),
          team.id,
          ctx.user.id,
          "maintenance-drained-recovery",
          job.jobId,
          canonical({
            confirmedDrained: true,
            resumePhase: job.progress.resumePhase,
          }),
          new Date().toISOString(),
        ],
      );
      return { jobId: job.jobId, phase: "failed", hasMore: true };
    });
  }
  if (match[2] === "preview") return service.preview(body, ctx.user.id);
  if (match[2] === "execute") return service.execute(body, ctx.user.id);
  if (match[2] === "resume") return service.resume(body.jobId);
  if (match[2] === "restore") return service.restore(body, ctx.user.id);
  return undefined;
}
