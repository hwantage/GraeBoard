// Compatibility: the immutable full cutover source generates the result, while
// all runtime imports below exercise the current SQLite/PG APIs and recovery.
// The one-time SheetClone cutover of one team synchronized between the internal
// SQLite site and the external PostgreSQL site through one Git repository,
// from the databases and history the released f744ead code wrote, with every
// site stopped (tools/sheet-clone-cutover). The sites then start in turn on the
// standard checkpoint the tool leaves; this release has no cutover code.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { openDatabase } from "../../../server/db.mjs";
import { createApp } from "../../../server/app.mjs";
import { unpack } from "../../../shared/formatting/compact.js";
import { migratePostgres } from "../../../server/migrations/postgres.mjs";
import { GitCliTransport } from "../../../server/sync/node/git-cli.mjs";
import { canonical, stateHash } from "../../../server/sync/core/protocol.mjs";
import { decodeSnapshot } from "../../../server/sync/core/snapshot.mjs";
import { PostgresDatabase } from "../../../worker/storage/postgres.mjs";
import { createWorker } from "../../../worker/entry.mjs";
import { runTeam } from "../../../worker/sync/sync.mjs";
import { profileFor } from "../../../shared/sync/sync-profiles.js";
import { recoverSync } from "../../../scripts/sync/sync-recover.mjs";
import {
  frozenCutoverModule,
  frozenCutoverSource,
} from "../../support/frozen-cutover-source.mjs";
const { BOUNDARY_KIND, runCutover } = await frozenCutoverModule(
  "tools/sheet-clone-cutover/cutover.mjs",
);
import {
  githubEmulator,
  bucket,
} from "../../support/worker-github-fixture.mjs";

const { Pool, Client } = pg;
const pgBin = process.env.TEST_PG_BIN,
  FIXTURE = new URL(
    "tests/fixtures/sheet-clone-legacy/",
    frozenCutoverSource().url,
  ),
  read = (name) => readFileSync(new URL(name, FIXTURE), "utf8"),
  manifest = JSON.parse(read("manifest.json")),
  ORIGINS = [manifest.origins.internal, manifest.origins.external],
  { teamId } = manifest,
  { R1, R2, R5 } = manifest.copies,
  { T1, T4 } = manifest.tasks;
const ok = (result) => {
  assert.ok(result.status < 300, JSON.stringify(result));
  return result.data;
};
const sha = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

// A PostgreSQL cluster, the released databases of one fixture history and the
// repository as both sites left it at the recorded head.
async function released(t, label, port) {
  const dir = mkdtempSync(join(tmpdir(), "gb-sheet-clone-cutover-")),
    remote = join(dir, "remote.git"),
    socket = join(dir, "socket"),
    pgData = join(dir, "pg"),
    pools = [];
  mkdirSync(socket);
  let pgStarted = false;
  const command = (bin, args) => {
      const r = spawnSync(join(pgBin, bin), args, { encoding: "utf8" });
      assert.equal(r.status, 0, r.stdout + r.stderr);
    },
    url = (name) =>
      `postgresql://postgres@localhost/${name}?host=${encodeURIComponent(socket)}&port=${port}`;
  t.after(async () => {
    for (const pool of pools) await pool.end().catch(() => {});
    if (pgStarted)
      spawnSync(join(pgBin, "pg_ctl"), [
        "-D",
        pgData,
        "-m",
        "immediate",
        "stop",
      ]);
    rmSync(dir, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      remote,
      "fetch",
      new URL("sync.bundle", FIXTURE).pathname,
      "refs/*:refs/*",
    ],
    { stdio: "ignore" },
  );
  const base = manifest.sync[label],
    git = (...args) =>
      execFileSync("git", ["-C", remote, ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }).trim();
  git("update-ref", "refs/heads/sync-v1", base.head);
  const dbPath = join(dir, "inside.sqlite");
  {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(read(`internal-${label}.sql`));
    legacy.close();
  }
  command("initdb", [
    "-D",
    pgData,
    "-A",
    "trust",
    "-U",
    "postgres",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  command("pg_ctl", [
    "-D",
    pgData,
    "-l",
    join(dir, "pg.log"),
    "-o",
    `-k ${socket} -p ${port} -c listen_addresses=''`,
    "-w",
    "start",
  ]);
  pgStarted = true;
  const pool = (name) => {
    const created = new Pool({ connectionString: url(name) });
    pools.push(created);
    return created;
  };
  const admin = pool("postgres");
  await admin.query("CREATE DATABASE control");
  await admin.query("CREATE DATABASE team");
  for (const [name, file] of [
    ["control", "external-control.sql"],
    ["team", `external-team-${label}.sql`],
  ]) {
    const client = new Client({ connectionString: url(name) });
    await client.connect();
    await client.query(read(file));
    await client.end();
  }
  return {
    dir,
    remote,
    base,
    git,
    dbPath,
    url,
    admin,
    pool,
    team: pool("team"),
    // The tool reaches Git as the internal site does, through its own clone.
    transport: new GitCliTransport({
      directory: join(dir, "tool.git"),
      repository: remote,
      allowLocal: true,
    }),
  };
}
const teamVersion = async (team) =>
  Number(
    (
      await team.query(
        "SELECT MAX(version) v FROM graeboard.schema_migrations WHERE scope='team'",
      )
    ).rows[0].v,
  );
const sqliteVersion = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("PRAGMA user_version").get().user_version;
  } finally {
    db.close();
  }
};
const internalLink = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT mode,canonical_head,canonical_hash FROM team_sync_links WHERE team_id=?",
      )
      .get(teamId);
  } finally {
    db.close();
  }
};
// Every row of every table, to show that a stage rolled back left the data.
const sqliteRows = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const value = (v) =>
      v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v;
    return createHash("sha256")
      .update(
        canonical(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all()
            .map(({ name }) => [
              name,
              db
                .prepare(`SELECT * FROM "${name}"`)
                .all()
                .map((row) =>
                  Object.entries(row).map(([key, v]) => [key, value(v)]),
                ),
            ]),
        ),
      )
      .digest("hex");
  } finally {
    db.close();
  }
};
const pgEntities = async (team) =>
  (
    await team.query(
      "SELECT entity,entity_key,payload FROM graeboard.sync_entities WHERE team_id=$1 ORDER BY entity,entity_key",
      [teamId],
    )
  ).rows;
const stagesOf = (journal) =>
  Object.keys(JSON.parse(readFileSync(join(journal, "journal.json"))).stages);
const externalLink = async (team) =>
  (
    await team.query(
      "SELECT mode,canonical_head,canonical_hash FROM graeboard.team_sync_links WHERE team_id=$1",
      [teamId],
    )
  ).rows[0];

for (const [label, from, to, port] of [
  ["v1", 1, 3, 55473],
  ["v2", 2, 4, 55472],
])
  test(
    `f744ead sync ${label}: the stopped sites are cut over to protocol ${to} by the one-time tool, resume after each failed stage, start in turn and synchronize; a new site starts at the checkpoint`,
    { skip: !existsSync(join(pgBin, "initdb")), timeout: 300000 },
    async (t) => {
      const env0 = await released(t, label, port),
        { dir, remote, base, git, dbPath, url, team, transport } = env0;
      const historyBefore = git("rev-list", base.head),
        treeBefore = git("ls-tree", "-r", base.head),
        journal = join(dir, "journal"),
        options = {
          teamId,
          sqlitePath: dbPath,
          pool: team,
          pgScope: "team",
          transport,
          origins: ORIGINS,
          journalDir: journal,
        };

      // The dry-run converts copies and changes nothing.
      const before = sha(dbPath),
        preview = await runCutover({ ...options, dryRun: true });
      assert.equal(preview.plan.baseHead, base.head);
      assert.equal(preview.plan.baseHash, base.hash);
      assert.equal(preview.plan.fromProtocol, from);
      assert.equal(preview.plan.toProtocol, to);
      assert.equal(sha(dbPath), before);
      assert.equal(sqliteVersion(dbPath), 33);
      assert.equal(await teamVersion(team), 2);
      assert.equal(git("rev-parse", "refs/heads/sync-v1"), base.head);
      assert.equal(existsSync(journal), false);
      const resultHash = preview.plan.resultHash;

      // A failure inside the internal conversion's transaction (an injected
      // statement error on the shared state it rewrites): SQLite rolls back
      // to v33 with every row as it was, and the journal records no stage.
      const rowsBefore = sqliteRows(dbPath),
        fault = (sql) => {
          const db = new DatabaseSync(dbPath);
          try {
            db.exec(sql);
          } finally {
            db.close();
          }
        };
      await assert.rejects(
        runCutover({
          ...options,
          hooks: {
            before: async (name) => {
              if (name === "internal")
                fault(
                  "CREATE TRIGGER cutover_fault BEFORE UPDATE ON sync_entities BEGIN SELECT RAISE(ABORT,'injected internal fault'); END",
                );
            },
          },
        }),
        /injected internal fault/,
      );
      fault("DROP TRIGGER cutover_fault");
      assert.equal(sqliteVersion(dbPath), 33);
      assert.equal(sqliteRows(dbPath), rowsBefore);
      assert.equal(await teamVersion(team), 2);
      assert.deepEqual(stagesOf(journal), []);

      // A failure after the internal conversion: the external database and
      // Git are untouched, and the next run goes on from there.
      const crash = (stage) => ({
        after: async (name) => {
          if (name === stage) throw new Error("crash after " + stage);
        },
      });
      await assert.rejects(
        runCutover({ ...options, hooks: crash("internal") }),
        /crash after internal/,
      );
      assert.equal(sqliteVersion(dbPath), 34);
      assert.equal(await teamVersion(team), 2);
      assert.equal(git("rev-parse", "refs/heads/sync-v1"), base.head);
      assert.deepEqual(stagesOf(journal), ["internal"]);
      // A failure inside the external conversion's transaction: PostgreSQL
      // rolls back to team v2 with the shared state as it was, Git is
      // untouched, and the next run converts it.
      const entitiesBefore = await pgEntities(team);
      await assert.rejects(
        runCutover({
          ...options,
          hooks: {
            before: async (name) => {
              if (name === "external")
                await team.query(
                  "CREATE FUNCTION public.cutover_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected external fault'; END$$; CREATE TRIGGER cutover_fault BEFORE UPDATE ON graeboard.sync_entities FOR EACH ROW EXECUTE FUNCTION public.cutover_fault()",
                );
            },
          },
        }),
        /injected external fault/,
      );
      await team.query(
        "DROP TRIGGER cutover_fault ON graeboard.sync_entities; DROP FUNCTION public.cutover_fault()",
      );
      assert.equal(await teamVersion(team), 2);
      assert.deepEqual(await pgEntities(team), entitiesBefore);
      assert.equal(git("rev-parse", "refs/heads/sync-v1"), base.head);
      assert.deepEqual(stagesOf(journal), ["internal"]);
      // A failure after the boundary was published but before the journal
      // recorded it: the next run recognizes its own boundary.
      let lost = false;
      const losing = Object.create(transport);
      losing.publish = async (oid, expected) => {
        const published = await transport.publish(oid, expected);
        if (!lost && expected === base.head) {
          lost = true;
          throw new Error("connection lost after publication");
        }
        return published;
      };
      await assert.rejects(
        runCutover({ ...options, transport: losing }),
        /connection lost/,
      );
      assert.equal(await teamVersion(team), 3);
      const boundary = git("rev-parse", "refs/heads/sync-v1");
      assert.equal(git("rev-parse", boundary + "^"), base.head);
      // A failure after the internal cursor moved: the external one moves next.
      await assert.rejects(
        runCutover({ ...options, hooks: crash("internalCursor") }),
        /crash after internalCursor/,
      );
      const checkpoint = git("rev-parse", "refs/heads/sync-v1");
      assert.equal(git("rev-parse", checkpoint + "^"), boundary);
      assert.equal(internalLink(dbPath).canonical_head, checkpoint);
      assert.equal((await externalLink(team)).canonical_head, base.head);
      const done = await runCutover(options);
      assert.deepEqual(
        {
          baseHead: done.baseHead,
          boundary: done.boundary,
          checkpoint: done.checkpoint,
          resultHash: done.resultHash,
        },
        { baseHead: base.head, boundary, checkpoint, resultHash },
      );
      // Rerunning a finished journal changes nothing.
      await runCutover(options);
      for (const link of [internalLink(dbPath), await externalLink(team)])
        assert.deepEqual(
          { ...link },
          {
            mode: "paused",
            canonical_head: checkpoint,
            canonical_hash: resultHash,
          },
        );

      // Git: the old history is intact; the boundary records the converted
      // hash and the checkpoint is the standard one, of the converted state.
      assert.equal(git("rev-parse", "refs/heads/sync-v1"), checkpoint);
      assert.equal(git("rev-list", base.head), historyBefore);
      assert.equal(git("ls-tree", "-r", base.head), treeBefore);
      const added = (oid) =>
          git("diff-tree", "--no-commit-id", "--name-only", "-r", oid).split(
            "\n",
          ),
        event = (oid) =>
          JSON.parse(
            git(
              "show",
              `${oid}:${added(oid).find((p) => p.startsWith("events/"))}`,
            ),
          );
      assert.deepEqual(added(boundary).length, 1);
      const recorded = event(boundary);
      assert.deepEqual(
        Object.fromEntries(
          [
            "kind",
            "conversion",
            "protocol",
            "reducer",
            "fromProtocol",
            "teamId",
            "parent",
            "previousHash",
            "resultHash",
            "origins",
          ].map((key) => [key, recorded[key]]),
        ),
        {
          kind: BOUNDARY_KIND,
          conversion: "sheet-clone-1",
          protocol: to,
          reducer: to,
          fromProtocol: from,
          teamId,
          parent: base.head,
          previousHash: base.hash,
          resultHash,
          origins: [...ORIGINS].sort(),
        },
      );
      const envelope = event(checkpoint);
      assert.equal(envelope.kind, "checkpoint");
      assert.equal(envelope.checkpointVersion, 1);
      assert.equal(envelope.parent, boundary);
      assert.equal(envelope.atCommit, boundary);
      assert.equal(envelope.protocol, to);
      assert.equal(envelope.resultHash, resultHash);
      const snapshot = decodeSnapshot(
        execFileSync(
          "git",
          ["-C", remote, "show", `${checkpoint}:${envelope.path}`],
          {
            maxBuffer: 64 * 1024 * 1024,
          },
        ),
      );
      assert.equal(snapshot.atCommit, boundary);
      assert.equal(stateHash(snapshot.state), resultHash);
      assert.ok(
        !Object.values(snapshot.state.entities).some((r) =>
          r.entity.startsWith("report"),
        ),
      );

      // A copy of the converted internal database, kept for the recovery below.
      const restored = join(dir, "restored.sqlite");
      {
        const copy = new DatabaseSync(dbPath, { readOnly: true });
        copy.exec(`VACUUM INTO '${restored.replaceAll("'", "''")}'`);
        copy.close();
      }

      // The internal site starts first, then the external one.
      const github = githubEmulator(remote),
        nativeFetch = globalThis.fetch,
        work = [];
      globalThis.fetch = (input, init) => {
        const target = new URL(typeof input === "string" ? input : input.url);
        if (target.origin === "https://api.github.com")
          return github.fetch(target.href, init);
        assert.equal(target.hostname, "127.0.0.1", "unexpected live HTTP");
        return nativeFetch(input, init);
      };
      t.after(() => (globalThis.fetch = nativeFetch));
      const imagesDir = join(dir, "images");
      cpSync(new URL("images", FIXTURE).pathname, imagesDir, {
        recursive: true,
      });
      const db = openDatabase(dbPath);
      t.after(() => db.close());
      const app = createApp({
        db,
        rateLimits: false,
        documentImagesDir: imagesDir,
        syncOptions: {
          installationId: manifest.installations.internal,
          profiles: [
            {
              profileId: manifest.profiles.internal,
              teamId,
              repository: manifest.repository,
              peerInstallationId: manifest.installations.external,
            },
          ],
          transports: {
            [manifest.profiles.internal]: new GitCliTransport({
              directory: join(dir, "inside.git"),
              repository: remote,
              allowLocal: true,
            }),
          },
          schedule: false,
        },
      });
      const server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const token = randomUUID();
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
        createHash("sha256").update(token).digest("hex"),
        manifest.users.lead,
        Date.now() + 3600000,
      );
      const call = async (response) => {
        const text = await response.text();
        let data = text;
        try {
          data = unpack(JSON.parse(text));
        } catch {}
        return { status: response.status, data };
      };
      const inside = async (path, body, method = body ? "POST" : "GET") =>
        call(
          await nativeFetch(
            `http://127.0.0.1:${server.address().port}/api${path}`,
            {
              method,
              headers: {
                cookie: "weekly_session=" + token,
                "X-Requested-With": "WeeklyPlan",
                "Content-Type": "application/json",
              },
              ...(body ? { body: JSON.stringify(body) } : {}),
            },
          ),
        );
      const external = (pgControl, pgTeam) => {
        const env = {
          APP_ORIGIN: manifest.origins.external,
          ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
          ACCESS_AUDIENCE: "fixture",
          SETUP_TOKEN: "fixture-setup-token-with-enough-entropy",
          INSTALLATION_ID: manifest.installations.external,
          PEER_INSTALLATION_ID: manifest.installations.internal,
          PG_CONTROL: { connectionString: url(pgControl) },
          PG_TEAM: { connectionString: url(pgTeam) },
          R2_TEAM: bucket(),
          GIT_TOKEN: "fixture-secret",
          SYNC_PROFILES: JSON.stringify([
            {
              profileId: manifest.profiles.external,
              teamId,
              repository: manifest.repository,
              databaseBinding: "PG_TEAM",
              bucketBinding: "R2_TEAM",
              githubSecret: "GIT_TOKEN",
            },
          ]),
        };
        const worker = createWorker({
          verify: async () => ({
            issuer: env.ACCESS_ISSUER,
            subject: "external-subject",
            email: "outside@example.com",
            expiresAt: Date.now() + 3600000,
          }),
        });
        const send = async (path, body, method = body ? "POST" : "GET") =>
          call(
            await worker.fetch(
              new Request(env.APP_ORIGIN + "/api" + path, {
                method,
                headers: {
                  "X-Requested-With": "WeeklyPlan",
                  "Content-Type": "application/json",
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
              }),
              env,
              { waitUntil: (promise) => work.push(promise) },
            ),
          );
        return { env, send };
      };
      const flush = async () => {
        for (let i = 0; i < work.length; i++) await work[i];
        work.length = 0;
      };
      const { env, send: outside } = external("control", "team"),
        pgStore = new PostgresDatabase(team, { teamId });
      const converge = async () => {
        for (let i = 0; i < 4; i++) {
          await flush();
          if ((await pgStore.readLink(teamId))?.mode === "active")
            await runTeam(
              env,
              profileFor(env, manifest.profiles.external, teamId),
            );
          await app.locals.sync.get(teamId).run();
        }
        await flush();
      };
      for (const [send, site] of [
        [inside, "internal"],
        [outside, "external"],
      ]) {
        const status = ok(await send(`/teams/${teamId}/sync`));
        assert.equal(status.mode, "paused", site);
        assert.equal(status.protocol, to, site);
        assert.equal(status.canonicalHead, checkpoint, site);
        assert.equal(status.pending, 0, site);
        assert.equal(status.conflicts, 0, site);
        assert.equal("conversion" in status, false, site);
        ok(await send(`/teams/${teamId}/sync/resume`, {}));
      }
      await converge();
      assert.equal(
        app.locals.sync.store(teamId).readLink().canonical_head,
        checkpoint,
      );

      // The retry record of the copy the external site created before the
      // cutover carries the new key with its recorded hash: the same creation
      // from a new session is refused, never applied twice.
      assert.equal(
        (
          await team.query(
            "SELECT COUNT(*)::int n FROM graeboard.site_operations WHERE op_id=$1",
            ["sheet-clone-create:" + R5],
          )
        ).rows[0].n,
        1,
      );
      const clones = ok(await outside(`/sheet-clones?teamId=${teamId}`))
          .sheetClones.length,
        created = ok(await outside(`/sheet-clones/${R5}`));
      const again = await outside("/sheet-clones", {
        id: R5,
        teamId,
        year: created.year,
        name: created.name,
        referenceDate: created.referenceDate,
        view: created.view,
        taskIds: [T1],
      });
      assert.equal(again.status, 409, JSON.stringify(again));
      assert.equal(
        ok(await outside(`/sheet-clones?teamId=${teamId}`)).sheetClones.length,
        clones,
      );
      // R2 is edited on one site and then on the other. (Under protocol 3 a
      // copy is one record: f744ead already left R1 and R5 of this history with
      // a local row count and people list that differ from C, so their next
      // whole-copy edit is kept as a conflict before and after the cutover.)
      const editBody = (current, value, expectedVersion = 0) => ({
        operationId: randomUUID(),
        revision: current.revision,
        operations: [
          {
            kind: "cells",
            at: new Date().toISOString(),
            changes: [
              { taskId: T1, key: "2026-11-02", expectedVersion, value },
            ],
          },
        ],
      });
      ok(
        await inside(
          `/sheet-clones/${R2}`,
          editBody(ok(await inside(`/sheet-clones/${R2}`)), "사내 전환 후"),
          "PATCH",
        ),
      );
      await converge();
      const externalClone = ok(await outside(`/sheet-clones/${R2}`)),
        externalCell = externalClone.tasks.find((task) => task.id === T1).cells[
          "2026-11-02"
        ];
      assert.equal(externalCell.value, "사내 전환 후");
      ok(
        await outside(
          `/sheet-clones/${R2}`,
          editBody(externalClone, "외부 전환 후", externalCell.version),
          "PATCH",
        ),
      );
      await converge();
      assert.equal(
        ok(await inside(`/sheet-clones/${R2}`)).tasks.find(
          (task) => task.id === T1,
        ).cells["2026-11-02"].value,
        "외부 전환 후",
      );
      for (const send of [inside, outside])
        assert.equal(ok(await send(`/teams/${teamId}/sync`)).conflicts, 0);
      // A converted document link opens on both sites and a new one travels.
      const path = `/links/sheet-clone-task/${R1}/${T4}`,
        titles = async (send) =>
          ok(
            await send(
              `/document-links?${new URLSearchParams({ links: path })}`,
            ),
          ).links.map((l) => l.title);
      assert.deepEqual(await titles(inside), ["사본에서 추가한 행"]);
      assert.deepEqual(await titles(outside), ["사본에서 추가한 행"]);
      const documentPath = `/sheet-clones/${R5}/tasks/${T1}/document`,
        current = ok(await outside(documentPath));
      assert.match(
        current.markdown,
        new RegExp(`/links/sheet-clone-task/${R1}/${T1}`),
      );
      ok(
        await outside(
          documentPath,
          {
            operationId: randomUUID(),
            expectedRevision: current.revision,
            markdown: current.markdown + `\n\n[새 링크](${path})`,
          },
          "PUT",
        ),
      );
      await converge();
      assert.match(
        ok(await inside(documentPath)).markdown,
        new RegExp(`\\[새 링크\\]\\(${path}\\)`),
      );
      // The ordinary protocol 3 → 4 upgrade after the cutover: the newest
      // snapshot is then that transition, and new and recovering sites still
      // start at the cutover checkpoint and replay the transition after it.
      let transition, afterTransition;
      if (from === 1) {
        for (const send of [inside, outside])
          ok(await send(`/teams/${teamId}/sync/pause`, {}));
        const expectedHead = app.locals.sync
            .store(teamId)
            .readLink().canonical_head,
          expectedHash = stateHash(app.locals.sync.store(teamId).readState());
        for (const send of [inside, outside])
          ok(
            await send(`/teams/${teamId}/sync/upgrade`, {
              expectedHead,
              expectedHash,
              peersStopped: true,
            }),
          );
        for (const send of [inside, outside])
          ok(await send(`/teams/${teamId}/sync/resume`, {}));
        await converge();
        transition = git("rev-parse", "refs/heads/sync-v1");
        assert.equal(git("rev-parse", transition + "^"), expectedHead);
        assert.equal(
          git("log", "-1", "--format=%H", transition, "--", "snapshots"),
          transition,
        );
        for (const send of [inside, outside])
          assert.equal(ok(await send(`/teams/${teamId}/sync`)).protocol, 4);
        // Edits after it, with a copy of the internal database between them
        // for the recovery below.
        const editCell = async (send, value) => {
          const current = ok(await send(`/sheet-clones/${R2}`)),
            cell = current.tasks.find((task) => task.id === T1).cells[
              "2026-11-02"
            ];
          ok(
            await send(
              `/sheet-clones/${R2}`,
              editBody(current, value, cell.version),
              "PATCH",
            ),
          );
          await converge();
        };
        await editCell(inside, "프로토콜 4 사내");
        afterTransition = join(dir, "after-transition.sqlite");
        {
          const copy = new DatabaseSync(dbPath, { readOnly: true });
          copy.exec(`VACUUM INTO '${afterTransition.replaceAll("'", "''")}'`);
          copy.close();
          // Taken from the running site: marked as npm run restore marks it.
          const restoredCopy = new DatabaseSync(afterTransition);
          restoredCopy
            .prepare(
              "UPDATE team_sync_links SET mode='recovery',lease_owner=NULL,lease_until=NULL WHERE team_id=?",
            )
            .run(teamId);
          restoredCopy.close();
        }
        await editCell(outside, "프로토콜 4 외부");
        assert.equal(
          ok(await inside(`/sheet-clones/${R2}`)).tasks.find(
            (task) => task.id === T1,
          ).cells["2026-11-02"].value,
          "프로토콜 4 외부",
        );
      }
      const internalHead = app.locals.sync
        .store(teamId)
        .readLink().canonical_head;
      assert.equal(
        (await pgStore.readLink(teamId)).canonical_head,
        internalHead,
      );
      assert.equal(
        stateHash(app.locals.sync.store(teamId).readState()),
        stateHash(await pgStore.readState(teamId)),
      );
      assert.equal(git("rev-list", base.head), historyBefore);

      // A new external site imports the team from the checkpoint: it never
      // reads a commit or snapshot before it, so no earlier name reaches it.
      const old = new Set(
        git("rev-list", base.head).split("\n").filter(Boolean),
      );
      // Events and snapshots of the earlier history (manifest and images are
      // content-addressed and shared with the new history).
      const oldRecords = new Set(
        git("ls-tree", "-r", base.head)
          .split("\n")
          .filter((line) => /\t(events|snapshots)\//.test(line))
          .map((line) => line.split(/\s+/)[2]),
      );
      await env0.admin.query("CREATE DATABASE control2");
      await env0.admin.query("CREATE DATABASE fresh");
      {
        const client = new Client({ connectionString: url("control2") });
        await client.connect();
        await client.query(read("external-control.sql"));
        await client.end();
      }
      const control2 = env0.pool("control2"),
        fresh = env0.pool("fresh");
      await control2.query(
        "UPDATE graeboard.teams SET status='unconnected' WHERE id=$1",
        [teamId],
      );
      await migratePostgres(fresh, {
        scope: "team",
        teamId,
        teamName: "사본 전환 fixture",
        initialize: true,
      });
      const newcomer = external("control2", "fresh"),
        calls = github.calls.length;
      // One call applies a bounded number of commits; the same import
      // continues from where the last one stopped.
      let imported;
      for (let call = 0; call < 5 && imported?.phase !== "complete"; call++) {
        imported = ok(
          await newcomer.send("/admin/sync/import", {
            teamId,
            profileId: manifest.profiles.external,
          }),
        );
        await flush();
      }
      assert.equal(imported.phase, "complete");
      const freshStore = new PostgresDatabase(fresh, { teamId });
      assert.equal(
        (await freshStore.readLink(teamId)).canonical_head,
        internalHead,
      );
      assert.equal(
        stateHash(await freshStore.readState(teamId)),
        stateHash(await pgStore.readState(teamId)),
      );
      const reads = github.calls.slice(calls).map((c) => c.path);
      assert.ok(reads.length > 0);
      for (const read of reads) {
        const oid = /^\/git\/(?:commits|blobs)\/([a-f0-9]{40})/.exec(read)?.[1];
        if (!oid) continue;
        // The boundary's parent is read for its file list only.
        assert.ok(!old.has(oid) || oid === base.head, read);
        assert.ok(!oldRecords.has(oid), read);
      }
      assert.equal(
        ok(await newcomer.send(`/sheet-clones/${R2}`)).tasks.find(
          (task) => task.id === T1,
        ).cells["2026-11-02"].value,
        from === 1 ? "프로토콜 4 외부" : "외부 전환 후",
      );

      // A copy restored for recovery reconciles from its own head on to the
      // current head, whichever snapshot is the newest.
      const recoverCopy = async (path, name, options = {}) => {
        const db = openDatabase(path);
        t.after(() => db.close());
        const head = db
            .prepare(
              "SELECT canonical_head FROM team_sync_links WHERE team_id=?",
            )
            .get(teamId).canonical_head,
          run = (extra) =>
            recoverSync({
              db,
              teamId,
              installationId: randomUUID(),
              profiles: [
                {
                  profileId: manifest.profiles.internal,
                  teamId,
                  repository: manifest.repository,
                },
              ],
              imagesDir: join(dir, name + "-images"),
              confirmDrained: true,
              transports: {
                [manifest.profiles.internal]: new GitCliTransport({
                  directory: join(dir, name + ".git"),
                  repository: remote,
                  allowLocal: true,
                }),
              },
              ...options,
              ...extra,
            });
        return { db, head, run };
      };
      const converted = await recoverCopy(restored, "recovered");
      assert.equal(converted.head, checkpoint);
      if (from === 1) {
        // Restored after the transition and behind the head: it replays the
        // later edit from its own head.
        const later = await recoverCopy(afterTransition, "recovered-later");
        assert.notEqual(later.head, internalHead);
        assert.equal(
          git("merge-base", "--is-ancestor", transition, later.head),
          "",
        );
        assert.equal((await later.run()).canonicalHead, internalHead);
        // The copy from before the transition: its rows hold local changes C
        // never recorded (f744ead left R1 and R5 so), which recovery keeps as
        // a command, and no command crosses a protocol transition. It stops
        // there and keeps that command and its rows.
        const { uncapturedChanges } = await converted.run({ dryRun: true });
        assert.ok(uncapturedChanges > 0);
        await assert.rejects(converted.run(), (error) => {
          assert.equal(error.code, "SYNC_TRANSITION_PENDING");
          return true;
        });
        const link = converted.db
          .prepare(
            "SELECT mode,canonical_head FROM team_sync_links WHERE team_id=?",
          )
          .get(teamId);
        assert.equal(link.mode, "recovery");
        assert.notEqual(link.canonical_head, internalHead);
        assert.equal(
          converted.db
            .prepare(
              "SELECT COUNT(*) n FROM sync_outbox WHERE team_id=? AND status<>'acknowledged'",
            )
            .get(teamId).n,
          1,
        );
      } else assert.equal((await converted.run()).canonicalHead, internalHead);

      // A command of an earlier protocol appended by an unconverted writer is
      // never applied: the cursor stays and nothing changes.
      const stray = {
        protocol: from,
        kind: "operations",
        parent: internalHead,
        operations: [],
        resultHash: "0".repeat(64),
      };
      const blobId = execFileSync(
          "git",
          ["-C", remote, "hash-object", "-w", "--stdin"],
          { input: canonical(stray), encoding: "utf8" },
        ).trim(),
        index = join(dir, "stray.index");
      const gitEnv = { ...process.env, GIT_INDEX_FILE: index };
      execFileSync("git", ["-C", remote, "read-tree", internalHead], {
        env: gitEnv,
      });
      execFileSync(
        "git",
        [
          "-C",
          remote,
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${blobId},events/${randomUUID()}.json`,
        ],
        { env: gitEnv },
      );
      const strayTree = execFileSync("git", ["-C", remote, "write-tree"], {
          env: gitEnv,
          encoding: "utf8",
        }).trim(),
        strayCommit = execFileSync(
          "git",
          [
            "-C",
            remote,
            "commit-tree",
            strayTree,
            "-p",
            internalHead,
            "-m",
            "legacy",
          ],
          {
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "x",
              GIT_AUTHOR_EMAIL: "x@x",
              GIT_COMMITTER_NAME: "x",
              GIT_COMMITTER_EMAIL: "x@x",
            },
            encoding: "utf8",
          },
        ).trim();
      git("update-ref", "refs/heads/sync-v1", strayCommit, internalHead);
      const kept = stateHash(app.locals.sync.store(teamId).readState());
      await assert.rejects(
        () => app.locals.sync.get(teamId).run(),
        /protocol/i,
      );
      assert.equal(
        app.locals.sync.store(teamId).readLink().canonical_head,
        internalHead,
      );
      assert.equal(stateHash(app.locals.sync.store(teamId).readState()), kept);
    },
  );

test(
  "the cutover refuses before any change when Git or a site moved, and stops without hiding a change made between its stages",
  { skip: !existsSync(join(pgBin, "initdb")), timeout: 300000 },
  async (t) => {
    const env0 = await released(t, "v2", 55474),
      { dir, base, git, dbPath, team, transport, remote } = env0,
      options = {
        teamId,
        sqlitePath: dbPath,
        pool: team,
        pgScope: "team",
        transport,
        origins: ORIGINS,
      };
    // Another writer's commit on the recorded head: refused, nothing written.
    const commit = (parent) => {
      const index = join(dir, randomUUID() + ".index"),
        gitEnv = { ...process.env, GIT_INDEX_FILE: index };
      execFileSync("git", ["-C", remote, "read-tree", parent], { env: gitEnv });
      const tree = execFileSync("git", ["-C", remote, "write-tree"], {
        env: gitEnv,
        encoding: "utf8",
      }).trim();
      return execFileSync(
        "git",
        ["-C", remote, "commit-tree", tree, "-p", parent, "-m", "other"],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "x",
            GIT_AUTHOR_EMAIL: "x@x",
            GIT_COMMITTER_NAME: "x",
            GIT_COMMITTER_EMAIL: "x@x",
          },
          encoding: "utf8",
        },
      ).trim();
    };
    const other = commit(base.head);
    git("update-ref", "refs/heads/sync-v1", other, base.head);
    const bytes = sha(dbPath);
    await assert.rejects(
      runCutover({ ...options, journalDir: join(dir, "j1") }),
      /remote head .* is not the head both sites recorded/,
    );
    assert.equal(sha(dbPath), bytes);
    assert.equal(await teamVersion(team), 2);
    assert.equal(git("rev-parse", "refs/heads/sync-v1"), other);
    git("update-ref", "refs/heads/sync-v1", base.head, other);

    // A site that is not stopped: refused before any change.
    await team.query(
      "UPDATE graeboard.team_sync_links SET mode='active' WHERE team_id=$1",
      [teamId],
    );
    await assert.rejects(
      runCutover({ ...options, journalDir: join(dir, "j2") }),
      /synchronization is active/,
    );
    assert.equal(sha(dbPath), bytes);
    assert.equal(await teamVersion(team), 2);
    await team.query(
      "UPDATE graeboard.team_sync_links SET mode='paused' WHERE team_id=$1",
      [teamId],
    );

    // A commit published after both conversions: the cutover stops at the
    // boundary, shows that head and leaves it as it is.
    const journalDir = join(dir, "j3");
    await assert.rejects(
      runCutover({
        ...options,
        journalDir,
        hooks: {
          before: async (name) => {
            if (name === "boundary")
              git(
                "update-ref",
                "refs/heads/sync-v1",
                commit(base.head),
                base.head,
              );
          },
        },
      }),
      /remote head moved to [a-f0-9]{40}, which this cutover did not publish/,
    );
    assert.notEqual(git("rev-parse", "refs/heads/sync-v1"), base.head);
    assert.equal(internalLink(dbPath).canonical_head, base.head);
    assert.equal((await externalLink(team)).canonical_head, base.head);

    // Saved after its conversion (a site started too early): the cursor stage
    // refuses and keeps the command.
    const second = await released(t, "v2", 55475),
      journal4 = join(second.dir, "j4"),
      opts4 = {
        ...options,
        sqlitePath: second.dbPath,
        pool: second.team,
        transport: second.transport,
        journalDir: journal4,
      };
    await assert.rejects(
      runCutover({
        ...opts4,
        hooks: {
          before: async (name) => {
            if (name !== "externalCursor") return;
            await second.team.query(
              "INSERT INTO graeboard.sync_outbox(op_id,team_id,payload,payload_hash,status,created_at) VALUES($1,$2,'{}',NULL,'pending',$3)",
              [randomUUID(), teamId, new Date().toISOString()],
            );
          },
        },
      }),
      /external: 1 commands were saved after conversion/,
    );
    assert.equal(
      (await externalLink(second.team)).canonical_head,
      second.base.head,
    );
    assert.equal(
      Number(
        (
          await second.team.query(
            "SELECT COUNT(*) n FROM graeboard.sync_outbox WHERE status='pending'",
          )
        ).rows[0].n,
      ),
      1,
    );
  },
);

test("the application, the worker and the permanent scripts neither import the one-time tool nor keep cutover tracking", () => {
  const root = new URL("../../../", import.meta.url).pathname,
    files = execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "server",
        "worker",
        "shared",
        "src",
        "scripts",
      ],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter((file) => /\.(mjs|js|ts|tsx|sql)$/.test(file));
  assert.ok(files.length > 100);
  const found = [];
  for (const file of files) {
    if (!existsSync(join(root, file))) continue;
    const text = readFileSync(join(root, file), "utf8");
    for (const pattern of [
      /sheet-clone-cutover\//,
      /\bsync_conversions\b/,
      /\bdata_conversions\b/,
      /readConversion|completeConversion/,
    ])
      if (pattern.test(text)) found.push(`${file}: ${pattern}`);
  }
  assert.deepEqual(found, []);
});
