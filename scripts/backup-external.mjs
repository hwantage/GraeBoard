import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { externalResources } from "./external-backup-options.mjs";
import { backupExternal } from "../server/storage/external-backup.mjs";

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      output: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "npm run backup:external -- --config /private/resources.json --output /private/backup-directory [--dry-run]",
    );
    return;
  }
  if (!values.output && !values["dry-run"])
    throw new Error("--output is required");
  const resources = await externalResources(values.config);
  try {
    console.log(
      JSON.stringify(
        values["dry-run"]
          ? {
              dryRun: true,
              databasesReady: true,
              teams: resources.teams.map((team) => team.teamId),
            }
          : await backupExternal({ ...resources, destination: values.output }),
      ),
    );
  } finally {
    await resources.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(
      error.code && error.code !== "ACTIVE_MAINTENANCE_JOB"
        ? "External backup failed (" + error.code + ")"
        : error.message,
    );
    process.exitCode = 1;
  });
