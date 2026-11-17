import test from "node:test";
import assert from "node:assert/strict";
import {
  REQUIRED_SETTINGS,
  externalEnvironment,
  importExternalTeam,
  main,
} from "../../../scripts/sync/sync-external-import.mjs";

const settings = {
  GRAEBOARD_DATABASE_URL: "postgres://user:secret@127.0.0.1:1/graeboard",
  SITE_TEAM_ID: "15eb7227-b0c4-4489-b989-e587a813d3c4",
  INSTALLATION_ID: "2a09e7a4-dafa-47df-8693-f79f39a917e7",
  PEER_INSTALLATION_ID: "b5a6da47-7f84-4059-814b-ca2fc7b80d66",
  SYNC_PROFILES: JSON.stringify([
    {
      profileId: "ux-team-internal",
      teamId: "15eb7227-b0c4-4489-b989-e587a813d3c4",
      repository: "example/data",
      databaseBinding: "PG_SITE",
      bucketBinding: "R2_TEAM",
      githubSecret: "GIT_TEAM",
    },
  ]),
  GIT_TEAM: "fixture_token",
  RESOURCE_ORIGIN: "https://gateway.example.workers.dev",
  GRAEBOARD_RESOURCE_SECRET: "resource-secret",
};

test("protocol upgrade needs no image gateway credentials, while imports still do", async () => {
  const withoutImages = {
    ...settings,
    RESOURCE_ORIGIN: "",
    GRAEBOARD_RESOURCE_SECRET: "",
  };
  const { env, close } = await externalEnvironment(withoutImages, {
    withImages: false,
  });
  try {
    assert.ok(env.PG_SITE.pool.connect);
    assert.equal(env.R2_TEAM, undefined);
    assert.equal(env.IMAGES, undefined);
  } finally {
    await close();
  }
  await assert.rejects(externalEnvironment(withoutImages), /RESOURCE_ORIGIN/);
  await assert.rejects(
    externalEnvironment(
      { ...withoutImages, GIT_TEAM: "" },
      { withImages: false },
    ),
    /GIT_TEAM/,
  );
});

test("external import CLI builds the Edge-equivalent environment and refuses incomplete settings", async () => {
  for (const key of REQUIRED_SETTINGS)
    await assert.rejects(
      externalEnvironment({ ...settings, [key]: "" }),
      new RegExp(key),
    );
  const { env, close } = await externalEnvironment(settings);
  assert.equal(env.GRAEBOARD_SITE, "external");
  assert.match(
    env.PG_SITE.connectionString,
    /^postgres:\/\/user:secret@127\.0\.0\.1:1\//,
  );
  assert.ok(env.PG_SITE.pool?.connect && env.R2_TEAM && env.IMAGES);
  await close();
  await assert.rejects(
    externalEnvironment({ ...settings, RESOURCE_ORIGIN: "http://x" }),
    /Invalid resource origin/,
  );
});

test("external import CLI stops before any write when the database is unreachable", async () => {
  await assert.rejects(
    importExternalTeam(settings, { dryRun: true, log: () => {} }),
    (error) =>
      error.status === 503 || /ECONNREFUSED|connect/i.test(error.message),
  );
});

test("external import CLI fills missing settings from the environment without touching the file", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } =
    await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "graeboard-external-import-"));
  const file = join(dir, "settings.env");
  const text = Object.entries({ ...settings, GIT_TEAM: "" })
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(file, text);
  const saved = process.env.GIT_TEAM;
  process.env.GIT_TEAM = "env_token";
  try {
    await assert.rejects(
      main(["--settings", file, "--dry-run"]),
      (error) => !/GIT_TEAM/.test(error.message),
    );
    assert.equal(readFileSync(file, "utf8"), text);
  } finally {
    if (saved === undefined) delete process.env.GIT_TEAM;
    else process.env.GIT_TEAM = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("external import CLI prints usage without a settings file", async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    await main(["--help"]);
  } finally {
    console.log = original;
  }
  assert.match(lines.join("\n"), /--settings .* \[--dry-run\]/);
});

test("upgrade CLI rejects mixed modes and orphaned execution flags before opening settings", async () => {
  for (const flags of [
    ["--execute"],
    ["--expected-head", "a".repeat(40)],
    ["--upgrade", "--images"],
    ["--upgrade", "--catch-up"],
    ["--upgrade", "--execute", "--dry-run"],
    ["--upgrade", "--publish"],
  ])
    await assert.rejects(
      main(["--settings", "/does-not-exist", ...flags]),
      /지정|함께/,
    );
});
