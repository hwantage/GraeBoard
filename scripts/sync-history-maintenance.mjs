import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { SqliteDatabase } from "../server/storage/sqlite.mjs";
import { PostgresDatabase } from "../worker/storage/postgres.mjs";
import { localHistoryMaintenance } from "../shared/local-history-maintenance.mjs";

export async function main() {
  const { values } = parseArgs({
    options: {
      engine: { type: "string", default: "sqlite" },
      database: { type: "string" },
      "url-env": { type: "string" },
      "team-id": { type: "string" },
      "as-of": { type: "string" },
      apply: { type: "boolean", default: false },
      token: { type: "string" },
    },
    strict: true,
  });
  if (
    !values["team-id"] ||
    !values["as-of"] ||
    !["sqlite", "postgres"].includes(values.engine)
  )
    throw new Error(
      "--engine sqlite|postgres --team-id UUID --as-of ISO is required; preview is the default. Execute one reviewed batch with --apply --token TOKEN.",
    );
  let db, pool, adapter;
  try {
    if (values.engine === "sqlite") {
      if (!isAbsolute(values.database || "") || !existsSync(values.database))
        throw new Error("An existing absolute --database path is required");
      db = new DatabaseSync(values.database, { readOnly: !values.apply });
      db.exec("PRAGMA foreign_keys=ON");
      adapter = new SqliteDatabase(db);
    } else {
      const connectionString = process.env[values["url-env"] || ""];
      if (!connectionString)
        throw new Error(
          "Set a server-side database URL environment variable and select it with --url-env NAME",
        );
      pool = new Pool({ connectionString });
      adapter = new PostgresDatabase(pool, { teamId: values["team-id"] });
    }
    await adapter.health();
    const result = await localHistoryMaintenance(adapter, values["team-id"], {
      asOf: values["as-of"],
      apply: values.apply,
      token: values.token,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db?.close();
    await pool?.end();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
