import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import pg from "pg";
import { resourceBindings } from "../edge/resources.mjs";
import { databaseFor, controlTransaction } from "../worker/data.mjs";
import { GitHubApiTransport } from "../worker/git.mjs";
import { importTeam, imageSync } from "../worker/sync.mjs";
import { materialize } from "../worker/materialize.mjs";
import { R2ImageStore } from "../worker/images.mjs";
import { profileFor, siteTeamId } from "../shared/sync-profiles.js";
import { SYNC_SNAPSHOT_MAX_BYTES } from "../shared/sync-limits.js";

// A first import reads every object of the genesis commit (one GitHub request
// per image), which exceeds the per-invocation budget of a hosted runtime. The
// operator run has no such limit, so it spends a budget sized for the whole
// repository within GitHub's hourly allowance.
export const OPERATOR_REQUEST_BUDGET = 4500;

// Hosted Edge runtimes cap CPU and memory per request, which a first import of a
// large team can exceed. This runs the same external import path from an
// operator machine against the team's PostgreSQL, R2 gateway and GitHub, so the
// outcome is identical to the Edge "팀 가져오기" without the per-request limits.
export const REQUIRED_SETTINGS = [
  "GRAEBOARD_DATABASE_URL",
  "SITE_TEAM_ID",
  "INSTALLATION_ID",
  "PEER_INSTALLATION_ID",
  "SYNC_PROFILES",
  "GIT_TEAM",
  "RESOURCE_ORIGIN",
  "GRAEBOARD_RESOURCE_SECRET",
];

// Transient resolver and connection failures on the operator network should
// not abort a long pass; retry a few times before giving up.
const isTransient = (error) =>
  /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|UND_ERR|fetch failed|timeout|aborted/i.test(
    `${error?.code || ""} ${error?.cause?.code || ""} ${error?.message || ""}`,
  );
export async function retrying(
  work,
  { log = () => {}, label = "", attempts = 5 } = {},
) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await work(attempt);
    } catch (error) {
      last = error;
      if (!isTransient(error) || attempt === attempts) throw error;
      log(
        `${label || "operation"} attempt ${attempt} failed: ${error.code || error.message}; retrying`,
      );
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
  throw last;
}

// The import reads the repository for minutes between its database phases.
// Idle connections die on NAT/VPN paths in that window, so every phase opens a
// fresh connection: no idle reuse, a generous connect timeout, the host resolved
// once up front (DNS failed mid-run on this path) and a few connect retries.
export async function externalEnvironment(settings, { log = () => {} } = {}) {
  const missing = REQUIRED_SETTINGS.filter((key) => !settings[key]);
  if (missing.length)
    throw new Error(`설정 파일에 ${missing.join(", ")} 값이 필요합니다.`);
  const url = new URL(settings.GRAEBOARD_DATABASE_URL);
  const servername = url.hostname;
  if (!/^[\d.]+$|^\[/.test(servername)) {
    const { address } = await retrying(
      () => lookup(servername, { family: 4 }).catch(() => lookup(servername)),
      { log, label: `resolve ${servername}` },
    );
    url.hostname = address.includes(":") ? `[${address}]` : address;
    log(`database host ${servername} -> ${url.hostname}`);
  }
  const pool = new pg.Pool({
    connectionString: url.href,
    max: 2,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 60 * 1000,
    statement_timeout: 10 * 60 * 1000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10 * 1000,
  });
  pool.on("error", (error) =>
    log(`idle database connection closed: ${error.code || error.message}`),
  );
  const connect = async () => {
    let last;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        return await pool.connect();
      } catch (error) {
        last = error;
        log(
          `database connect attempt ${attempt} failed: ${error.code || error.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
      }
    }
    throw last;
  };
  const resources = resourceBindings(settings);
  return {
    env: {
      ...settings,
      GRAEBOARD_SITE: "external",
      PG_SITE: {
        connectionString: url.href,
        pool: { connect, end: () => pool.end() },
      },
      R2_TEAM: resources.bucket,
      IMAGES: resources.images,
    },
    close: () => pool.end(),
  };
}

export async function importExternalTeam(
  settings,
  {
    profileId = "",
    dryRun = false,
    // Commit the business state first; install images in a later `--images`
    // pass so the database phase is not separated by minutes of downloads.
    deferImages = true,
    log = console.log,
  } = {},
) {
  const { env, close } = await externalEnvironment(settings, { log });
  try {
    const teamId = siteTeamId(env);
    const profile = profileFor(
      env,
      profileId || JSON.parse(env.SYNC_PROFILES)[0]?.profileId,
      teamId,
    );
    const db = databaseFor(env, profile);
    await db.health();
    const transport = new GitHubApiTransport({
      repository: profile.repository,
      token: env[profile.githubSecret],
    });
    await transport.check();
    const head = await transport.readHead();
    if (!head) throw new Error("내부 사이트에서 최초 게시를 완료하세요.");
    const team = await controlTransaction(
      env,
      async (tx) =>
        (
          await tx.query("SELECT status,profile_id FROM teams WHERE id=$1", [
            teamId,
          ])
        ).rows[0],
    );
    const link = await db.readLink(teamId);
    log(
      JSON.stringify({
        teamId,
        profileId: profile.profileId,
        repository: profile.repository,
        head,
        teamStatus: team?.status || "none",
        linkMode: link?.mode || "none",
        canonicalHead: link?.canonical_head || null,
        dryRun,
      }),
    );
    if (dryRun) return { dryRun: true, head };
    let result;
    // Commits published while the import runs leave the link one cycle behind;
    // each extra cycle only applies the new commits.
    // One hosted invocation applies four commits; the operator run reads the
    // state once per cycle, so it applies long chains in far fewer cycles.
    for (let cycle = 1; cycle <= 40; cycle++) {
      result = await importTeam(
        {
          env,
          admin() {},
          deferImages,
          maxCommits: 64,
          leaseMs: 6 * 60 * 60 * 1000,
          incrementalMaterialize: true,
          transport: new GitHubApiTransport({
            repository: profile.repository,
            token: env[profile.githubSecret],
            maxBlobBytes: SYNC_SNAPSHOT_MAX_BYTES,
            maxRequests: OPERATOR_REQUEST_BUDGET,
          }),
        },
        { profileId: profile.profileId, teamId },
      );
      log(JSON.stringify({ cycle, ...result }));
      if (result.phase === "complete") break;
    }
    // The incremental cycles wrote only changed rows; one full comparison
    // leaves the application projection exactly as a hosted run would.
    const final = await db.readState(teamId);
    await db.withTeamTransaction(teamId, async (tx) =>
      materialize(tx, teamId, {
        state: final,
        pending: await tx.sync.readPending(),
        exclusions: await tx.sync.readExclusions(),
      }),
    );
    log(
      JSON.stringify({
        verified: true,
        entities: Object.keys(final.entities).length,
      }),
    );
    return result;
  } finally {
    await close();
  }
}

// Install every image the current state references and R2 does not hold yet.
// Each image is read from the canonical head and hash-verified before upload,
// so this pass can be repeated until it reports zero remaining.
export async function installExternalImages(
  settings,
  { profileId = "", log = console.log } = {},
) {
  const { env, close } = await externalEnvironment(settings, { log });
  try {
    const teamId = siteTeamId(env);
    const profile = profileFor(
      env,
      profileId || JSON.parse(env.SYNC_PROFILES)[0]?.profileId,
      teamId,
    );
    const db = databaseFor(env, profile);
    const link = await db.readLink(teamId);
    if (!link?.canonical_head)
      throw new Error("먼저 팀 자료를 가져온 뒤 이미지를 설치하세요.");
    const state = await db.readState(teamId);
    const store = new R2ImageStore(env[profile.bucketBinding], teamId);
    let installed = 0;
    const install = store.install.bind(store);
    store.install = async (url, bytes) => {
      await install(url, bytes);
      installed++;
      if (installed % 50 === 0) log(JSON.stringify({ installed }));
    };
    const transport = new GitHubApiTransport({
      repository: profile.repository,
      token: env[profile.githubSecret],
      maxBlobBytes: SYNC_SNAPSHOT_MAX_BYTES,
      maxRequests: OPERATOR_REQUEST_BUDGET,
    });
    // Already installed objects are skipped, so a pass interrupted by the
    // network simply continues where it stopped.
    await retrying(
      () =>
        imageSync(db, profile, store).receive(
          state,
          link.canonical_head,
          transport,
          {},
        ),
      { log, label: "image installation", attempts: 8 },
    );
    const result = { teamId, head: link.canonical_head, installed };
    log(JSON.stringify(result));
    return result;
  } finally {
    await close();
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      settings: { type: "string" },
      "profile-id": { type: "string" },
      "dry-run": { type: "boolean" },
      images: { type: "boolean" },
      "with-images": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !values.settings) {
    console.log(
      "npm run sync:external-import -- --settings /private/external-import.env [--profile-id ID] [--dry-run] [--with-images]\n" +
        "npm run sync:external-import -- --settings /private/external-import.env --images",
    );
    if (!values.help) process.exitCode = 1;
    return;
  }
  // Secrets may come from the operator's environment instead of the file, e.g.
  // GIT_TEAM=$(gh auth token), so they never need to be written to disk.
  const settings = parseEnv(readFileSync(values.settings, "utf8"));
  for (const key of REQUIRED_SETTINGS)
    if (!settings[key] && process.env[key]) settings[key] = process.env[key];
  if (values.images) {
    await installExternalImages(settings, { profileId: values["profile-id"] });
    return;
  }
  await importExternalTeam(settings, {
    profileId: values["profile-id"],
    dryRun: !!values["dry-run"],
    deferImages: !values["with-images"],
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
