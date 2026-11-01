import {
  capacityLimits,
  assertDatabaseCapacity,
  boundedTransport,
  exclusiveSync,
  decodeBoundedSnapshot,
} from "./capacity.mjs";
import { SyncService } from "../server/sync/service.mjs";
import { SYNC_SNAPSHOT_MAX_BYTES } from "../shared/sync-limits.js";
import {
  canonical,
  digest,
  entityId,
  equal,
  ENTITIES,
} from "../server/sync/protocol.mjs";
import { project } from "../server/sync/reducer.mjs";
import { GitHubApiTransport } from "./git.mjs";
import { R2ImageStore, imageReferences, stillImage } from "./images.mjs";
import {
  DataSession,
  databaseFor,
  controlTransaction,
  SYNC_STATEMENT_TIMEOUT_MS,
} from "./data.mjs";
const syncDatabase = (env, profile) =>
  databaseFor(env, profile, { statementTimeout: SYNC_STATEMENT_TIMEOUT_MS });
import { profiles, profileFor } from "../shared/sync-profiles.js";
import { assert } from "./access.mjs";
import { refreshDirectory } from "./directory.mjs";
import { isExcluded } from "../server/sync/retention.mjs";

export const excluded = isExcluded;
export { materialize } from "./materialize.mjs";
export { boundStore } from "./sync-store.mjs";
export { imageSync } from "./sync-images.mjs";
import { boundStore } from "./sync-store.mjs";
import { imageSync } from "./sync-images.mjs";

const PUBLISH_DELAY_MS = 2000;
const PUBLISH_INTERVAL_MS = 5000;
async function schedulingState(tx, teamId) {
  const row = (
    await tx.query(
      "SELECT payload FROM site_entities WHERE team_id=$1 AND entity='syncRefresh' AND entity_key='[]'",
      [teamId],
    )
  ).rows[0];
  return JSON.parse(row?.payload || "{}");
}
async function saveSchedulingState(tx, teamId, state) {
  await tx.query(
    "INSERT INTO site_entities(team_id,entity,entity_key,payload,revision,deleted) VALUES($1,'syncRefresh','[]',$2,0,0) ON CONFLICT(team_id,entity,entity_key) DO UPDATE SET payload=EXCLUDED.payload",
    [teamId, canonical(state)],
  );
}
async function withGitHubDeadline(database, teamId, work) {
  try {
    return await work();
  } catch (error) {
    if (Number.isFinite(error.retryAt) && error.retryAt > Date.now())
      await database.withTeamTransaction(teamId, async (tx) => {
        const state = await schedulingState(tx, teamId);
        await saveSchedulingState(tx, teamId, {
          ...state,
          nextAt: Math.max(Number(state.nextAt || 0), error.retryAt),
          publishAfter: Math.max(
            Number(state.publishAfter || 0),
            error.retryAt,
          ),
        });
      });
    throw error;
  }
}
async function publishWindow(tx, env, profile) {
  const link = await tx.sync.readLink();
  if (link?.mode !== "active" || link.installation_id !== env.INSTALLATION_ID)
    return { mode: link?.mode || "unlinked" };
  const pending = (
    await tx.query(
      "SELECT created_at FROM sync_outbox WHERE team_id=$1 AND status<>'acknowledged' ORDER BY local_seq LIMIT 1",
      [profile.teamId],
    )
  ).rows[0];
  if (!pending) return { pending: false };
  const state = await schedulingState(tx, profile.teamId);
  return {
    state,
    // The first durable outbox row starts a fixed window. Later writes cannot
    // postpone it indefinitely. The claimed cooldown survives isolate loss.
    deadline: Math.max(
      Date.parse(pending.created_at) + PUBLISH_DELAY_MS,
      Number(state.publishAfter || 0),
    ),
  };
}
export function createPublisher({
  now = () => Date.now(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const running = new WeakMap();
  return function schedulePublish(env, profile) {
    let teams = running.get(env);
    if (!teams) running.set(env, (teams = new Map()));
    const key = `${profile.teamId}/${profile.profileId}`;
    if (teams.has(key)) return teams.get(key);
    const promise = (async () => {
      const database = syncDatabase(env, profile);
      const window = await database.withTeamTransaction(
        profile.teamId,
        (tx) => publishWindow(tx, env, profile),
        { readOnly: true },
      );
      if (window.deadline === undefined) return window;
      if (window.deadline > now())
        await wait(Math.min(window.deadline - now(), PUBLISH_INTERVAL_MS));
      const claim = await database.withTeamTransaction(
        profile.teamId,
        async (tx) => {
          const current = await publishWindow(tx, env, profile);
          if (current.deadline === undefined) return current;
          if (current.deadline > now()) return { throttled: true };
          // Advance before network I/O, including errors or a busy sync lease.
          // The team transaction serializes competing isolate timer callbacks.
          await saveSchedulingState(tx, profile.teamId, {
            ...current.state,
            publishAfter: now() + PUBLISH_INTERVAL_MS,
          });
          return null;
        },
      );
      if (claim) return claim;
      return runTeam(env, profile, { updateStatus: false });
    })().finally(() => teams.delete(key));
    teams.set(key, promise);
    return promise;
  };
}
// Timers are an optimization, never the delivery guarantee. Cron recovers every
// durable pending row after the persisted deadline; explicit runs bypass debounce.
export const schedulePublish = createPublisher();

export function serviceFor(env, profile, link, options = {}) {
  const limits = capacityLimits(env),
    database = syncDatabase(env, profile),
    transport = boundedTransport(
      options.transport ||
        new GitHubApiTransport({
          repository: profile.repository,
          token: env[profile.githubSecret],
          maxBlobBytes: SYNC_SNAPSHOT_MAX_BYTES,
        }),
      limits,
    ),
    images = new R2ImageStore(env[profile.bucketBinding], profile.teamId),
    adapter = imageSync(database, profile, images);
  const service = new SyncService({
    stateLimits: limits,
    snapshotDecoder: (bytes) => decodeBoundedSnapshot(bytes, limits),
    transport,
    store: boundStore(database, profile.teamId, { ...options, limits }),
    identity: {
      teamId: profile.teamId,
      repoId: link.repo_id,
      ...(env.PEER_INSTALLATION_ID
        ? { peerInstallationId: env.PEER_INSTALLATION_ID }
        : {}),
    },
    // The service checks each state's capacity before handing it over.
    images: adapter,
    maxCommits: options.maxCommits || 4,
    maxOperations: 50,
    deferImages: !!options.deferImages,
    // SYNC_PHASE_LOG=1 logs each phase of a publishing or receiving cycle,
    // to find which one exceeds the hosted runtime's per-invocation CPU limit.
    trace:
      env.SYNC_PHASE_LOG === "1"
        ? (entry) => console.log("GraeBoard sync phase", JSON.stringify(entry))
        : null,
  });
  return {
    run: (options) => exclusiveSync(() => service.run(options)),
    checkpoint: () => exclusiveSync(() => service.checkpoint()),
    upgrade: (options) => exclusiveSync(() => service.upgrade(options)),
  };
}
// A persisted per-team deadline coalesces browser focus, polling and pre-edit
// refreshes across isolates. It is advanced before network I/O, including errors.
// Foreground checks never read/publish status branches or load C for an equal head.
export async function refreshTeam(env, profile, { now = Date.now() } = {}) {
  await refreshDirectory(env).catch(() => {});
  const database = syncDatabase(env, profile);
  const snapshot = await database.withTeamTransaction(
    profile.teamId,
    async (tx) => ({
      link: await tx.sync.readLink(),
      refresh: (
        await tx.query(
          "SELECT payload FROM site_entities WHERE team_id=$1 AND entity='syncRefresh' AND entity_key='[]'",
          [profile.teamId],
        )
      ).rows[0],
    }),
    { readOnly: true },
  );
  const eligible = (link) =>
    link?.mode === "active" &&
    link.installation_id === env.INSTALLATION_ID &&
    (!link.lease_owner || Number(link.lease_until) < now);
  if (!eligible(snapshot.link))
    return { mode: snapshot.link?.mode || "unlinked" };
  if (Number(JSON.parse(snapshot.refresh?.payload || "{}").nextAt || 0) > now)
    return { throttled: true };
  const link = await database.withTeamTransaction(
    profile.teamId,
    async (tx) => {
      const current = await tx.sync.readLink();
      if (!eligible(current)) return null;
      const state = await schedulingState(tx, profile.teamId);
      if (Number(state.nextAt || 0) > now) return null;
      await saveSchedulingState(tx, profile.teamId, {
        ...state,
        nextAt: now + 30000,
      });
      return current;
    },
  );
  if (!link) return { throttled: true };
  const transport = new GitHubApiTransport({
    repository: profile.repository,
    token: env[profile.githubSecret],
    maxBlobBytes: SYNC_SNAPSHOT_MAX_BYTES,
  });
  return withGitHubDeadline(database, profile.teamId, async () => {
    const head = await transport.readHead();
    if (head === link.canonical_head) return { changed: false, head };
    return serviceFor(env, profile, link, { transport }).run({
      receiveOnly: true,
      updateStatus: false,
      observedHead: head,
    });
  });
}
export async function runTeam(
  env,
  profile,
  {
    receiveOnly = false,
    updateStatus = true,
    respectPublishWindow = false,
    // An operator-side import may supply a transport with a larger GitHub
    // request budget than one hosted invocation can spend, and may install
    // images in a later pass instead of before the state commit.
    transport = null,
    deferImages = false,
    maxCommits = 0,
    leaseMs = 0,
    // A hosted invocation cannot afford a whole-team re-compare per commit.
    incrementalMaterialize = true,
    // Nor loading and hashing the whole team (see boundStore reduceSlice).
    slices = true,
  } = {},
) {
  const db = syncDatabase(env, profile),
    link = await db.readLink(profile.teamId);
  if (!link) return { mode: "unlinked" };
  if (respectPublishWindow) {
    const state = await db.withTeamTransaction(
      profile.teamId,
      (tx) => schedulingState(tx, profile.teamId),
      { readOnly: true },
    );
    if (Number(state.publishAfter || 0) > Date.now())
      return { throttled: true };
  }
  if (!updateStatus && !["active", "importing"].includes(link.mode))
    return { mode: link.mode };
  if (!env.INSTALLATION_ID || link.installation_id !== env.INSTALLATION_ID) {
    await db.withTeamTransaction(profile.teamId, (tx) =>
      tx.query(
        "UPDATE team_sync_links SET mode='recovery',last_error='Installation identity changed; recovery review required' WHERE team_id=$1",
        [profile.teamId],
      ),
    );
    return { mode: "recovery" };
  }
  const result = await withGitHubDeadline(db, profile.teamId, () =>
    serviceFor(env, profile, link, {
      ...(transport ? { transport } : {}),
      ...(maxCommits ? { maxCommits } : {}),
      ...(leaseMs ? { leaseMs } : {}),
      incrementalMaterialize,
      slices,
      deferImages,
    }).run({
      receiveOnly,
      updateStatus,
    }),
  );
  const latest = await db.readLink(profile.teamId);
  if (latest.mode === "active") {
    const transport = new GitHubApiTransport({
      repository: profile.repository,
      token: env[profile.githubSecret],
    });
    const importing = await controlTransaction(
      env,
      async (tx) =>
        (
          await tx.query(
            "SELECT 1 FROM teams WHERE id=$1 AND status='importing'",
            [profile.teamId],
          )
        ).rows.length,
    );
    if (importing && latest.canonical_head === (await transport.readHead())) {
      const state = await db.readState(profile.teamId);
      await controlTransaction(
        env,
        (tx) =>
          tx.query(
            "UPDATE teams SET status='active',name=$2 WHERE id=$1 AND status='importing'",
            [
              profile.teamId,
              state.entities[entityId("team", [])]?.payload.name ||
                profile.name,
            ],
          ),
        { write: true },
      );
    }
  }
  return result;
}
export async function scheduled(env) {
  try {
    await refreshDirectory(env, { force: true });
  } catch (error) {
    console.error(
      "GraeBoard team directory synchronization failed",
      error.status || "directory",
    );
  }
  const teams = await controlTransaction(
    env,
    async (tx) =>
      (
        await tx.query(
          "SELECT * FROM teams WHERE status IN ('active','importing')",
        )
      ).rows,
  );
  for (const team of teams) {
    try {
      await runTeam(env, profileFor(env, team.profile_id, team.id), {
        respectPublishWindow: true,
      });
    } catch (error) {
      console.error(
        "GraeBoard scheduled synchronization failed",
        team.id,
        error.status || "sync",
      );
    }
  }
}
export async function importTeam(ctx, body) {
  ctx.admin();
  assert(
    /^[a-f0-9-]{36}$/i.test(ctx.env.INSTALLATION_ID || ""),
    503,
    "외부 사이트 INSTALLATION_ID를 먼저 설정하세요.",
  );
  const profile = profileFor(ctx.env, body.profileId, body.teamId),
    db = syncDatabase(ctx.env, profile);
  await db.health();
  const transport = new GitHubApiTransport({
    repository: profile.repository,
    token: ctx.env[profile.githubSecret],
  });
  await transport.check();
  const head = await transport.readHead();
  assert(head, 409, "내부 사이트에서 최초 게시를 완료하세요.");
  const bytes = await transport.readFile(head, "manifest.json");
  assert(bytes, 400, "동기화 저장소가 아닙니다.");
  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  assert(
    manifest.teamId === profile.teamId &&
      manifest.protocol === 1 &&
      manifest.reducer === 1,
    400,
    "저장소의 팀 또는 형식이 다릅니다.",
  );
  const existing = await controlTransaction(
    ctx.env,
    async (tx) =>
      (await tx.query("SELECT * FROM teams WHERE id=$1", [profile.teamId]))
        .rows[0],
  );
  assert(
    !existing ||
      (["unconnected", "importing"].includes(existing.status) &&
        (!existing.profile_id || existing.profile_id === profile.profileId)),
    409,
    "이미 자료가 있는 팀은 덮어쓸 수 없습니다.",
  );
  await db.withTeamTransaction(profile.teamId, async (tx) => {
    const link = await tx.sync.readLink();
    if (link) {
      assert(
        link.repo_id === manifest.repoId &&
          ["importing", "active"].includes(link.mode) &&
          existing?.status === "importing",
        409,
        "기존 연결을 덮어쓸 수 없습니다.",
      );
      return;
    }
    assert(
      !(
        await tx.query("SELECT 1 FROM site_entities WHERE team_id=$1 LIMIT 1", [
          profile.teamId,
        ])
      ).rows.length,
      409,
      "비어 있는 팀 업무 DB에만 가져올 수 있습니다.",
    );
    await tx.sync.writeLink({
      repo_id: manifest.repoId,
      bootstrap_id: manifest.bootstrapId,
      installation_id: ctx.env.INSTALLATION_ID,
      writer_epoch: crypto.randomUUID(),
      profile_id: profile.profileId,
      mode: "importing",
      updated_at: new Date().toISOString(),
    });
  });
  await controlTransaction(
    ctx.env,
    async (tx) => {
      await tx.query(
        "INSERT INTO teams(id,name,profile_id,status) VALUES($1,$2,$3,'importing') ON CONFLICT(id) DO UPDATE SET profile_id=EXCLUDED.profile_id,status='importing'",
        [profile.teamId, body.name || profile.name, profile.profileId],
      );
    },
    { write: true },
  );
  await runTeam(ctx.env, profile, {
    receiveOnly: true,
    transport: ctx.transport || null,
    deferImages: !!ctx.deferImages,
    maxCommits: ctx.maxCommits || 0,
    leaseMs: ctx.leaseMs || 0,
    incrementalMaterialize: !!ctx.incrementalMaterialize,
    slices: ctx.slices !== false,
  });
  const link = await db.readLink(profile.teamId),
    caughtUp = link.canonical_head === (await transport.readHead());
  if (caughtUp)
    await controlTransaction(
      ctx.env,
      async (tx) => {
        const state = await db.readState(profile.teamId);
        await tx.query("UPDATE teams SET name=$2,status='active' WHERE id=$1", [
          profile.teamId,
          state.entities[entityId("team", [])]?.payload.name || profile.name,
        ]);
      },
      { write: true },
    );
  return {
    teamId: profile.teamId,
    jobId: profile.teamId,
    phase: caughtUp ? "complete" : "importing",
    head: link.canonical_head,
  };
}
