import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  SLIDE_SCHEMA,
  SLIDE_SCHEMA_VERSION,
  slideSchemaReady,
} from "../../shared/slides/slide-store-version.js";

const sql = readFileSync(
  new URL("./postgres/slides/001-slide-files.sql", import.meta.url),
  "utf8",
);
export const slideSchemaMigration = {
  version: SLIDE_SCHEMA_VERSION,
  sql,
  checksum: createHash("sha256").update(sql).digest("hex"),
};

// Creates the slide store schema in a team database. It never touches the
// graeboard schema or its migration history. An existing schema must already
// have exactly this history; anything else is refused with its data kept.
export async function migrateSlideSchema(pool, { dryRun = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('graeboard-slides-migration',0))",
    );
    const exists = (
      await client.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [
        SLIDE_SCHEMA,
      ])
    ).rowCount;
    if (exists) {
      const history = (
        await client.query(
          `SELECT to_regclass('${SLIDE_SCHEMA}.schema_migrations') AS name`,
        )
      ).rows[0].name;
      const rows = history
        ? (
            await client.query(
              `SELECT version,checksum FROM ${SLIDE_SCHEMA}.schema_migrations ORDER BY version`,
            )
          ).rows
        : [];
      if (!slideSchemaReady(rows))
        throw new Error(
          "Unsupported graeboard_slides schema or migration history; data preserved",
        );
      await client.query("ROLLBACK");
      return {
        from: SLIDE_SCHEMA_VERSION,
        to: SLIDE_SCHEMA_VERSION,
        applied: false,
      };
    }
    if (dryRun) {
      await client.query("ROLLBACK");
      return {
        from: 0,
        to: SLIDE_SCHEMA_VERSION,
        applied: false,
        dryRun: true,
        checksum: slideSchemaMigration.checksum,
      };
    }
    await client.query(sql);
    await client.query(
      `INSERT INTO ${SLIDE_SCHEMA}.schema_migrations VALUES($1,$2,$3)`,
      [
        SLIDE_SCHEMA_VERSION,
        slideSchemaMigration.checksum,
        new Date().toISOString(),
      ],
    );
    await client.query("COMMIT");
    return {
      from: 0,
      to: SLIDE_SCHEMA_VERSION,
      applied: true,
      checksum: slideSchemaMigration.checksum,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
