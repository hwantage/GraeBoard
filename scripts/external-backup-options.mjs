import { readFileSync } from "node:fs";
import { openTransferDatabase } from "./transfer.mjs";
import { S3ImageStore } from "../server/storage/external-backup.mjs";
import { GitCliTransport } from "../server/sync/git-cli.mjs";

export async function externalResources(file, { restore = false } = {}) {
  if (!file) throw new Error("--config is required");
  const config = JSON.parse(readFileSync(file, "utf8")),
    opened = [],
    stores = [];
  if (config.site) {
    if (config.control || config.teams)
      throw new Error(
        "Use site or legacy control/teams configuration, not both",
      );
    config.control = { urlEnv: config.site.urlEnv, site: true };
    config.teams = [config.site];
  }
  try {
    let control;
    if (config.control) {
      const resource = await openTransferDatabase({
        engine: "postgres",
        urlEnv: config.control.urlEnv,
        scope: "control",
        site: !!config.control.site,
      });
      opened.push(resource);
      control = resource.adapter;
    }
    const teams = [],
      seen = new Set();
    for (const entry of config.teams || []) {
      if (!/^[a-zA-Z0-9-]+$/.test(entry.teamId) || seen.has(entry.teamId))
        throw new Error("Invalid or duplicate backup team");
      seen.add(entry.teamId);
      const endpoint = new URL(entry.endpoint);
      if (
        endpoint.protocol !== "https:" ||
        endpoint.username ||
        endpoint.password
      )
        throw new Error(
          "R2 endpoint must be HTTPS without embedded credentials",
        );
      for (const name of ["accessKeyEnv", "secretKeyEnv"])
        if (!entry[name] || !process.env[entry[name]])
          throw new Error("Set the named R2 credential environment variables");
      const resource = await openTransferDatabase({
        engine: "postgres",
        urlEnv: entry.urlEnv,
      });
      opened.push(resource);
      const images = new S3ImageStore({
        endpoint: entry.endpoint,
        bucket: entry.bucket,
        teamId: entry.teamId,
        accessKeyId: process.env[entry.accessKeyEnv],
        secretAccessKey: process.env[entry.secretKeyEnv],
      });
      stores.push(images);
      let git;
      if (!restore && entry.repository) {
        if (!entry.gitDirectory)
          throw new Error(
            "Set gitDirectory for fixed-head archive image recovery",
          );
        git = new GitCliTransport({
          directory: entry.gitDirectory,
          repository: entry.repository,
          token: process.env[entry.githubTokenEnv],
        });
        await git.readHead();
      }
      teams.push({ ...entry, adapter: resource.adapter, images, git });
    }
    if (!control && !teams.length)
      throw new Error("Backup configuration has no control or team database");
    return {
      control,
      teams,
      close: async () => {
        for (const store of stores) store.close();
        await Promise.all(opened.map((resource) => resource.close()));
      },
    };
  } catch (error) {
    for (const store of stores) store.close();
    await Promise.all(opened.map((resource) => resource.close()));
    throw error;
  }
}
