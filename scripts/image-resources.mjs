import { readFileSync } from "node:fs";
import { S3ImageStore } from "../server/storage/external-backup.mjs";
import { GitCliTransport } from "../server/sync/git-cli.mjs";

export function assetResources(file, teamId) {
  const config = JSON.parse(readFileSync(file, "utf8")),
    entry = config.teams?.find((value) => value.teamId === teamId);
  if (!entry) throw new Error("Team image resource configuration is missing");
  const endpoint = new URL(entry.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
    throw new Error("R2 endpoint must be HTTPS without embedded credentials");
  for (const name of ["accessKeyEnv", "secretKeyEnv"])
    if (!entry[name] || !process.env[entry[name]])
      throw new Error("Set the named R2 credential environment variables");
  const images = new S3ImageStore({
    endpoint: entry.endpoint,
    bucket: entry.bucket,
    teamId,
    accessKeyId: process.env[entry.accessKeyEnv],
    secretAccessKey: process.env[entry.secretKeyEnv],
  });
  const git =
    entry.repository && entry.gitDirectory
      ? new GitCliTransport({
          directory: entry.gitDirectory,
          repository: entry.repository,
          token: process.env[entry.githubTokenEnv],
        })
      : null;
  return { images, git, close: () => images.close() };
}
