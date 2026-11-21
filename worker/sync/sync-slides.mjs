import { GitHubApiTransport } from "../../server/sync/core/github-api.mjs";
import { syncSlideFiles } from "../../server/sync/core/slide-file-branch.mjs";
import { PostgresSlideFileRepository } from "../storage/slides/postgres-slide-files.mjs";
import { databaseFor } from "../storage/data.mjs";

// One pass of slide file synchronization for the external site. A pass moves
// at most a few chunks, so a large file is carried by several passes (the
// gateway's Cron and the passes started after slide changes). It reads the
// task link only to see that synchronization is active; it never writes
// task synchronization state.
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
  if (link?.mode !== "active") return null;
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
    if (error.status === 503) return null;
    throw error;
  }
}
