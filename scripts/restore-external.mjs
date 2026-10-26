import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { externalResources } from "./external-backup-options.mjs";
import { restoreExternal } from "../server/storage/external-backup.mjs";

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      input: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "npm run restore:external -- --config /private/new-resources.json --input /private/backup-directory [--dry-run]",
    );
    return;
  }
  if (!values.input) throw new Error("--input is required");
  const resources = await externalResources(values.config, { restore: true });
  try {
    console.log(
      JSON.stringify(
        await restoreExternal({
          ...resources,
          source: values.input,
          dryRun: values["dry-run"],
        }),
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
      error.code
        ? "External restore failed (" + error.code + ")"
        : error.message,
    );
    process.exitCode = 1;
  });
