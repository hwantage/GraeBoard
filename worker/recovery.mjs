import { applicationEntities } from "../server/sync/versions.mjs";
import {
  canonical,
  payloadEqual,
  entityId,
  ENTITIES,
} from "../server/sync/protocol.mjs";
import { project } from "../server/sync/reducer.mjs";
import { isExcluded } from "../server/sync/retention.mjs";
import { assert } from "./access.mjs";
import { databaseFor, controlTransaction, DataSession } from "./data.mjs";
import { profileFor } from "../shared/sync-profiles.js";
import { serviceFor } from "./sync.mjs";
import { GitHubApiTransport } from "./git.mjs";
const decode = (row) =>
  row
    ? {
        jobId: row.job_id,
        phase: row.phase,
        manifest: JSON.parse(row.manifest),
        progress: JSON.parse(row.progress),
      }
    : null;
const result = (job) => ({
  jobId: job.jobId,
  phase: job.phase,
  hasMore: job.phase !== "complete",
  mode: job.phase === "complete" ? "paused" : "recovery",
});
export async function recoveryRoutes(ctx, path, method, body) {
  const match =
    /^\/admin\/teams\/([^/]+)\/sync\/recover(?:\/([^/]+)\/resume)?$/.exec(path);
  if (!match || method !== "POST") return undefined;
  ctx.admin();
  const team = await ctx.team(match[1], { allowUnready: true }),
    profile = profileFor(ctx.env, team.profile_id, team.id),
    db = databaseFor(ctx.env, profile);
  await db.health();
  assert(
    /^[a-f0-9-]{36}$/i.test(ctx.env.INSTALLATION_ID || ""),
    503,
    "설치 UUID를 확인하세요.",
  );
  let job;
  if (match[2]) {
    job = await db.withTeamTransaction(team.id, async (tx) =>
      decode(
        (
          await tx.query(
            "SELECT * FROM site_maintenance_jobs WHERE job_id=$1 AND team_id=$2 AND kind='sync-recovery'",
            [match[2], team.id],
          )
        ).rows[0],
      ),
    );
    assert(
      job &&
        job.manifest.profileId === profile.profileId &&
        job.manifest.installationId === ctx.env.INSTALLATION_ID,
      409,
      "복구 작업의 설치 또는 연결이 바뀌었습니다.",
    );
    if (job.phase === "complete") {
      await controlTransaction(
        ctx.env,
        (tx) =>
          tx.query(
            "UPDATE teams SET status='active' WHERE id=$1 AND profile_id=$2",
            [team.id, profile.profileId],
          ),
        { write: true },
      );
      return result(job);
    }
  } else {
    assert(
      body.confirmedDrained === true &&
        body.expectedProfileId === profile.profileId &&
        body.installationId === ctx.env.INSTALLATION_ID,
      400,
      "이전 실행 종료와 대상 설치·프로필을 확인하세요.",
    );
    job = await db.withTeamTransaction(team.id, async (tx) => {
      const link = await tx.sync.readLink();
      assert(
        link && body.expectedHead === link.canonical_head,
        409,
        "현재 공유본 커서를 다시 확인하세요.",
      );
      assert(
        !(
          await tx.query(
            "SELECT 1 FROM site_maintenance_jobs WHERE phase NOT IN ('complete','cancelled')",
          )
        ).rows.length,
        409,
        "진행 중인 정리·백업·복구를 먼저 완료하세요.",
      );
      assert(
        !(
          await tx.query(
            "SELECT 1 FROM site_entities WHERE entity='uploadLease' AND deleted=0",
          )
        ).rows.length,
        409,
        "남아 있는 업로드 실행을 먼저 복구하세요.",
      );
      const jobId = crypto.randomUUID(),
        manifest = {
          actorId: ctx.user.id,
          profileId: profile.profileId,
          installationId: ctx.env.INSTALLATION_ID,
          oldInstallationId: link.installation_id,
          expectedHead: link.canonical_head,
          previousMode: link.mode,
          confirmedDrained: true,
          loadCheckpoint: body.loadCheckpoint === true,
        },
        now = new Date().toISOString();
      await tx.query(
        "INSERT INTO site_maintenance_jobs(job_id,team_id,kind,phase,manifest,progress,created_at) VALUES($1,$2,'sync-recovery','reconciling',$3,'{}',$4)",
        [jobId, team.id, canonical(manifest), now],
      );
      // Existing outbox bytes retain their original epoch; only future commands
      // use the new writer epoch after the drained old copy is fenced.
      await tx.query(
        "UPDATE team_sync_links SET installation_id=$2,writer_epoch=$3,generation=generation+1,mode='recovery',lease_owner=NULL,lease_until=NULL,remote_status=NULL,last_error=NULL WHERE team_id=$1",
        [team.id, ctx.env.INSTALLATION_ID, crypto.randomUUID()],
      );
      if (link.installation_id !== ctx.env.INSTALLATION_ID) {
        await tx.query(
          "INSERT INTO site_retention(team_id,site_id,kind,entity_key,generation,revision,created_at) SELECT team_id,$3,kind,entity_key,generation,revision,created_at FROM site_retention WHERE team_id=$1 AND site_id=$2 ON CONFLICT DO NOTHING",
          [team.id, link.installation_id, ctx.env.INSTALLATION_ID],
        );
        await tx.query(
          "DELETE FROM site_retention WHERE team_id=$1 AND site_id=$2",
          [team.id, link.installation_id],
        );
      }
      const snapshot = await tx.sync.readSnapshot(),
        visible = applicationEntities(
          project(snapshot, snapshot.pending).entities,
        ),
        exclusions = snapshot.exclusions.filter(
          (r) => r.site_id === ctx.env.INSTALLATION_ID,
        ),
        s = new DataSession(tx, team.id);
      for (const row of (
        await tx.query("SELECT * FROM site_entities WHERE team_id=$1", [
          team.id,
        ])
      ).rows) {
        if (
          !ENTITIES.has(row.entity) ||
          ["protocol", "reportTask", "reportCell"].includes(row.entity)
        )
          continue;
        const key = JSON.parse(row.entity_key),
          record = visible[entityId(row.entity, key)];
        if (record && isExcluded(record, visible, exclusions)) continue;
        const payload = JSON.parse(row.payload),
          deleted = !!row.deleted,
          soft = ["task", "calendar"].includes(row.entity),
          sharedDeleted = deleted || (soft && !!payload.deletedAt);
        if (
          record &&
          !!record.deleted === !!sharedDeleted &&
          payloadEqual(
            row.entity,
            soft ? { ...record.payload, deletedAt: null } : record.payload,
            soft ? { ...payload, deletedAt: null } : payload,
          )
        )
          continue;
        s.changes.set(entityId(row.entity, key), {
          entity: row.entity,
          key,
          before: null,
          after: {
            entity: row.entity,
            key,
            payload,
            deleted,
            revision: Number(row.revision),
          },
        });
      }
      await s.capture(ctx.user.id);
      await tx.query(
        "INSERT INTO site_audit(id,team_id,actor_id,action,target,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          crypto.randomUUID(),
          team.id,
          ctx.user.id,
          "sync-drained-recovery",
          jobId,
          canonical({
            profileId: profile.profileId,
            installationId: ctx.env.INSTALLATION_ID,
            captured: s.changes.size,
          }),
          now,
        ],
      );
      return { jobId, phase: "reconciling", manifest, progress: {} };
    });
  }
  await controlTransaction(
    ctx.env,
    (tx) =>
      tx.query(
        "UPDATE teams SET status='maintenance' WHERE id=$1 AND profile_id=$2",
        [team.id, profile.profileId],
      ),
    { write: true },
  );
  try {
    const link = await db.readLink(team.id);
    await serviceFor(ctx.env, profile, link, {
      maintenanceJobId: job.jobId,
    }).run({
      receiveOnly: true,
      updateStatus: false,
      loadCheckpoint: job.manifest.loadCheckpoint === true,
    });
    const current = await db.readLink(team.id),
      transport = new GitHubApiTransport({
        repository: profile.repository,
        token: ctx.env[profile.githubSecret],
      });
    if (current.canonical_head !== (await transport.readHead()))
      return result(job);
    await db.withTeamTransaction(team.id, async (tx) => {
      const link = await tx.sync.readLink();
      assert(
        !link.lease_owner && link.installation_id === ctx.env.INSTALLATION_ID,
        409,
        "복구 실행 소유권이 바뀌었습니다.",
      );
      await tx.query(
        "UPDATE team_sync_links SET mode='paused',remote_status=NULL,last_error=NULL WHERE team_id=$1",
        [team.id],
      );
      await tx.query(
        "UPDATE site_maintenance_jobs SET phase='complete',progress='{}' WHERE job_id=$1",
        [job.jobId],
      );
    });
    await controlTransaction(
      ctx.env,
      (tx) =>
        tx.query(
          "UPDATE teams SET status='active' WHERE id=$1 AND profile_id=$2",
          [team.id, profile.profileId],
        ),
      { write: true },
    );
    job.phase = "complete";
    return result(job);
  } catch (error) {
    await db.withTeamTransaction(team.id, (tx) =>
      tx.query("UPDATE site_maintenance_jobs SET progress=$2 WHERE job_id=$1", [
        job.jobId,
        canonical({
          error:
            "복구 검증을 완료하지 못했습니다. 원인을 확인한 뒤 다시 실행하세요.",
        }),
      ]),
    );
    throw error;
  }
}
