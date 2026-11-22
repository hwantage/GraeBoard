import { GitHubApiTransport } from "../../server/sync/core/github-api.mjs";
import { canonical } from "../../server/sync/core/protocol.mjs";
import { syncSlideFiles } from "../../server/sync/core/slide-file-branch.mjs";
import { PostgresSlideFileRepository } from "../storage/slides/postgres-slide-files.mjs";
import { databaseFor } from "../storage/data.mjs";

// One pass of slide file synchronization for the external site. A pass moves
// at most a few chunks, so a large file is carried by several passes (the
// gateway's one-minute Cron). It reads the
// task link only to see that synchronization is active. The one thing it
// shares with task synchronization is the GitHub rate-limit deadline.
export const EXTERNAL_SLIDE_SYNC_LIMITS = Object.freeze({
  chunks: 4,
  files: 10,
});

export async function syncTeamSlides(
  env,
  profile,
  { transport, limits = EXTERNAL_SLIDE_SYNC_LIMITS } = {},
) {
  const database = databaseFor(env, profile);
  const link = await database.readLink(profile.teamId);
  // Not while task synchronization is paused or recovering, and not while
  // another executor holds its lease (a run, maintenance or an upgrade).
  if (
    link?.mode !== "active" ||
    (link.lease_owner && Number(link.lease_until) > Date.now())
  )
    return null;
  // The GitHub budget is shared with task synchronization: while it waits out
  // a rate limit, slides wait too, and a limit met here is recorded in the
  // same place so every executor honours it.
  if ((await githubCooldown(database, profile.teamId)) > Date.now())
    return null;
  const store = new PostgresSlideFileRepository({
    pool: database.pool,
    bucket: env[profile.bucketBinding],
    teamId: profile.teamId,
  });
  try {
    return await syncSlideFiles({
      transport:
        transport ||
        new GitHubApiTransport({
          repository: profile.repository,
          token: env[profile.githubSecret],
        }),
      store,
      teamId: profile.teamId,
      site: "external",
      limits,
      warn: (...args) => console.error(...args),
    });
  } catch (error) {
    // A site whose slide store is not migrated yet simply has no slides.
    if (error.status === 503 && !Number.isFinite(error.retryAt)) return null;
    if (Number.isFinite(error.retryAt) && error.retryAt > Date.now())
      await database.withTeamTransaction(profile.teamId, async (tx) => {
        const state = await schedulingState(tx, profile.teamId);
        await tx.query(
          "INSERT INTO site_entities(team_id,entity,entity_key,payload,revision,deleted) VALUES($1,'syncRefresh','[]',$2,0,0) ON CONFLICT(team_id,entity,entity_key) DO UPDATE SET payload=EXCLUDED.payload",
          [
            profile.teamId,
            canonical({
              ...state,
              nextAt: Math.max(Number(state.nextAt || 0), error.retryAt),
              publishAfter: Math.max(
                Number(state.publishAfter || 0),
                error.retryAt,
              ),
            }),
          ],
        );
      });
    throw error;
  }
}

// Task synchronization keeps its GitHub deadlines in this row (see sync.mjs):
// a refresh sets `nextAt` 30 seconds ahead and a publication `publishAfter`
// 5 seconds ahead. A deadline further away than that is a rate limit.
const REFRESH_WINDOW_MS = 30000;
const PUBLISH_WINDOW_MS = 5000;
async function schedulingState(tx, teamId) {
  const row = (
    await tx.query(
      "SELECT payload FROM site_entities WHERE team_id=$1 AND entity='syncRefresh' AND entity_key='[]'",
      [teamId],
    )
  ).rows[0];
  return JSON.parse(row?.payload || "{}");
}
async function githubCooldown(database, teamId) {
  const state = await database.withTeamTransaction(
    teamId,
    (tx) => schedulingState(tx, teamId),
    { readOnly: true },
  );
  const now = Date.now();
  const nextAt = Number(state.nextAt || 0);
  const publishAfter = Number(state.publishAfter || 0);
  return Math.max(
    nextAt - now > REFRESH_WINDOW_MS ? nextAt : 0,
    publishAfter - now > PUBLISH_WINDOW_MS ? publishAfter : 0,
  );
}
