import {
  TEAM_TRANSFER_TABLES,
  portableRow,
} from "../shared/logical-format.mjs";
import { createHash } from "node:crypto";
import { canonical, digest } from "../server/sync/protocol.mjs";
import { controlTransaction, databaseFor } from "./data.mjs";
import { profiles, profileFor } from "../shared/sync-profiles.js";
import { R2ImageStore } from "./images.mjs";
import { assert } from "./access.mjs";
const tables = TEAM_TRANSFER_TABLES;
const parsed = (row) =>
  row
    ? {
        id: row.id,
        teamId: row.team_id,
        phase: row.phase,
        ...JSON.parse(row.payload),
      }
    : null;
const publicJob = (job) => ({
  jobId: job.id,
  phase: job.phase,
  profileId: job.newProfileId,
  hasMore: job.phase !== "complete",
  table: tables[job.tableIndex]?.[0],
  rowsCopied: job.rowsCopied || 0,
  imagesCopied: job.imagesCopied || 0,
});
const updateJob = (env, job, expected) =>
  controlTransaction(
    env,
    async (tx) => {
      const previous = job.revision || 0;
      job.revision = previous + 1;
      const result = await tx.query(
        "UPDATE control_jobs SET phase=$3,payload=$4 WHERE id=$1 AND phase=$2 AND COALESCE((payload::jsonb->>'revision')::bigint,0)=$5",
        [
          job.id,
          expected,
          job.phase,
          canonical(
            Object.fromEntries(
              Object.entries(job).filter(
                ([key]) => !["id", "teamId", "phase"].includes(key),
              ),
            ),
          ),
          previous,
        ],
      );
      assert(
        result.rowCount,
        409,
        "다른 요청이 이관을 진행했습니다. 작업을 다시 조회하세요.",
      );
    },
    { write: true },
  );
const records = (tx, table, order, jobId, offset = 0, limit = 500) =>
  tx.query(
    `SELECT * FROM ${table}${table === "site_maintenance_jobs" ? " WHERE job_id<>$1" : ""} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    table === "site_maintenance_jobs" ? [jobId] : [],
  );
const normalize = portableRow;
async function tableHash(db, teamId, table, order, jobId) {
  const h = createHash("sha256");
  let count = 0;
  for (let offset = 0; ; offset += 500) {
    const rows = await db.withTeamTransaction(
      teamId,
      (tx) => records(tx, table, order, jobId, offset),
      { readOnly: true },
    );
    for (const row of rows.rows) {
      h.update(canonical(normalize(row)));
      h.update("\n");
      count++;
    }
    if (rows.rows.length < 500) break;
  }
  return { count, hash: h.digest("hex") };
}
export async function beginProfileSwitch(
  ctx,
  team,
  newProfileId,
  expectedRevision,
) {
  ctx.admin();
  assert(
    expectedRevision === undefined ||
      Number(expectedRevision) === Number(team.config_revision),
    409,
    "팀 연결 설정이 변경되었습니다.",
  );
  const oldProfile = profileFor(ctx.env, team.profile_id, team.id),
    next = profileFor(ctx.env, newProfileId, team.id);
  assert(
    next.replaces === oldProfile.profileId,
    409,
    "새 프로필의 replaces에 현재 프로필을 지정하세요.",
  );
  assert(
    next.repository === oldProfile.repository,
    400,
    "같은 팀 Git 저장소를 사용하는 교체 프로필만 선택하세요.",
  );
  const source = databaseFor(ctx.env, oldProfile),
    destination = databaseFor(ctx.env, next);
  await Promise.all([source.health(), destination.health()]);
  const existing = await controlTransaction(ctx.env, async (tx) =>
    parsed(
      (
        await tx.query(
          "SELECT * FROM control_jobs WHERE team_id=$1 AND kind='profile-switch' AND phase<>'complete'",
          [team.id],
        )
      ).rows[0],
    ),
  );
  if (existing) {
    assert(
      existing.newProfileId === next.profileId,
      409,
      "다른 프로필 교체 작업이 진행 중입니다.",
    );
    return resumeProfileSwitch(ctx.env, existing.id);
  }
  await destination.withTeamTransaction(team.id, async (tx) => {
    for (const [table] of tables)
      if (table !== "teams")
        assert(
          !(await tx.query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length,
          409,
          "교체 대상 DB는 새 마이그레이션을 마친 빈 팀 DB여야 합니다.",
        );
  });
  const job = {
    id: crypto.randomUUID(),
    teamId: team.id,
    phase: "freezing",
    oldProfileId: oldProfile.profileId,
    newProfileId: next.profileId,
    actorId: ctx.user.id,
    tableIndex: 0,
    offset: 0,
    rowsCopied: 0,
    imagesCopied: 0,
    createdAt: new Date().toISOString(),
  };
  await controlTransaction(
    ctx.env,
    (tx) =>
      tx.query(
        "INSERT INTO control_jobs(id,team_id,kind,phase,payload,created_at) VALUES($1,$2,'profile-switch',$3,$4,$5)",
        [
          job.id,
          job.teamId,
          job.phase,
          canonical(
            Object.fromEntries(
              Object.entries(job).filter(
                ([k]) => !["id", "teamId", "phase"].includes(k),
              ),
            ),
          ),
          job.createdAt,
        ],
      ),
    { write: true },
  );
  return resumeProfileSwitch(ctx.env, job.id);
}
export async function resumeProfileSwitch(env, id) {
  let job = await controlTransaction(env, async (tx) =>
    parsed(
      (
        await tx.query(
          "SELECT * FROM control_jobs WHERE id=$1 AND kind='profile-switch'",
          [id],
        )
      ).rows[0],
    ),
  );
  assert(job, 404, "프로필 교체 작업을 찾을 수 없습니다.");
  if (job.phase === "complete") return publicJob(job);
  const old = profileFor(env, job.oldProfileId, job.teamId),
    next = profileFor(env, job.newProfileId, job.teamId),
    source = databaseFor(env, old),
    destination = databaseFor(env, next);
  if (job.phase === "freezing") {
    await source.withTeamTransaction(job.teamId, async (tx) => {
      const current = (
        await tx.query(
          "SELECT job_id FROM site_maintenance_jobs WHERE job_id=$1",
          [job.id],
        )
      ).rows[0];
      if (current) return;
      assert(
        !(
          await tx.query(
            "SELECT 1 FROM site_maintenance_jobs WHERE phase NOT IN ('complete','cancelled')",
          )
        ).rows.length,
        409,
        "정리 또는 백업이 끝난 뒤 다시 시도하세요.",
      );
      const link = await tx.sync.readLink();
      assert(
        link && (!link.lease_owner || Number(link.lease_until) < Date.now()),
        409,
        "동기화 완료 후 다시 시도하세요.",
      );
      await tx.query(
        "UPDATE team_sync_links SET lease_owner=NULL,lease_until=NULL WHERE team_id=$1",
        [job.teamId],
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
      await tx.query(
        "INSERT INTO site_maintenance_jobs(job_id,team_id,kind,phase,manifest,progress,created_at) VALUES($1,$2,'profile-switch','frozen',$3,'{}',$4)",
        [
          job.id,
          job.teamId,
          canonical({ newProfileId: next.profileId }),
          job.createdAt,
        ],
      );
    });
    await controlTransaction(
      env,
      (tx) =>
        tx.query(
          "UPDATE teams SET status='maintenance' WHERE id=$1 AND profile_id=$2",
          [job.teamId, old.profileId],
        ),
      { write: true },
    );
    job.phase = "copying";
    await updateJob(env, job, "freezing");
  }
  if (job.phase === "copying") {
    const [table, order] = tables[job.tableIndex],
      rows = await source.withTeamTransaction(
        job.teamId,
        (tx) => records(tx, table, order, job.id, job.offset),
        { readOnly: true },
      );
    await destination.withTeamTransaction(job.teamId, async (tx) => {
      for (const row of rows.rows) {
        if (table === "teams") {
          await tx.query("UPDATE teams SET name=$2,settings=$3 WHERE id=$1", [
            row.id,
            row.name,
            row.settings,
          ]);
          continue;
        }
        const columns = Object.keys(row);
        assert(
          columns.every((c) => /^[a-z_]+$/.test(c)),
          500,
          "DB 열 이름이 올바르지 않습니다.",
        );
        await tx.query(
          `INSERT INTO ${table}(${columns.join(",")}) ${["sync_outbox", "site_events"].includes(table) ? "OVERRIDING SYSTEM VALUE " : ""}VALUES(${columns.map((_, i) => "$" + (i + 1)).join(",")}) ON CONFLICT DO NOTHING`,
          Object.values(row),
        );
      }
    });
    job.offset += rows.rows.length;
    job.rowsCopied += rows.rows.length;
    if (rows.rows.length < 500) {
      job.tableIndex++;
      job.offset = 0;
    }
    if (job.tableIndex === tables.length) {
      job.phase = "verifying";
      job.tableIndex = 0;
    }
    await updateJob(env, job, "copying");
    return publicJob(job);
  }
  if (job.phase === "verifying") {
    const [table, order] = tables[job.tableIndex],
      [from, to] = await Promise.all([
        tableHash(source, job.teamId, table, order, job.id),
        tableHash(destination, job.teamId, table, order, job.id),
      ]);
    assert(
      from.count === to.count && from.hash === to.hash,
      409,
      `프로필 이관 검증에 실패했습니다: ${table}`,
    );
    job.tableIndex++;
    if (job.tableIndex === tables.length) job.phase = "images";
    await updateJob(env, job, "verifying");
    return publicJob(job);
  }
  if (job.phase === "images") {
    const from = new R2ImageStore(env[old.bucketBinding], job.teamId),
      to = new R2ImageStore(env[next.bucketBinding], job.teamId),
      images = (await from.list()).sort((a, b) => a.url.localeCompare(b.url)),
      batch = images.slice(job.imagesCopied, job.imagesCopied + 25);
    for (const image of batch) {
      const bytes = await from.read(image.url);
      assert(bytes, 409, "원본 이미지가 변경되었습니다.");
      await to.install(image.url, bytes);
      const saved = await to.read(image.url);
      assert(
        saved && digest(saved) === digest(bytes),
        409,
        "교체 이미지 검증에 실패했습니다.",
      );
      job.imagesCopied++;
    }
    if (job.imagesCopied === images.length) job.phase = "switching";
    await updateJob(env, job, "images");
    return publicJob(job);
  }
  if (job.phase === "switching") {
    const { imageSync } = await import("./sync.mjs"),
      { GitHubApiTransport } = await import("./git.mjs");
    const snapshot = await destination.readSnapshot(job.teamId);
    if (snapshot.connection.canonical_head)
      await imageSync(
        destination,
        next,
        new R2ImageStore(env[next.bucketBinding], job.teamId),
      ).receive(
        snapshot,
        snapshot.connection.canonical_head,
        new GitHubApiTransport({
          repository: next.repository,
          token: env[next.githubSecret],
        }),
      );
    await destination.withTeamTransaction(job.teamId, async (tx) => {
      const link = await tx.sync.readLink();
      assert(link, 409, "교체 DB 동기화 상태가 없습니다.");
      if (link.profile_id !== next.profileId)
        await tx.query(
          "UPDATE team_sync_links SET profile_id=$2,writer_epoch=$3,generation=generation+1,lease_owner=NULL,lease_until=NULL WHERE team_id=$1",
          [job.teamId, next.profileId, crypto.randomUUID()],
        );
      for (const [table, column] of [
        ["sync_outbox", "local_seq"],
        ["site_events", "cursor"],
      ])
        await tx.query(
          `SELECT setval(pg_get_serial_sequence($1,$2),GREATEST(COALESCE((SELECT MAX(${column}) FROM ${table}),0),1),COALESCE((SELECT MAX(${column}) FROM ${table}),0)>0)`,
          ["graeboard." + table, column],
        );
    });
    await controlTransaction(
      env,
      async (tx) => {
        const team = (
          await tx.query("SELECT * FROM teams WHERE id=$1 FOR UPDATE", [
            job.teamId,
          ])
        ).rows[0];
        assert(
          [old.profileId, next.profileId].includes(team.profile_id),
          409,
          "팀 연결이 다른 프로필로 바뀌었습니다.",
        );
        await tx.query(
          "UPDATE teams SET profile_id=$2,status='active',config_revision=config_revision+1 WHERE id=$1 AND profile_id<>$2",
          [job.teamId, next.profileId],
        );
      },
      { write: true },
    );
    await source.withTeamTransaction(job.teamId, async (tx) => {
      await tx.query(
        "UPDATE site_maintenance_jobs SET phase='fenced' WHERE job_id=$1",
        [job.id],
      );
      await tx.query(
        "UPDATE team_sync_links SET mode='recovery',generation=generation+1,last_error='Profile retired; never resume this copy' WHERE team_id=$1",
        [job.teamId],
      );
    });
    job.phase = "complete";
    await updateJob(env, job, "switching");
  }
  return publicJob(job);
}
export async function profileSwitchRoutes(ctx, path, method, body) {
  const m =
    /^\/admin\/teams\/([^/]+)\/connection\/switch(?:\/([^/]+)\/resume)?$/.exec(
      path,
    );
  if (!m) return undefined;
  ctx.admin();
  const team = await ctx.team(m[1], { allowUnready: true });
  if (method === "GET") {
    return controlTransaction(ctx.env, async (tx) => {
      const row = (
        await tx.query(
          "SELECT * FROM control_jobs WHERE team_id=$1 AND kind='profile-switch' ORDER BY created_at DESC LIMIT 1",
          [team.id],
        )
      ).rows[0];
      return { job: row ? publicJob(parsed(row)) : null };
    });
  }
  if (method === "POST" && m[2]) {
    const job = await controlTransaction(ctx.env, async (tx) =>
      parsed(
        (
          await tx.query(
            "SELECT * FROM control_jobs WHERE id=$1 AND team_id=$2",
            [m[2], team.id],
          )
        ).rows[0],
      ),
    );
    assert(job, 404, "교체 작업을 찾을 수 없습니다.");
    return resumeProfileSwitch(ctx.env, job.id);
  }
  if (method === "POST")
    return beginProfileSwitch(ctx, team, body.profileId, body.expectedRevision);
  return undefined;
}
