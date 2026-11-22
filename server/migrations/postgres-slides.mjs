import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  SLIDE_SCHEMA,
  SLIDE_SCHEMA_VERSION,
  slideSchemaVersion,
} from "../../shared/slides/slide-store-version.js";

export const slideSchemaMigrations = [
  "001-slide-files.sql",
  "002-slide-sync.sql",
].map((name, index) => {
  const sql = readFileSync(
    new URL(`./postgres/slides/${name}`, import.meta.url),
    "utf8",
  );
  return {
    version: index + 1,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex"),
  };
});

// Creates or upgrades the slide store schema in a team database. It never
// touches the graeboard schema or its migration history. An existing schema
// must have a history this code knows; anything else is refused with its data
// kept. Every step and its history row commit together.
export async function migrateSlideSchema(pool, { dryRun = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('graeboard-slides-migration',0))",
    );
    let from = 0;
    if (
      (
        await client.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [
          SLIDE_SCHEMA,
        ])
      ).rowCount
    ) {
      const history = (
        await client.query(
          `SELECT to_regclass('${SLIDE_SCHEMA}.schema_migrations') AS name`,
        )
      ).rows[0].name;
      from = history
        ? slideSchemaVersion(
            (
              await client.query(
                `SELECT version,checksum FROM ${SLIDE_SCHEMA}.schema_migrations ORDER BY version`,
              )
            ).rows,
          )
        : 0;
      if (!from)
        throw new Error(
          "Unsupported graeboard_slides schema or migration history; data preserved",
        );
    }
    const steps = slideSchemaMigrations.filter((step) => step.version > from);
    if (!steps.length || dryRun) {
      await client.query("ROLLBACK");
      return {
        from,
        to: SLIDE_SCHEMA_VERSION,
        applied: false,
        ...(steps.length
          ? { dryRun: true, checksums: steps.map((step) => step.checksum) }
          : {}),
      };
    }
    for (const step of steps) {
      await client.query(step.sql);
      await client.query(
        `INSERT INTO ${SLIDE_SCHEMA}.schema_migrations VALUES($1,$2,$3)`,
        [step.version, step.checksum, new Date().toISOString()],
      );
    }
    await client.query("COMMIT");
    return { from, to: SLIDE_SCHEMA_VERSION, applied: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
