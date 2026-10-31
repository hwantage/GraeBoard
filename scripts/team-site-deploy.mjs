import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Deploys one team's external site: the Supabase Edge function, then the
// Cloudflare gateway Worker, then both sides' secrets. The setup guide builds
// two values the team pastes once into the fork's Actions settings: the
// TEAM_SITE_CONFIG variable and the TEAM_SITE_SECRETS secret (the three tokens
// and three keys), so nothing is copied into the Supabase or Cloudflare consoles.
const EDGE_SETTINGS = [
  "GRAEBOARD_SITE",
  "SITE_NAME",
  "SITE_TEAM_ID",
  "INSTALLATION_ID",
  "PEER_INSTALLATION_ID",
  "APP_ORIGIN",
  "ACCESS_ISSUER",
  "ACCESS_AUDIENCE",
  "SYNC_PROFILES",
];
const SITE_TOKENS = [
  "CLOUDFLARE_API_TOKEN",
  "SUPABASE_ACCESS_TOKEN",
  "GIT_TEAM",
];
export const SITE_KEYS = [
  "GRAEBOARD_GATEWAY_SECRET",
  "GRAEBOARD_RESOURCE_SECRET",
  "GRAEBOARD_ACCESS_TOKEN_KEY",
];
const settings =
  "fork의 Settings → Secrets and variables → Actions에 설정 안내 배포 단계의 값을 넣으세요";

function fail(message) {
  throw new Error(message);
}
function json(value, name) {
  try {
    return JSON.parse(value);
  } catch {
    return fail(
      `${name}가 JSON이 아닙니다. 설정 안내에서 전체를 다시 복사하세요.`,
    );
  }
}
function checkGateway(gateway, name) {
  if (
    !gateway?.name ||
    !gateway.vars?.APP_ORIGIN ||
    !gateway.vars?.GRAEBOARD_EDGE_URL
  )
    fail(
      `${name}에는 설정 안내 배포 단계의 gateway 설정 JSON 전체를 넣으세요.`,
    );
  return gateway;
}

// TEAM_SITE_CONFIG carries everything; older forks keep their three separate
// variables and set secrets in the consoles themselves.
export function readDeployConfig(env) {
  const missing = (names) => names.filter((name) => !env[name]);
  if (env.TEAM_SITE_CONFIG) {
    const config = json(env.TEAM_SITE_CONFIG, "TEAM_SITE_CONFIG");
    if (!/^[0-9a-f]{32}$/.test(config.cloudflareAccountId || ""))
      fail("TEAM_SITE_CONFIG의 Cloudflare Account ID가 올바르지 않습니다.");
    if (!/^[a-z0-9]{20}$/.test(config.supabaseProjectRef || ""))
      fail("TEAM_SITE_CONFIG의 Supabase Reference ID가 올바르지 않습니다.");
    checkGateway(config.gateway, "TEAM_SITE_CONFIG");
    const edge = config.edge || {};
    const absent = EDGE_SETTINGS.filter(
      (name) => typeof edge[name] !== "string" || !edge[name],
    );
    if (absent.length)
      fail(`TEAM_SITE_CONFIG에 Edge 설정이 빠졌습니다: ${absent.join(", ")}`);
    if (!env.TEAM_SITE_SECRETS) fail(`${settings}: TEAM_SITE_SECRETS`);
    const secrets = json(env.TEAM_SITE_SECRETS, "TEAM_SITE_SECRETS");
    for (const name of SITE_TOKENS)
      if (typeof secrets[name] !== "string" || !secrets[name])
        fail(`TEAM_SITE_SECRETS에 ${name}가 없습니다.`);
    for (const name of SITE_KEYS)
      if (typeof secrets[name] !== "string" || secrets[name].length < 32)
        fail(`TEAM_SITE_SECRETS의 ${name}가 없거나 짧습니다.`);
    if (Buffer.from(secrets.GRAEBOARD_ACCESS_TOKEN_KEY, "base64").length !== 32)
      fail(
        "TEAM_SITE_SECRETS의 GRAEBOARD_ACCESS_TOKEN_KEY는 base64 32바이트여야 합니다.",
      );
    return {
      accountId: config.cloudflareAccountId,
      projectRef: config.supabaseProjectRef,
      gateway: config.gateway,
      edge,
      keys: Object.fromEntries(SITE_KEYS.map((name) => [name, secrets[name]])),
      gitToken: secrets.GIT_TEAM,
      tokens: {
        CLOUDFLARE_API_TOKEN: secrets.CLOUDFLARE_API_TOKEN,
        SUPABASE_ACCESS_TOKEN: secrets.SUPABASE_ACCESS_TOKEN,
      },
    };
  }
  const lacking = missing([
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_PROJECT_REF",
    "GATEWAY_CONFIG",
  ]);
  if (lacking.length) fail(`${settings}: TEAM_SITE_CONFIG`);
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    projectRef: env.SUPABASE_PROJECT_REF,
    gateway: checkGateway(
      json(env.GATEWAY_CONFIG, "GATEWAY_CONFIG"),
      "GATEWAY_CONFIG",
    ),
  };
}

// wrangler prints the workers.dev address of the Worker it deployed.
export function workerOrigin(output, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(
    new RegExp(`https://${escaped}\\.[a-z0-9-]+\\.workers\\.dev`, "i"),
  );
  return match ? match[0].toLowerCase() : "";
}

// A regenerated TEAM_SITE_SECRETS must not replace the access token key the
// Edge already uses, or every access token issued with it becomes unreadable.
export function edgeSecrets(config, resourceOrigin, keepAccessKey = false) {
  const values = {
    ...config.edge,
    RESOURCE_ORIGIN: resourceOrigin,
    ...config.keys,
    GIT_TEAM: config.gitToken,
  };
  if (keepAccessKey) delete values.GRAEBOARD_ACCESS_TOKEN_KEY;
  return values;
}
export const hasSecret = (listing, name) =>
  new RegExp(`(^|[^A-Z0-9_])${name}([^A-Z0-9_]|$)`, "m").test(listing);

function runCommand(command, args, { capture = false, env } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
  });
  if (result.status !== 0)
    fail(`${command} ${args.slice(0, 2).join(" ")} 실행이 실패했습니다.`);
  if (capture) process.stdout.write(result.stdout);
  return result.stdout || "";
}
const defined = (values) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value));

export function deployTeamSite(env, { run = runCommand, cwd = "." } = {}) {
  const config = readDeployConfig(env);
  const gatewayFile = join(cwd, ".env.gateway.json");
  writeFileSync(gatewayFile, JSON.stringify(config.gateway, null, 2) + "\n");
  const tokens = config.tokens || {};
  const cloudflare = defined({
    CLOUDFLARE_ACCOUNT_ID: config.accountId,
    CLOUDFLARE_API_TOKEN: tokens.CLOUDFLARE_API_TOKEN,
  });
  const supabase = defined({
    SUPABASE_ACCESS_TOKEN: tokens.SUPABASE_ACCESS_TOKEN,
  });
  // The API first, so a new screen never meets an older API.
  run(
    "supabase",
    [
      "functions",
      "deploy",
      "graeboard",
      "--project-ref",
      config.projectRef,
      "--use-api",
    ],
    { env: supabase },
  );
  const output = run("npx", ["wrangler", "deploy", "--config", gatewayFile], {
    capture: true,
    env: cloudflare,
  });
  if (!config.keys) return { secrets: false };
  const resourceOrigin = workerOrigin(output, config.gateway.name);
  if (!resourceOrigin)
    fail(
      "배포한 gateway의 workers.dev 주소를 찾지 못했습니다. Cloudflare Workers & Pages에서 workers.dev 하위 도메인을 확인하세요.",
    );
  const dir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "graeboard-keys-"));
  try {
    const file = join(dir, "gateway-secrets.json");
    writeFileSync(
      file,
      JSON.stringify({
        GRAEBOARD_GATEWAY_SECRET: config.keys.GRAEBOARD_GATEWAY_SECRET,
        GRAEBOARD_RESOURCE_SECRET: config.keys.GRAEBOARD_RESOURCE_SECRET,
      }),
      { mode: 0o600 },
    );
    run("npx", ["wrangler", "secret", "bulk", file, "--config", gatewayFile], {
      env: cloudflare,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const listing = run(
    "supabase",
    ["secrets", "list", "--project-ref", config.projectRef],
    { capture: true, env: supabase },
  );
  const keptAccessKey = hasSecret(listing, "GRAEBOARD_ACCESS_TOKEN_KEY");
  run(
    "supabase",
    [
      "secrets",
      "set",
      "--project-ref",
      config.projectRef,
      ...Object.entries(edgeSecrets(config, resourceOrigin, keptAccessKey)).map(
        ([name, value]) => `${name}=${value}`,
      ),
    ],
    { env: supabase },
  );
  return { secrets: true, resourceOrigin, keptAccessKey };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv.includes("--check")) {
      const config = readDeployConfig(process.env);
      // GitHub masks a secret as a whole, not the values inside its JSON.
      if (process.env.GITHUB_ACTIONS && config.keys)
        for (const value of [
          ...Object.values(config.keys),
          ...Object.values(config.tokens),
          config.gitToken,
        ])
          console.log(`::add-mask::${value}`);
      console.log(
        config.keys
          ? "TEAM_SITE_CONFIG로 배포하고 비밀 키·Edge 설정을 반영합니다."
          : "기존 변수로 배포합니다. 비밀 키·Edge 설정은 콘솔에서 관리합니다.",
      );
    } else {
      const { secrets, resourceOrigin } = deployTeamSite(process.env);
      console.log(
        secrets
          ? `배포와 설정 반영을 마쳤습니다. gateway 주소: ${resourceOrigin}`
          : "배포를 마쳤습니다.",
      );
    }
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
