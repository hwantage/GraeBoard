import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  deployTeamSite,
  hasSecret,
  readDeployConfig,
  workerOrigin,
} from "../scripts/team-site-deploy.mjs";
import { setupExamples } from "../shared/sync-setup.js";

const key = () => randomBytes(32).toString("base64");
function siteEnv() {
  const team = { id: randomUUID(), name: "팀 A" };
  const examples = setupExamples(
    team,
    {
      installationId: randomUUID(),
      profile: { profileId: "team-a", peerInstallationId: randomUUID() },
    },
    {
      repository: "https://github.com/example/data",
      appOrigin: "https://team.pages.dev",
      issuer: "https://company.cloudflareaccess.com",
      audience: "a".repeat(64),
      bucket: "team-images",
      gateway: "graeboard-team",
      projectRef: "b".repeat(20),
      accountId: "c".repeat(32),
    },
  );
  const keys = {
    GRAEBOARD_GATEWAY_SECRET: key(),
    GRAEBOARD_RESOURCE_SECRET: key(),
    GRAEBOARD_ACCESS_TOKEN_KEY: key(),
  };
  const secrets = {
    CLOUDFLARE_API_TOKEN: "cf-token",
    SUPABASE_ACCESS_TOKEN: "sb-token",
    GIT_TEAM: "github_pat_external",
    ...keys,
  };
  return {
    team,
    keys,
    secrets,
    env: {
      TEAM_SITE_CONFIG: examples.siteConfig,
      TEAM_SITE_SECRETS: JSON.stringify(secrets),
    },
  };
}
const edgeValues = (args) =>
  Object.fromEntries(
    args.slice(4).map((pair) => {
      const at = pair.indexOf("=");
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );

test("TEAM_SITE_CONFIG and TEAM_SITE_SECRETS deploy the API, then the gateway, then both sides' secrets", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { team, keys, env } = siteEnv();
  const calls = [];
  let bulk;
  const result = deployTeamSite(
    { ...env, RUNNER_TEMP: dir },
    {
      cwd: dir,
      run(command, args, options = {}) {
        calls.push({ command, args, env: options.env });
        if (args[1] === "secret") {
          bulk = JSON.parse(readFileSync(args[3], "utf8"));
          return "";
        }
        if (args[1] === "list") return "NAME | DIGEST\nSUPABASE_URL | x\n";
        return args[1] === "deploy" && command === "npx"
          ? "Deployed graeboard-team triggers\n  https://graeboard-team.somansadev.workers.dev\n"
          : "";
      },
    },
  );
  assert.deepEqual(result, {
    secrets: true,
    resourceOrigin: "https://graeboard-team.somansadev.workers.dev",
    keptAccessKey: false,
  });
  assert.deepEqual(
    calls.map(
      ({ command, args }) => `${command} ${args.slice(0, 3).join(" ")}`,
    ),
    [
      "supabase functions deploy graeboard",
      "npx wrangler deploy --config",
      "npx wrangler secret bulk",
      "supabase secrets list --project-ref",
      "supabase secrets set --project-ref",
    ],
  );
  assert.equal(calls[0].args.at(-2), "b".repeat(20));
  // The tokens inside TEAM_SITE_SECRETS reach the CLIs as their own variables.
  assert.deepEqual(calls[0].env, { SUPABASE_ACCESS_TOKEN: "sb-token" });
  assert.deepEqual(calls[1].env, {
    CLOUDFLARE_ACCOUNT_ID: "c".repeat(32),
    CLOUDFLARE_API_TOKEN: "cf-token",
  });
  const gateway = JSON.parse(
    readFileSync(join(dir, ".env.gateway.json"), "utf8"),
  );
  assert.equal(gateway.name, "graeboard-team");
  assert.equal(gateway.vars.SITE_TEAM_ID, team.id);
  assert.deepEqual(gateway.triggers.crons, ["* * * * *"]);
  // Only the two gateway keys go to the Worker, and the file is removed.
  assert.deepEqual(bulk, {
    GRAEBOARD_GATEWAY_SECRET: keys.GRAEBOARD_GATEWAY_SECRET,
    GRAEBOARD_RESOURCE_SECRET: keys.GRAEBOARD_RESOURCE_SECRET,
  });
  assert.equal(existsSync(calls[2].args[3]), false);
  const edge = edgeValues(calls[4].args);
  assert.equal(edge.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(edge.RESOURCE_ORIGIN, result.resourceOrigin);
  assert.equal(edge.SITE_TEAM_ID, team.id);
  assert.equal(edge.GRAEBOARD_SITE, "external");
  assert.equal(edge.GIT_TEAM, "github_pat_external");
  assert.equal(
    edge.GRAEBOARD_ACCESS_TOKEN_KEY,
    keys.GRAEBOARD_ACCESS_TOKEN_KEY,
  );
  assert.equal(JSON.parse(edge.SYNC_PROFILES)[0].teamId, team.id);
});

test("deploy configuration refuses missing or malformed values before any command", () => {
  const { env } = siteEnv();
  const refuse = (changes, pattern) =>
    assert.throws(
      () =>
        deployTeamSite(
          { ...env, ...changes },
          {
            run() {
              throw new Error("must not run");
            },
          },
        ),
      pattern,
    );
  const { secrets } = siteEnv();
  refuse({ TEAM_SITE_SECRETS: "" }, /TEAM_SITE_SECRETS/);
  refuse(
    { TEAM_SITE_SECRETS: "not json" },
    /TEAM_SITE_SECRETS가 JSON이 아닙니다/,
  );
  refuse(
    { TEAM_SITE_SECRETS: JSON.stringify({ ...secrets, GIT_TEAM: "" }) },
    /GIT_TEAM/,
  );
  refuse(
    {
      TEAM_SITE_SECRETS: JSON.stringify({
        ...secrets,
        GRAEBOARD_RESOURCE_SECRET: "short",
      }),
    },
    /GRAEBOARD_RESOURCE_SECRET/,
  );
  const config = JSON.parse(env.TEAM_SITE_CONFIG);
  refuse(
    {
      TEAM_SITE_CONFIG: JSON.stringify({ ...config, cloudflareAccountId: "x" }),
    },
    /Account ID/,
  );
  refuse(
    {
      TEAM_SITE_CONFIG: JSON.stringify({
        ...config,
        edge: { ...config.edge, ACCESS_AUDIENCE: "" },
      }),
    },
    /ACCESS_AUDIENCE/,
  );
  refuse({ TEAM_SITE_CONFIG: "" }, /TEAM_SITE_CONFIG/);
});

test("older forks keep deploying from their separate variables without touching secrets", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { env } = siteEnv();
  const gateway = JSON.parse(env.TEAM_SITE_CONFIG).gateway;
  const legacy = {
    CLOUDFLARE_API_TOKEN: "cf",
    CLOUDFLARE_ACCOUNT_ID: "c".repeat(32),
    SUPABASE_ACCESS_TOKEN: "sb",
    SUPABASE_PROJECT_REF: "b".repeat(20),
    GATEWAY_CONFIG: JSON.stringify(gateway),
  };
  assert.equal(readDeployConfig(legacy).keys, undefined);
  const calls = [];
  assert.deepEqual(
    deployTeamSite(legacy, {
      cwd: dir,
      run(command, args) {
        calls.push(`${command} ${args[0]} ${args[1]}`);
        return "";
      },
    }),
    { secrets: false },
  );
  assert.deepEqual(calls, ["supabase functions deploy", "npx wrangler deploy"]);
});

test("a regenerated bundle keeps the access token key the Edge already uses", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "graeboard-deploy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { env } = siteEnv();
  const calls = [];
  const result = deployTeamSite(
    { ...env, RUNNER_TEMP: dir },
    {
      cwd: dir,
      run(command, args) {
        calls.push(args);
        if (args[1] === "list")
          return "  NAME                       | DIGEST\n  GRAEBOARD_ACCESS_TOKEN_KEY | 9f2c\n";
        return args[1] === "deploy" && command === "npx"
          ? "https://graeboard-team.team.workers.dev"
          : "";
      },
    },
  );
  assert.equal(result.keptAccessKey, true);
  const edge = edgeValues(calls.at(-1));
  assert.equal(edge.GRAEBOARD_ACCESS_TOKEN_KEY, undefined);
  assert.ok(edge.GRAEBOARD_GATEWAY_SECRET);
  assert.equal(
    hasSecret(
      "GRAEBOARD_ACCESS_TOKEN_KEY_OLD | x",
      "GRAEBOARD_ACCESS_TOKEN_KEY",
    ),
    false,
  );
});

test("the workers.dev address belongs to the deployed Worker name", () => {
  const output =
    "Uploaded other\n  https://other.team.workers.dev\n  https://graeboard-team.Somansa-Dev.workers.dev\n";
  assert.equal(
    workerOrigin(output, "graeboard-team"),
    "https://graeboard-team.somansa-dev.workers.dev",
  );
  assert.equal(workerOrigin("no address", "graeboard-team"), "");
});

test("--check masks every token and key in GitHub Actions and reports missing values", () => {
  const { secrets, env } = siteEnv();
  const check = (extra) =>
    spawnSync(process.execPath, ["scripts/team-site-deploy.mjs", "--check"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...extra },
    });
  const ok = check({ ...env, GITHUB_ACTIONS: "true" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  for (const value of Object.values(secrets))
    assert.ok(ok.stdout.includes(`::add-mask::${value}`));
  const missing = check({});
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /::error::.*TEAM_SITE_CONFIG/);
});

// Configs written by earlier setup guides carry an empty Cron list, which left
// pending saves without the scheduler's retry; only "cron": false pauses it.
test("the deployment schedules the gateway Cron unless the config pauses it", (t) => {
  const deployed = (config) => {
    const dir = mkdtempSync(join(tmpdir(), "graeboard-deploy-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { env } = siteEnv(),
      site = JSON.parse(env.TEAM_SITE_CONFIG);
    deployTeamSite(
      {
        ...env,
        TEAM_SITE_CONFIG: JSON.stringify(config(site)),
        RUNNER_TEMP: dir,
      },
      {
        cwd: dir,
        run: (command, args) =>
          command === "npx" && args[1] === "deploy"
            ? "Deployed\n  https://graeboard-team.somansadev.workers.dev\n"
            : "",
      },
    );
    return JSON.parse(readFileSync(join(dir, ".env.gateway.json"), "utf8"))
      .triggers.crons;
  };
  assert.deepEqual(
    deployed((site) => ({
      ...site,
      gateway: { ...site.gateway, triggers: { crons: [] } },
    })),
    ["* * * * *"],
  );
  assert.deepEqual(
    deployed((site) => ({ ...site, cron: false })),
    [],
  );
});
