// The cutover of one team synchronized between the internal SQLite site and
// the external PostgreSQL site through one Git repository, from the databases
// and history the released f744ead code wrote (sync protocol 2 at its head).
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
import { openDatabase } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { unpack } from "../shared/compact.js";
import { migrateSqlite } from "../server/migrations/sqlite.mjs";
import { migratePostgres } from "../server/migrations/postgres.mjs";
import {
  sqliteSheetCloneConversion,
  postgresSheetCloneConversion,
} from "../server/migrations/sheet-clone/convert.mjs";
import { GitCliTransport } from "../server/sync/git-cli.mjs";
import {
  CONVERSION_PENDING_MESSAGE,
  canonical,
  stateHash,
} from "../server/sync/protocol.mjs";
import { decodeSnapshot } from "../server/sync/snapshot.mjs";
import { PostgresDatabase } from "../worker/storage/postgres.mjs";
import { createWorker } from "../worker/entry.mjs";
import { runTeam } from "../worker/sync.mjs";
import { profileFor } from "../shared/sync-profiles.js";
import { githubEmulator, bucket } from "./worker-github-fixture.mjs";

const { Pool, Client } = pg;
const pgBin = process.env.TEST_PG_BIN || "/tmp/graeboard-pg18/bin",
  FIXTURE = new URL("./fixtures/sheet-clone-legacy/", import.meta.url),
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

for (const [label, from, to, port] of [
  ["v1", 1, 3, 55473],
  ["v2", 2, 4, 55472],
])
  test(
    `f744ead sync ${label} team converts on both sites and cuts over through one Git transition commit to protocol ${to}, then synchronizes both ways`,
    { skip: !existsSync(join(pgBin, "initdb")), timeout: 240000 },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "gb-sheet-clone-transition-")),
        remote = join(dir, "remote.git"),
        socket = join(dir, "socket"),
        pgData = join(dir, "pg"),
        nativeFetch = globalThis.fetch,
        pools = [],
        work = [];
      mkdirSync(socket);
      let pgStarted = false,
        server,
        db;
      const command = (bin, args) => {
          const r = spawnSync(join(pgBin, bin), args, { encoding: "utf8" });
          assert.equal(r.status, 0, r.stdout + r.stderr);
        },
        url = (name) =>
          `postgresql://postgres@localhost/${name}?host=${encodeURIComponent(socket)}&port=${port}`;
      t.after(async () => {
        globalThis.fetch = nativeFetch;
        await new Promise((resolve) =>
          server ? server.close(resolve) : resolve(),
        );
        db?.close();
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
      // The repository as both sites left it, untouched.
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
          }).trim();
      // Both sites stopped at this head; later commits of the fixture history
      // do not exist for them.
      git("update-ref", "refs/heads/sync-v1", base.head);
      const historyBefore = git("rev-list", base.head),
        treeBefore = git("ls-tree", "-r", base.head);

      // Internal: the released v33 database, converted offline to v34.
      const dbPath = join(dir, "inside.sqlite");
      {
        const legacy = new DatabaseSync(dbPath);
        legacy.exec(read(`internal-${label}.sql`));
        legacy.exec("PRAGMA foreign_keys=ON");
        migrateSqlite(legacy, {
          convert: sqliteSheetCloneConversion({ origins: ORIGINS }),
        });
        legacy.close();
      }
      // External: the released team v2 database, converted offline to team v3.
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
      const admin = new Pool({ connectionString: url("postgres") });
      pools.push(admin);
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
      const team = new Pool({ connectionString: url("team") }),
        control = new Pool({ connectionString: url("control") });
      pools.push(team, control);
      const converted = await migratePostgres(team, {
        scope: "team",
        teamId,
        convert: postgresSheetCloneConversion({ origins: ORIGINS }),
      });
      assert.equal(converted.to, 3);
      const pgStore = new PostgresDatabase(team, { teamId });

      // Both converted the same C independently.
      db = openDatabase(dbPath);
      const internalConversion = db
          .prepare("SELECT * FROM sync_conversions")
          .get(),
        externalConversion = (
          await team.query("SELECT * FROM graeboard.sync_conversions")
        ).rows[0];
      for (const conversion of [internalConversion, externalConversion]) {
        assert.equal(conversion.base_head, base.head);
        assert.equal(conversion.base_hash, base.hash);
        assert.equal(Number(conversion.from_protocol), from);
        assert.equal(Number(conversion.to_protocol), to);
        assert.equal(conversion.completed_head, null);
      }
      assert.equal(
        externalConversion.result_hash,
        internalConversion.result_hash,
      );

      // The released applications' identities, with this release's code.
      const github = githubEmulator(remote);
      globalThis.fetch = (input, init) => {
        const target = new URL(typeof input === "string" ? input : input.url);
        if (target.origin === "https://api.github.com")
          return github.fetch(target.href, init);
        assert.equal(target.hostname, "127.0.0.1", "unexpected live HTTP");
        return nativeFetch(input, init);
      };
      const imagesDir = join(dir, "images");
      cpSync(new URL("images", FIXTURE).pathname, imagesDir, {
        recursive: true,
      });
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
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
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
      const env = {
          APP_ORIGIN: manifest.origins.external,
          ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
          ACCESS_AUDIENCE: "fixture",
          SETUP_TOKEN: "fixture-setup-token-with-enough-entropy",
          INSTALLATION_ID: manifest.installations.external,
          PEER_INSTALLATION_ID: manifest.installations.internal,
          PG_CONTROL: { connectionString: url("control") },
          PG_TEAM: { connectionString: url("team") },
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
        },
        worker = createWorker({
          verify: async () => ({
            issuer: env.ACCESS_ISSUER,
            subject: "external-subject",
            email: "outside@example.com",
            expiresAt: Date.now() + 3600000,
          }),
        });
      const outside = async (path, body, method = body ? "POST" : "GET") =>
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
      const flush = async () => {
        for (let i = 0; i < work.length; i++) await work[i];
        work.length = 0;
      };
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

      // Before the transition commit: both report the conversion, no site
      // takes a write and neither resumes. None of this reads the earlier
      // snapshot the conversion keeps; only publishing the transition does.
      const traced = [],
        clientQuery = Client.prototype.query;
      Client.prototype.query = function (text, ...rest) {
        traced.push(typeof text === "string" ? text : text?.text);
        return clientQuery.call(this, text, ...rest);
      };
      t.after(() => (Client.prototype.query = clientQuery));
      const snapshotReads = () =>
        traced.filter((sql) =>
          /\bprevious_snapshot\b|sync_conversions\b[^;]*\*|\*[^;]*sync_conversions\b/.test(
            sql || "",
          ),
        );
      const internalStatus = ok(await inside(`/teams/${teamId}/sync`)),
        externalStatus = ok(await outside(`/teams/${teamId}/sync`));
      for (const status of [internalStatus, externalStatus]) {
        assert.equal(status.mode, "paused");
        assert.equal(status.protocol, to);
        assert.equal(status.canonicalHead, base.head);
        assert.equal(status.pending, 0);
        assert.equal(status.conflicts, 0);
        assert.deepEqual(
          { ...status.conversion, completedAt: undefined },
          {
            conversion: "sheet-clone-1",
            fromProtocol: from,
            toProtocol: to,
            baseHead: base.head,
            baseHash: base.hash,
            resultHash: internalConversion.result_hash,
            completedHead: null,
            completedAt: undefined,
          },
        );
      }
      const clone = ok(await inside(`/sheet-clones/${R1}`));
      const editBody = (current, value) => ({
        operationId: randomUUID(),
        revision: current.revision,
        operations: [
          {
            kind: "cells",
            at: new Date().toISOString(),
            changes: [
              { taskId: T1, key: "2026-11-02", expectedVersion: 0, value },
            ],
          },
        ],
      });
      const blocked = await inside(
        `/sheet-clones/${R1}`,
        editBody(clone, "too early"),
        "PATCH",
      );
      assert.equal(blocked.status, 409, JSON.stringify(blocked));
      const externalClone = ok(await outside(`/sheet-clones/${R1}`));
      assert.equal(
        (
          await outside(
            `/sheet-clones/${R1}`,
            editBody(externalClone, "too early"),
            "PATCH",
          )
        ).status,
        409,
      );
      assert.equal(
        (await inside(`/teams/${teamId}/sync/resume`, {})).status,
        409,
      );
      assert.equal(
        (await outside(`/teams/${teamId}/sync/resume`, {})).status,
        409,
      );
      assert.ok(traced.some((sql) => /\bsync_conversions\b/.test(sql || "")));
      assert.deepEqual(snapshotReads(), []);
      // Nor does a disconnected site reconnect ahead of the transition: its
      // differences from C would be enqueued and published before it.
      const local = () =>
        JSON.stringify([
          db.prepare("SELECT * FROM sync_outbox ORDER BY local_seq").all(),
          db
            .prepare(
              "SELECT mode,generation,canonical_head FROM team_sync_links WHERE team_id=?",
            )
            .get(teamId),
        ]);
      db.prepare(
        "UPDATE team_sync_links SET mode='disconnected' WHERE team_id=?",
      ).run(teamId);
      app.locals.sync.capture.refresh();
      const disconnected = local(),
        reconnect = await inside(`/teams/${teamId}/sync/reconnect`, {});
      assert.equal(reconnect.status, 409, JSON.stringify(reconnect));
      assert.equal(reconnect.data.error, CONVERSION_PENDING_MESSAGE);
      assert.equal(local(), disconnected);
      db.prepare(
        "UPDATE team_sync_links SET mode='paused' WHERE team_id=?",
      ).run(teamId);
      app.locals.sync.capture.refresh();
      // A wrong expectation changes nothing.
      const confirmation = {
        expectedHead: base.head,
        expectedHash: internalConversion.result_hash,
        peersStopped: true,
      };
      assert.equal(
        (
          await outside(`/teams/${teamId}/sync/upgrade`, {
            ...confirmation,
            expectedHash: base.hash,
          })
        ).status,
        409,
      );
      assert.equal(git("rev-parse", "refs/heads/sync-v1"), base.head);

      // External first, then internal, as OPERATIONS.md describes.
      traced.length = 0;
      const published = ok(
        await outside(`/teams/${teamId}/sync/upgrade`, confirmation),
      );
      assert.deepEqual(snapshotReads(), [
        "SELECT previous_snapshot FROM sync_conversions WHERE team_id=$1 AND completed_head IS NULL",
      ]);
      Client.prototype.query = clientQuery;
      assert.equal(published.upgraded, true);
      assert.equal(published.protocol, to);
      assert.equal(published.conversion, "sheet-clone-1");
      const received = ok(
        await inside(`/teams/${teamId}/sync/upgrade`, confirmation),
      );
      assert.equal(received.received, true);
      assert.equal(received.head, published.head);
      assert.equal(received.stateHash, published.stateHash);
      assert.equal(published.stateHash, internalConversion.result_hash);

      // The transition commit: one child of the old head, carrying the old C as
      // published and the converted C. Every earlier commit and file is intact.
      const head = git("rev-parse", "refs/heads/sync-v1");
      assert.equal(head, published.head);
      assert.equal(git("rev-parse", head + "^"), base.head);
      assert.equal(git("rev-list", base.head), historyBefore);
      assert.equal(git("ls-tree", "-r", base.head), treeBefore);
      const added = git(
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          head,
        ).split("\n"),
        eventPath = added.find((path) => path.startsWith("events/")),
        envelope = JSON.parse(git("show", `${head}:${eventPath}`));
      assert.deepEqual(
        {
          kind: envelope.kind,
          conversion: envelope.conversion,
          protocol: envelope.protocol,
          reducer: envelope.reducer,
          fromProtocol: envelope.fromProtocol,
          parent: envelope.parent,
          previousHash: envelope.previousHash,
          resultHash: envelope.resultHash,
        },
        {
          kind: "transition",
          conversion: "sheet-clone-1",
          protocol: to,
          reducer: to,
          fromProtocol: from,
          parent: base.head,
          previousHash: base.hash,
          resultHash: internalConversion.result_hash,
        },
      );
      const blob = (path) =>
        execFileSync("git", ["-C", remote, "show", `${head}:${path}`], {
          maxBuffer: 64 * 1024 * 1024,
        });
      const previous = decodeSnapshot(blob(envelope.previousPath)),
        next = decodeSnapshot(blob(envelope.path));
      assert.equal(stateHash(previous.state), base.hash);
      assert.equal(stateHash(next.state), internalConversion.result_hash);
      assert.ok(
        Object.values(previous.state.entities).some(
          (r) => r.entity === (label === "v1" ? "report" : "reportCell"),
        ),
      );
      assert.ok(
        !Object.values(next.state.entities).some((r) =>
          r.entity.startsWith("report"),
        ),
      );
      assert.equal(
        db.prepare("SELECT completed_head FROM sync_conversions").get()
          .completed_head,
        head,
      );
      assert.equal(
        (
          await team.query(
            "SELECT completed_head FROM graeboard.sync_conversions",
          )
        ).rows[0].completed_head,
        head,
      );

      // The retry record of the copy the external site created before the
      // cutover now carries the new key with its recorded hash: the same
      // creation from a new session is refused, never applied twice.
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
      // Resumed, the sites exchange ordinary commands of the new protocol.
      ok(await inside(`/teams/${teamId}/sync/resume`, {}));
      ok(await outside(`/teams/${teamId}/sync/resume`, {}));
      // R2 is edited on one site and then on the other. (Under protocol 3 a
      // copy is one record: f744ead already left R1 and R5 of this history with
      // a local row count and people list that differ from C, so their next
      // whole-copy edit is kept as a conflict before and after the conversion.)
      ok(
        await inside(
          `/sheet-clones/${R2}`,
          editBody(ok(await inside(`/sheet-clones/${R2}`)), "사내 변환 후"),
          "PATCH",
        ),
      );
      await converge();
      assert.equal(
        ok(await outside(`/sheet-clones/${R2}`)).tasks.find(
          (task) => task.id === T1,
        ).cells["2026-11-02"].value,
        "사내 변환 후",
      );
      const outsideEdit = {
        ...editBody(ok(await outside(`/sheet-clones/${R2}`)), "외부 변환 후"),
      };
      outsideEdit.operations[0].changes[0].expectedVersion = ok(
        await outside(`/sheet-clones/${R2}`),
      ).tasks.find((task) => task.id === T1).cells["2026-11-02"].version;
      ok(await outside(`/sheet-clones/${R2}`, outsideEdit, "PATCH"));
      await converge();
      assert.equal(
        ok(await inside(`/sheet-clones/${R2}`)).tasks.find(
          (task) => task.id === T1,
        ).cells["2026-11-02"].value,
        "외부 변환 후",
      );
      for (const status of [
        ok(await inside(`/teams/${teamId}/sync`)),
        ok(await outside(`/teams/${teamId}/sync`)),
      ])
        assert.equal(status.conflicts, 0);
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

      // A command of the earlier protocol appended by an unconverted writer is
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
          {
            input: canonical(stray),
            encoding: "utf8",
          },
        ).trim(),
        index = join(dir, "stray.index");
      execFileSync("git", ["-C", remote, "read-tree", internalHead], {
        env: { ...process.env, GIT_INDEX_FILE: index },
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
        { env: { ...process.env, GIT_INDEX_FILE: index } },
      );
      const strayTree = execFileSync("git", ["-C", remote, "write-tree"], {
          env: { ...process.env, GIT_INDEX_FILE: index },
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
      const before = stateHash(app.locals.sync.store(teamId).readState());
      await assert.rejects(
        () => app.locals.sync.get(teamId).run(),
        /protocol/i,
      );
      assert.equal(
        app.locals.sync.store(teamId).readLink().canonical_head,
        internalHead,
      );
      assert.equal(
        stateHash(app.locals.sync.store(teamId).readState()),
        before,
      );
      assert.ok(
        !Object.values(app.locals.sync.store(teamId).readState().entities).some(
          (r) => r.entity.startsWith("report"),
        ),
      );
    },
  );
