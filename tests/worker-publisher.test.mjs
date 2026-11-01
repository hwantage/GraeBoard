import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  sqliteBusinessFixture,
  postgresBusinessFixture,
} from "./business-storage-fixture.mjs";
import { githubEmulator, bucket } from "./worker-github-fixture.mjs";
import { createWorker } from "../worker/entry.mjs";
import {
  createPublisher,
  runTeam,
  scheduled,
  refreshTeam,
} from "../worker/sync.mjs";
import { profileFor } from "../shared/sync-profiles.js";
import { GitHubApiTransport } from "../worker/git.mjs";
import { encodeSnapshot } from "../server/sync/snapshot.mjs";
import {
  canonical,
  digest,
  stateHash,
  entityId,
} from "../server/sync/protocol.mjs";
import { unpack } from "../shared/compact.js";

function controlledClock(t) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const waiting = [],
    observers = [];
  return {
    now: () => Date.now(),
    wait(ms) {
      const promise = new Promise((resolve) => {
        waiting.push({ at: Date.now() + ms, resolve });
      });
      for (const resolve of observers.splice(0)) resolve();
      return promise;
    },
    async parked(count = 1) {
      while (waiting.length < count)
        await new Promise((resolve) => observers.push(resolve));
    },
    advance(ms) {
      t.mock.timers.tick(ms);
    },
    wake() {
      for (let i = waiting.length - 1; i >= 0; i--)
        if (waiting[i].at <= Date.now()) waiting.splice(i, 1)[0].resolve();
    },
    deadlines: () => waiting.map((item) => item.at),
  };
}

test(
  "Worker publisher coalesces real saves across isolates; durable deadlines, faults, Cron and manual flush preserve pending operations",
  { timeout: 90000 },
  async (t) => {
    const f = await postgresBusinessFixture(t, sqliteBusinessFixture(t));
    if (!f) return;
    const clock = controlledClock(t),
      remote = join(f.dir, "remote.git"),
      nativeFetch = globalThis.fetch;
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    const github = githubEmulator(remote);
    let failGitHub = false,
      failedFetches = 0,
      limited = false,
      limitedFetches = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      assert.equal(
        url.origin,
        "https://api.github.com",
        "No live HTTP permitted",
      );
      if (failGitHub) {
        failedFetches++;
        throw new TypeError("fixture GitHub outage");
      }
      if (limited) {
        limitedFetches++;
        return new Response("", {
          status: 429,
          headers: { "retry-after": "120" },
        });
      }
      return github.fetch(url.href, init);
    };
    t.after(() => {
      globalThis.fetch = nativeFetch;
    });
    const phases = [],
      log = console.log;
    t.mock.method(console, "log", (...args) =>
      args[0] === "GraeBoard sync phase"
        ? phases.push(JSON.parse(args[1]))
        : log(...args),
    );
    Object.assign(f.env, {
      SYNC_PHASE_LOG: "1",
      APP_ORIGIN: "https://publisher.example.test",
      ACCESS_ISSUER: "https://publisher.cloudflareaccess.com",
      INSTALLATION_ID: f.link.installation_id,
      BUCKET: bucket(),
      TOKEN: "fixture-secret",
      SYNC_PROFILES: JSON.stringify([
        {
          profileId: "contract",
          teamId: f.teamId,
          repository: "fixture/team",
          databaseBinding: "PG_TEAM",
          bucketBinding: "BUCKET",
          githubSecret: "TOKEN",
        },
      ]),
    });
    const env = f.env,
      profile = profileFor(env, "contract", f.teamId),
      transport = new GitHubApiTransport({
        repository: profile.repository,
        token: env.TOKEN,
      });
    const bytes = encodeSnapshot({ state: f.state, hash: stateHash(f.state) });
    const genesis = await transport.createCandidate(null, {
      "manifest.json": canonical({
        protocol: 1,
        reducer: 1,
        teamId: f.teamId,
        repoId: f.link.repo_id,
        bootstrapId: f.link.bootstrap_id,
        genesis: "snapshots/genesis.json.gz",
        genesisHash: digest(bytes),
      }),
      "snapshots/genesis.json.gz": bytes,
    });
    await transport.publish(genesis, null);
    await f.adapter.withTeamTransaction(f.teamId, async (tx) => {
      await tx.sync.writeLink({
        mode: "active",
        canonical_head: genesis,
        canonical_hash: stateHash(f.state),
      });
      await tx.sync.writeState(f.state, genesis);
    });
    await f.control.query(
      "INSERT INTO graeboard.access_identities(issuer,subject,user_id) VALUES($1,'publisher',$2)",
      [env.ACCESS_ISSUER, f.user.id],
    );
    const errors = [],
      work = [];
    const makeWorker = (publish = createPublisher(clock)) =>
      createWorker({
        publish,
        verify: async () => ({
          issuer: env.ACCESS_ISSUER,
          subject: "publisher",
          email: "contract@example.test",
          expiresAt: Date.now() + 3600000,
        }),
        onError: (error) => errors.push(error),
      });
    let worker = makeWorker(),
      version = 1,
      serial = 0;
    const request = async (path, body, method = body ? "POST" : "GET") => {
      const response = await worker.fetch(
        new Request(env.APP_ORIGIN + "/api" + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "WeeklyPlan",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        env,
        { waitUntil: (promise) => work.push(promise) },
      );
      const result = unpack(await response.json());
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const save = async () => {
      const result = await request("/cells/batch", {
        operationId: randomUUID(),
        createdAt: new Date().toISOString(),
        changes: [
          {
            taskId: f.taskId,
            key: "title",
            expectedVersion: version,
            value: "Save " + ++serial,
          },
        ],
      });
      version = result.cells[0].version;
    };
    const pending = () => f.adapter.readPending(f.teamId);
    const metadata = async () =>
      JSON.parse(
        (
          await f.pool.query(
            "SELECT payload FROM graeboard.site_entities WHERE team_id=$1 AND entity='syncRefresh' AND entity_key='[]'",
            [f.teamId],
          )
        ).rows[0]?.payload || "{}",
      );
    const drain = async () => {
      for (const promise of work.splice(0)) await promise;
    };
    const publishes = (calls) =>
      calls.filter(
        (call) =>
          call.method === "PATCH" && call.path === "/git/refs/heads/sync-v1",
      );
    const assertConverged = async () => {
      assert.equal((await pending()).length, 0);
      const state = await f.adapter.readState(f.teamId);
      assert.equal(
        state.entities[entityId("cell", [f.taskId, "title"])].payload.value,
        "Save " + serial,
      );
      assert.equal(
        (await f.adapter.readLink(f.teamId)).canonical_head,
        github.text(["rev-parse", "refs/heads/sync-v1"]),
      );
    };

    // First fixed 2s window: 20 real successful saves, zero outbound commits.
    const start = github.calls.length;
    for (let i = 0; i < 20; i++) {
      await save();
      clock.advance(90);
    }
    await clock.parked();
    assert.equal((await pending()).length, 20);
    assert.equal(
      github.calls.length - start,
      1,
      "Only the pre-edit freshness HEAD request",
    );
    // A second isolate has its own timer but the same durable claim.
    work.push(createPublisher(clock)(env, profile));
    await clock.parked(2);
    clock.advance(200);
    clock.wake();
    await drain();
    await assertConverged();
    assert.equal(publishes(github.calls.slice(start)).length, 1);
    const firstCooldown = (await metadata()).publishAfter;
    assert.equal(firstCooldown, Date.now() + 5000);

    // Continuous saves do not postpone a fixed window; 60 mutations need three
    // canonical commits, not 60 cycles. The API fetch spy covers all real calls.
    for (let burst = 0; burst < 2; burst++) {
      for (let i = 0; i < 20; i++) {
        await save();
        clock.advance(200);
      }
      await clock.parked();
      assert.equal(publishes(github.calls.slice(start)).length, burst + 1);
      clock.advance(1000);
      clock.wake();
      await drain();
      await assertConverged();
    }
    const burstCalls = github.calls.slice(start);
    assert.equal(serial, 60);
    assert.equal(publishes(burstCalls).length, 3);
    assert.ok(
      burstCalls.length <= 46,
      `60 mutations used ${burstCalls.length} GitHub calls`,
    );
    assert.equal(
      burstCalls.some((call) => call.path.includes("sync-status")),
      false,
    );
    assert.equal(
      Object.keys((await f.adapter.readState(f.teamId)).receipts).length,
      60,
    );

    // Network failure keeps immutable P and advances the persisted cooldown.
    for (let i = 0; i < 5; i++) await save();
    await clock.parked();
    const beforeFailure = (await pending()).map(digest),
      failureHead = (await f.adapter.readLink(f.teamId)).canonical_head;
    failGitHub = true;
    clock.advance(5000);
    clock.wake();
    await drain();
    assert.equal(
      failedFetches,
      3,
      "one request plus two bounded network retries",
    );
    assert.deepEqual((await pending()).map(digest), beforeFailure);
    assert.equal(
      (await f.adapter.readLink(f.teamId)).canonical_head,
      failureHead,
    );
    const retryAt = (await metadata()).publishAfter;
    assert.equal(retryAt, Date.now() + 5000);
    worker = makeWorker(); // Brand-new isolate: no in-memory timer or attempt state.
    for (let i = 0; i < 5; i++) await save();
    await clock.parked();
    assert.deepEqual(clock.deadlines(), [retryAt]);
    assert.equal(
      failedFetches,
      3,
      "Fresh isolate cannot retry every subsequent mutation",
    );
    failGitHub = false;
    clock.advance(5000);
    clock.wake();
    await drain();
    await assertConverged();

    // Timer/isolate loss: do not wake this callback at all. Cron retains P while
    // another executor owns the lease, then flushes after that executor releases.
    await save();
    await clock.parked();
    const abandoned = work.splice(0),
      retained = (await pending()).map(digest);
    await f.pool.query(
      "UPDATE graeboard.team_sync_links SET lease_owner='other-executor',lease_until=$2 WHERE team_id=$1",
      [f.teamId, Date.now() + 600000],
    );
    const beforeBusy = github.calls.length;
    clock.advance(60000);
    await scheduled(env);
    assert.equal(github.calls.length, beforeBusy);
    assert.deepEqual((await pending()).map(digest), retained);
    // A manual run meeting that lease reports it did nothing instead of a
    // completed run with the pending count unchanged.
    const manual = await request(`/teams/${f.teamId}/sync/run`, {});
    assert.equal(manual.busy, true);
    assert.equal(manual.pending, retained.length);
    assert.equal(github.calls.length, beforeBusy);
    await f.pool.query(
      "UPDATE graeboard.team_sync_links SET lease_owner=NULL,lease_until=NULL WHERE team_id=$1",
      [f.teamId],
    );
    worker = makeWorker();
    await scheduled(env);
    await assertConverged();
    const afterCron = github.calls.length;
    clock.wake();
    await Promise.all(abandoned);
    assert.equal(
      github.calls.length,
      afterCron,
      "Abandoned timer later resumed safely sees no pending rows",
    );

    // A restarted Worker still uses the independent 30s read freshness limit.
    const beforeReads = github.calls.length,
      cooldown = (await metadata()).publishAfter;
    for (let i = 0; i < 8; i++)
      await request(`/tasks?teamId=${f.teamId}&year=2026`);
    await drain();
    assert.equal(github.calls.length - beforeReads, 1);
    assert.equal(
      (await metadata()).publishAfter,
      cooldown,
      "Read refresh preserves publish metadata",
    );
    const beforeManual = github.calls.length;
    await save();
    await clock.parked();
    assert.equal(github.calls.length, beforeManual);
    await runTeam(env, profile, { updateStatus: false });
    await assertConverged();
    assert.equal(
      publishes(github.calls.slice(beforeManual)).length,
      1,
      "Explicit synchronization bypasses debounce",
    );
    clock.advance(2000);
    clock.wake();
    await drain();
    assert.equal(publishes(github.calls.slice(beforeManual)).length, 1);
    await save();
    await clock.parked();
    limited = true;
    clock.advance(5000);
    clock.wake();
    await drain();
    const limitedDeadline = Date.now() + 120000;
    assert.equal((await metadata()).publishAfter, limitedDeadline);
    assert.equal((await metadata()).nextAt, limitedDeadline);
    assert.equal(limitedFetches, 1);
    const held = (await pending()).map(digest);
    // A different fetch function gives every new transport an empty process
    // cache; the PostgreSQL deadline still protects Cron, refresh and timers.
    const isolatedFetch = globalThis.fetch;
    globalThis.fetch = (...args) => isolatedFetch(...args);
    await scheduled(env);
    assert.deepEqual(await refreshTeam(env, profile), { throttled: true });
    const delayed = createPublisher(clock)(env, profile);
    await clock.parked();
    clock.advance(5000);
    clock.wake();
    assert.deepEqual(await delayed, { throttled: true });
    assert.equal(limitedFetches, 1);
    assert.deepEqual((await pending()).map(digest), held);
    limited = false;
    clock.advance(limitedDeadline - Date.now());
    await scheduled(env);
    await assertConverged();
    assert.deepEqual(errors, []);
    assert.deepEqual(github.unexpectedCalls, []);
    // Every publication reduced only the records it touched and had PostgreSQL
    // hash C; none loaded the team's whole state.
    const hashed = phases.filter((p) => p.phase === "canonicalHash");
    assert.ok(hashed.length >= 3);
    assert.ok(hashed.every((p) => p.verified));
    assert.deepEqual(
      phases.filter((p) => p.phase === "readState"),
      [],
    );
    t.diagnostic(
      JSON.stringify({
        mutationsInContinuousWindow: 60,
        automaticCommits: 3,
        githubRequests: burstCalls.length,
        failedAttemptRequests: failedFetches,
        cronRecoveredAbandonedTimer: true,
        cronRetainedBusyLease: true,
        restartCooldownPreserved: true,
        manualBypass: true,
        persistedRateLimitDeadline: true,
      }),
    );
  },
);
