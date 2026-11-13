import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import pg from "pg";
import { resourceBindings } from "../../edge/resources.mjs";
import { databaseFor, controlTransaction } from "../../worker/storage/data.mjs";
import { GitHubApiTransport } from "../../worker/sync/git.mjs";
import { importTeam, imageSync, runTeam } from "../../worker/sync/sync.mjs";
import { materialize } from "../../worker/sync/materialize.mjs";
import { R2ImageStore } from "../../worker/documents/images.mjs";
import { profileFor, siteTeamId } from "../../shared/sync/sync-profiles.js";
import { SYNC_SNAPSHOT_MAX_BYTES } from "../../shared/sync/sync-limits.js";

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

// The gateway's resource secret is stored only in deployment secrets, which
// cannot be read back. An operator whose Wrangler is logged in to the site's
// Cloudflare account can reach the same R2 bucket without it.
export function wranglerBucket(
  name,
  run = (args) =>
    new Promise((resolve) =>
      execFile(
        "npx",
        ["wrangler", "r2", "object", ...args, "--remote"],
        { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) =>
          resolve({ ok: !error, stdout, stderr: stderr.toString() }),
      ),
    ),
) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name))
    throw new Error("R2 bucket 이름이 올바르지 않습니다.");
  const target = (key) => {
    if (!/^[\w./-]+$/.test(key)) throw new Error("Unsupported object key");
    return `${name}/${key}`;
  };
  const failed = (result) =>
    Object.assign(
      new Error(
        "Wrangler R2 요청 실패: " +
          (result.stderr.match(/ERROR[^\n]*\n?[^\n]*/)?.[0] || "unknown").slice(
            0,
            200,
          ),
      ),
      { status: 503 },
    );
  const get = async (key) => {
    const result = await run(["get", target(key), "--pipe"]);
    if (result.ok) return new Uint8Array(result.stdout);
    if (/specified key does not exist/i.test(result.stderr)) return null;
    throw failed(result);
  };
  return {
    async get(key) {
      const bytes = await get(key);
      return (
        bytes && {
          arrayBuffer: async () =>
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
        }
      );
    },
    async head(key) {
      const bytes = await get(key);
      return bytes && { key, size: bytes.byteLength };
    },
    async put(key, bytes, metadata = {}) {
      const dir = mkdtempSync(join(tmpdir(), "graeboard-r2-"));
      try {
        const file = join(dir, "object");
        writeFileSync(file, bytes);
        const result = await run([
          "put",
          target(key),
          "--file",
          file,
          "--content-type",
          metadata.httpMetadata?.contentType || "application/octet-stream",
        ]);
        if (!result.ok) throw failed(result);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async delete(key) {
      const result = await run(["delete", target(key)]);
      if (!result.ok) throw failed(result);
    },
  };
}

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
export async function externalEnvironment(
  settings,
  { log = () => {}, r2Bucket = "" } = {},
) {
  // With the bucket reached through Wrangler nothing goes to the gateway.
  if (r2Bucket && !settings.GRAEBOARD_RESOURCE_SECRET)
    settings = { ...settings, GRAEBOARD_RESOURCE_SECRET: "wrangler" };
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
      R2_TEAM: r2Bucket ? wranglerBucket(r2Bucket) : resources.bucket,
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
          // Without a CPU limit, reading C once per cycle and replaying 64
          // commits in memory beats one SQL hash of C per commit.
          slices: false,
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

// How long the catch-up waits for a hosted run's lease: an invocation stopped
// at its limit leaves the team leased for seven minutes.
export const CATCH_UP_WAIT_MS = 20 * 60 * 1000;

// Receive what an active team could not: commits whose events exceed the hosted
// runtime's CPU or memory limit stop every hosted run at the same commit. This
// runs the ordinary receive (same code path as the hosted run, images included)
// from the operator machine, under the team's lease, until the site reaches the
// repository head. Local unpublished changes stay pending and are rebased as in
// any receive; the hosted runs publish them afterwards unless `publish` is set.
export async function catchUpExternalTeam(settings, options = {}) {
  const log = options.log || console.log;
  const { env, close } = await externalEnvironment(settings, {
    log,
    r2Bucket: options.r2Bucket,
  });
  try {
    const teamId = siteTeamId(env);
    const profile = profileFor(
      env,
      options.profileId || JSON.parse(env.SYNC_PROFILES)[0]?.profileId,
      teamId,
    );
    return await catchUpTeam(env, profile, options);
  } finally {
    await close();
  }
}
export async function catchUpTeam(
  env,
  profile,
  {
    dryRun = false,
    publish = false,
    deferImages = false,
    waitMs = CATCH_UP_WAIT_MS,
    pollMs = 200,
    log = console.log,
  } = {},
) {
  const teamId = profile.teamId,
    db = databaseFor(env, profile);
  await db.health();
  const transportFor = () =>
    new GitHubApiTransport({
      repository: profile.repository,
      token: env[profile.githubSecret],
      maxBlobBytes: SYNC_SNAPSHOT_MAX_BYTES,
      maxRequests: OPERATOR_REQUEST_BUDGET,
    });
  const probe = transportFor();
  await probe.check();
  const head = await probe.readHead();
  const link = await db.readLink(teamId);
  const pending = (await db.readPending(teamId)).length;
  log(
    JSON.stringify({
      teamId,
      profileId: profile.profileId,
      repository: profile.repository,
      head,
      linkMode: link?.mode || "none",
      canonicalHead: link?.canonical_head || null,
      installationMatches: link?.installation_id === env.INSTALLATION_ID,
      leaseUntil:
        link?.lease_owner && link.lease_until
          ? new Date(Number(link.lease_until)).toISOString()
          : null,
      pending,
      lastError: link?.last_error || null,
      dryRun,
    }),
  );
  // runTeam moves a link with another installation's identity to recovery;
  // a wrong settings file must not do that to a production team.
  if (link?.mode !== "active")
    throw new Error("동기화 중(active)인 팀만 이어받을 수 있습니다.");
  if (link.installation_id !== env.INSTALLATION_ID)
    throw new Error("INSTALLATION_ID가 이 팀의 연결과 다릅니다.");
  if (dryRun) return { dryRun: true, head };
  const deadline = Date.now() + waitMs;
  for (let cycle = 1; cycle <= 40;) {
    const result = await runTeam(env, profile, {
      receiveOnly: !publish,
      deferImages,
      transport: transportFor(),
      // Every commit behind the head in one leased run: releasing the lease
      // between commits would hand the next large one back to a hosted run.
      maxCommits: 64,
      leaseMs: 30 * 60 * 1000,
    });
    if (result.busy) {
      if (Date.now() > deadline)
        throw new Error(
          "다른 동기화 실행이 끝나지 않아 이어받지 못했습니다. 잠시 뒤 다시 실행하세요.",
        );
      // Hosted runs take an expired lease within seconds, so try again at
      // the moment the current one ends instead of at a fixed interval.
      const held = await db.readLink(teamId),
        left = held?.lease_owner ? Number(held.lease_until) - Date.now() : 0;
      await new Promise((resolve) =>
        setTimeout(resolve, left > 0 ? Math.min(left, 30000) : pollMs),
      );
      continue;
    }
    log(JSON.stringify({ cycle, ...result }));
    if (!result.head || result.head === (await transportFor().readHead()))
      break;
    cycle++;
  }
  const after = await db.readLink(teamId);
  const final = {
    teamId,
    linkMode: after.mode,
    canonicalHead: after.canonical_head,
    pending: (await db.readPending(teamId)).length,
    lastError: after.last_error || null,
  };
  log(JSON.stringify(final));
  return final;
}

// Install every image the current state references and R2 does not hold yet.
// Each image is read from the canonical head and hash-verified before upload,
// so this pass can be repeated until it reports zero remaining.
export async function installExternalImages(
  settings,
  { profileId = "", r2Bucket = "", log = console.log } = {},
) {
  const { env, close } = await externalEnvironment(settings, { log, r2Bucket });
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
      "catch-up": { type: "boolean" },
      publish: { type: "boolean" },
      "defer-images": { type: "boolean" },
      "r2-bucket": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !values.settings) {
    console.log(
      "npm run sync:external-import -- --settings /private/external-import.env [--profile-id ID] [--dry-run] [--with-images]\n" +
        "npm run sync:external-import -- --settings /private/external-import.env --images\n" +
        "npm run sync:external-import -- --settings /private/external-import.env --catch-up [--dry-run] [--publish] [--defer-images] [--r2-bucket NAME]",
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
    await installExternalImages(settings, {
      profileId: values["profile-id"],
      r2Bucket: values["r2-bucket"],
    });
    return;
  }
  if (values["catch-up"]) {
    await catchUpExternalTeam(settings, {
      profileId: values["profile-id"],
      dryRun: !!values["dry-run"],
      publish: !!values.publish,
      deferImages: !!values["defer-images"],
      r2Bucket: values["r2-bucket"],
    });
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
