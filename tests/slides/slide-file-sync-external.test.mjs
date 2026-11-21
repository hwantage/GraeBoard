import { join } from "node:path";
import { postgresBusinessFixture } from "../support/business-storage-fixture.mjs";
import { githubEmulator } from "../support/worker-github-fixture.mjs";
import { slideSyncContract } from "../support/slide-sync-fixture.mjs";
import { migrateSlideSchema } from "../../server/migrations/postgres-slides.mjs";
import { GitHubApiTransport } from "../../server/sync/core/github-api.mjs";
import { SqliteSlideFileRepository } from "../../server/storage/slides/sqlite-slide-files.mjs";
import { PostgresSlideFileRepository } from "../../worker/storage/slides/postgres-slide-files.mjs";

// An R2 bucket binding kept in memory.
function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    put: async (key, bytes) => void objects.set(key, Uint8Array.from(bytes)),
    get: async (key) => {
      const bytes = objects.get(key);
      return (
        bytes && { arrayBuffer: async () => Uint8Array.from(bytes).buffer }
      );
    },
    head: async (key) => (objects.has(key) ? { key } : null),
    delete: async (key) => void objects.delete(key),
  };
}

// The two real sites: the internal one keeps slides in SQLite and files and
// reaches the repository with the Git CLI; the external one keeps them in
// PostgreSQL and a bucket and reaches the same repository through the GitHub
// Git Data API (served here from that repository by the emulator).
slideSyncContract(
  "사내 SQLite와 외부 PostgreSQL",
  async (t, directory, remote) => {
    const pg = await postgresBusinessFixture(t);
    if (!pg) return null;
    await migrateSlideSchema(pg.pool);
    const internal = new SqliteSlideFileRepository({
      directory: join(directory, "internal-store"),
    });
    t.after(() => internal.close());
    const github = githubEmulator(remote);
    return {
      teamId: pg.teamId,
      internal,
      external: new PostgresSlideFileRepository({
        pool: pg.pool,
        bucket: memoryBucket(),
        teamId: pg.teamId,
      }),
      transports: {
        external: new GitHubApiTransport({
          repository: "fixture/team",
          token: "fixture-secret",
          fetch: github.fetch,
        }),
      },
    };
  },
);
