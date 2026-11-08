import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import { openDatabase, json } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { DEFAULT_SETTINGS } from "../shared/domain.js";
import { unpack } from "../shared/formatting/compact.js";
import { GitCliTransport } from "../server/sync/node/git-cli.mjs";
import { stateHash, entityId, initialToken } from "../server/sync/core/protocol.mjs";
import { storeDocumentVersion } from "../server/documents/document-storage.mjs";
import { migratePostgres } from "../server/migrations/postgres.mjs";
import { PostgresDatabase } from "../worker/storage/postgres.mjs";
import { createWorker } from "../worker/entry.mjs";
import { runTeam } from "../worker/sync/sync.mjs";
import { profileFor } from "../shared/sync/sync-profiles.js";
import { githubEmulator, bucket } from "./worker-github-fixture.mjs";
import { recoverSync } from "../scripts/sync-recover.mjs";

const pgBin = process.env.TEST_PG_BIN || "/tmp/graeboard-pg18/bin";
const ok = (result) => {
  assert.ok(
    result.status >= 200 && result.status < 300,
    JSON.stringify(result),
  );
  return result.data;
};
const documentKey = (id) => ["calendar", id, "main"];
const documentChanges = (ops, id) =>
  ops.flatMap((op) =>
    op.changes.filter(
      (change) =>
        change.entity === "document" &&
        entityId(change.entity, change.key) ===
          entityId("document", documentKey(id)),
    ),
  );

// A calendar entry's "main" document exists in shared state only once a body
// has been saved, on both sites. Before 2026-11-02 the internal site assumed
// every entry had one (SQLite reads an empty body for each entry), so a body
// first saved on the internal site for an entry the external site created was
// sent as an edit of a document shared state did not have: a conflict, with
// each following autosave blocked behind it.
test(
  "calendar documents exist once a body is saved: created on either site, edited on the other, never conflicting",
  { skip: !existsSync(join(pgBin, "initdb")), timeout: 300000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "gb-calendar-documents-")),
      remote = join(dir, "remote.git"),
      socket = join(dir, "socket"),
      pgData = join(dir, "pg"),
      teamId = randomUUID(),
      internalUser = randomUUID(),
      externalInstallation = randomUUID(),
      internalInstallation = randomUUID(),
      nativeFetch = globalThis.fetch,
      pools = [],
      work = [];
    mkdirSync(socket);
    let pgStarted = false,
      db,
      server,
      app;
    const command = (bin, args) => {
        const r = spawnSync(join(pgBin, bin), args, { encoding: "utf8" });
        assert.equal(r.status, 0, r.stdout + r.stderr);
      },
      url = (name) =>
        `postgresql://postgres@localhost/${name}?host=${encodeURIComponent(socket)}&port=55447`;
    try {
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
      const github = githubEmulator(remote),
        readme = github.text(["hash-object", "-w", "--stdin"], {
          input: "fixture",
        }),
        tree = github.text(["mktree"], {
          input: `100644 blob ${readme}\tREADME.md\n`,
        }),
        main = github.text(["commit-tree", tree, "-m", "init"]);
      github.text(["update-ref", "refs/heads/main", main]);
      globalThis.fetch = (input, init) => {
        const target = new URL(typeof input === "string" ? input : input.url);
        if (target.origin === "https://api.github.com")
          return github.fetch(target.href, init);
        assert.equal(target.hostname, "127.0.0.1");
        return nativeFetch(input, init);
      };
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
        `-k ${socket} -p 55447 -c listen_addresses=''`,
        "-w",
        "start",
      ]);
      pgStarted = true;
      const root = new Pool({ connectionString: url("postgres") });
      pools.push(root);
      await root.query("CREATE DATABASE control");
      await root.query("CREATE DATABASE team");
      const control = new Pool({ connectionString: url("control") }),
        team = new Pool({ connectionString: url("team") });
      pools.push(control, team);
      await migratePostgres(control, { scope: "control", initialize: true });
      await migratePostgres(team, { scope: "team", initialize: true, teamId });
      const pgStore = new PostgresDatabase(team, { teamId });
      db = openDatabase(join(dir, "inside.sqlite"));
      db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
        teamId,
        "Calendar",
        json(DEFAULT_SETTINGS),
      );
      db.prepare(
        "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','admin',?)",
      ).run(
        internalUser,
        "inside@example.com",
        "Inside",
        new Date().toISOString(),
      );
      db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(
        internalUser,
        teamId,
      );
      const token = randomUUID();
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
        createHash("sha256").update(token).digest("hex"),
        internalUser,
        Date.now() + 86400000,
      );
      app = createApp({
        db,
        rateLimits: false,
        documentImagesDir: join(dir, "images"),
        syncOptions: {
          installationId: internalInstallation,
          profiles: [
            {
              profileId: "inside",
              teamId,
              repository: "fixture/team",
              peerInstallationId: externalInstallation,
            },
          ],
          transports: {
            inside: new GitCliTransport({
              directory: join(dir, "inside.git"),
              repository: remote,
              allowLocal: true,
            }),
          },
          schedule: false,
        },
      });
      server = app.listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      const inside = async (path, body, method = body ? "POST" : "GET") => {
        const response = await nativeFetch(
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
        );
        return { status: response.status, data: unpack(await response.json()) };
      };
      const env = {
          APP_ORIGIN: "https://calendar.example.com",
          ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
          ACCESS_AUDIENCE: "fixture",
          SETUP_TOKEN: "fixture-setup-token-with-enough-entropy",
          INSTALLATION_ID: externalInstallation,
          PEER_INSTALLATION_ID: internalInstallation,
          PG_CONTROL: { connectionString: url("control") },
          PG_TEAM: { connectionString: url("team") },
          R2_TEAM: bucket(),
          GIT_TOKEN: "fixture-secret",
          SYNC_PROFILES: JSON.stringify([
            {
              profileId: "outside",
              teamId,
              repository: "fixture/team",
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
      const outside = async (path, body, method = body ? "POST" : "GET") => {
        const response = await worker.fetch(
          new Request(env.APP_ORIGIN + "/api" + path, {
            method,
            headers: {
              "X-Requested-With": "WeeklyPlan",
              "Content-Type": "application/json",
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
          env,
          { waitUntil: (p) => work.push(p) },
        );
        return { status: response.status, data: unpack(await response.json()) };
      };
      const sync = app.locals.sync,
        internalStore = () => sync.store(teamId);
      // Every command each site ever wrote, published or not, in order.
      const internalOps = () =>
          db
            .prepare(
              "SELECT payload FROM sync_outbox WHERE team_id=? ORDER BY local_seq",
            )
            .all(teamId)
            .map((row) => JSON.parse(row.payload)),
        externalOps = async () =>
          (
            await team.query(
              `SELECT payload FROM ${pgStore.schema}.sync_outbox WHERE team_id=$1 ORDER BY local_seq`,
              [teamId],
            )
          ).rows.map((row) => JSON.parse(row.payload));
      let profile;
      const settle = async () => {
        for (let round = 0; round < 4; round++) {
          for (let i = 0; i < work.length; i++) await work[i];
          await sync.get(teamId).run();
          await runTeam(env, profile);
          if (
            !internalStore().readPending().length &&
            !(await pgStore.readPending(teamId)).length &&
            internalStore().readLink().canonical_head ===
              (await pgStore.readLink(teamId)).canonical_head
          )
            return;
        }
        assert.fail("The two sites did not converge");
      };
      // The commands one step writes, after both sites have applied them.
      const step = async (where, action) => {
        const written = async () =>
            where === "inside" ? internalOps() : await externalOps(),
          before = (await written()).length;
        const result = await action();
        await settle();
        const ops = (await written()).slice(before);
        const state = internalStore().readState();
        for (const op of ops)
          assert.equal(
            state.receipts[op.opId]?.result,
            "applied",
            JSON.stringify(state.conflicts[op.opId]?.reason || op),
          );
        return { result, ops };
      };
      const site = { inside, outside };
      const create = async (where, title) =>
        ok(
          await site[where]("/calendar/entries", {
            id: randomUUID(),
            teamId,
            userId: null,
            date: "2026-10-27",
            title,
          }),
        );
      const restore = async (where, id, deletionId) =>
        ok(
          await site[where](`/calendar/entries/${id}/restore`, { deletionId }),
        );
      const write = async (where, id, markdown) => {
        const path = `/calendar/entries/${id}/document`,
          current = ok(await site[where](path));
        return ok(
          await site[where](
            path,
            {
              operationId: randomUUID(),
              expectedRevision: current.revision,
              markdown,
            },
            "PUT",
          ),
        );
      };
      const read = async (where, id) =>
        ok(await site[where](`/calendar/entries/${id}/document`)).markdown;
      const entry = async (where, id) =>
        ok(await site[where](`/calendar/entries/${id}`));
      const rename = async (where, id, title) => {
        const current = await entry(where, id);
        return ok(
          await site[where](
            `/calendar/entries/${id}`,
            { title, expectedTitle: current.title },
            "PATCH",
          ),
        );
      };
      const remove = async (where, id) => {
        const current = await entry(where, id),
          deletionId = randomUUID();
        ok(
          await site[where](
            `/calendar/entries/${id}`,
            {
              deletionId,
              expectedUpdatedAt: current.updatedAt,
              expectedRevision: current.revision,
              expectedTitle: current.title,
              expectedDate: current.date,
              expectedEndDate: current.endDate,
              expectedTagIds: current.tagIds,
              expectedCheckedTagIds: current.checkedTagIds,
            },
            "DELETE",
          ),
        );
        return deletionId;
      };
      const shared = (id) =>
        internalStore().readState().entities[
          entityId("document", documentKey(id))
        ];
      const converged = async (id, markdown) => {
        assert.equal(await read("inside", id), markdown);
        assert.equal(await read("outside", id), markdown);
        assert.equal(shared(id)?.payload.markdown, markdown);
      };

      // Genesis-era entries: one with a body, one never saved, one whose
      // body was saved empty. Genesis holds the saved ones only.
      ok(
        await outside("/auth/setup", {
          name: "Outside",
          setupToken: env.SETUP_TOKEN,
        }),
      );
      const withBody = await create("inside", "Genesis with body"),
        neverSaved = await create("inside", "Genesis never saved"),
        savedEmpty = await create("inside", "Genesis saved empty");
      await write("inside", withBody.id, "Genesis body");
      // Saving an unchanged empty body stores nothing; a body cleared after
      // typing is a saved empty body.
      await write("inside", savedEmpty.id, "");
      assert.equal(
        db
          .prepare("SELECT version_id FROM calendar_entries WHERE id=?")
          .get(savedEmpty.id).version_id,
        null,
      );
      await write("inside", savedEmpty.id, "draft");
      await write("inside", savedEmpty.id, "");
      ok(
        await inside(
          `/admin/teams/${teamId}/connection`,
          { profileId: "inside", expectedRevision: 0 },
          "PUT",
        ),
      );
      // Saved while the connection waits for its first publication: a body
      // saved now is a creation that genesis already contains.
      const beforeGenesis = await create("inside", "Before genesis");
      await write("inside", beforeGenesis.id, "Before genesis body");
      assert.deepEqual(
        documentChanges(internalOps(), beforeGenesis.id).map((c) => c.action),
        ["create"],
      );
      // A document genesis will hold is edited with its genesis generation.
      const bootstrapId = internalStore().readLink().bootstrap_id;
      await write("inside", withBody.id, "Genesis body, edited early");
      assert.deepEqual(
        documentChanges(internalOps(), withBody.id).map((c) => [
          c.action,
          c.generation,
        ]),
        [
          [
            "edit",
            initialToken(bootstrapId, "document", documentKey(withBody.id)),
          ],
        ],
      );
      ok(await inside(`/teams/${teamId}/sync/enable`, {}));
      for (const [id, present] of [
        [withBody.id, true],
        [neverSaved.id, false],
        [savedEmpty.id, true],
        [beforeGenesis.id, true],
      ])
        assert.equal(!!shared(id), present, id);
      assert.equal(
        shared(withBody.id).generation,
        initialToken(bootstrapId, "document", documentKey(withBody.id)),
      );
      // Production keeps genesis documents with an empty body whose entry has
      // no stored body locally (genesis once held every entry's document).
      db.prepare("UPDATE calendar_entries SET version_id=NULL WHERE id=?").run(
        savedEmpty.id,
      );
      ok(await outside("/admin/sync/import", { teamId, profileId: "outside" }));
      for (let i = 0; i < work.length; i++) await work[i];
      profile = profileFor(env, "outside", teamId);
      await settle();
      assert.equal(
        await read("outside", withBody.id),
        "Genesis body, edited early",
      );

      // Genesis documents are edited, keeping their generation, on both sites.
      for (const [id, where, markdown] of [
        [withBody.id, "inside", "Genesis body inside"],
        [withBody.id, "outside", "Genesis body outside"],
        [savedEmpty.id, "inside", "Saved empty, now inside"],
        [savedEmpty.id, "outside", "Saved empty, now outside"],
      ]) {
        const { ops } = await step(where, () => write(where, id, markdown));
        assert.deepEqual(
          documentChanges(ops, id).map((c) => [c.action, c.generation]),
          [["edit", initialToken(bootstrapId, "document", documentKey(id))]],
        );
        await converged(id, markdown);
      }
      // A genesis entry never saved has no document: its first body is a
      // creation, then edited from the other site.
      let { ops } = await step("inside", () =>
        write("inside", neverSaved.id, "First body inside"),
      );
      assert.deepEqual(
        documentChanges(ops, neverSaved.id).map((c) => c.action),
        ["create"],
      );
      ({ ops } = await step("outside", () =>
        write("outside", neverSaved.id, "Then outside"),
      ));
      assert.deepEqual(
        documentChanges(ops, neverSaved.id).map((c) => c.action),
        ["edit"],
      );
      await converged(neverSaved.id, "Then outside");

      // An entry created inside has no document until its body is saved.
      const internal = await step("inside", () =>
        create("inside", "Created inside"),
      );
      assert.deepEqual(documentChanges(internal.ops, internal.result.id), []);
      assert.equal(shared(internal.result.id), undefined);
      for (const where of ["inside", "outside"])
        assert.equal(
          (await entry(where, internal.result.id)).hasDocument,
          false,
        );
      ({ ops } = await step("inside", () =>
        rename("inside", internal.result.id, "Created inside, renamed"),
      ));
      assert.deepEqual(documentChanges(ops, internal.result.id), []);
      ({ ops } = await step("inside", () =>
        write("inside", internal.result.id, "Inside first body"),
      ));
      assert.deepEqual(
        documentChanges(ops, internal.result.id).map((c) => [
          c.action,
          c.desired.markdown,
        ]),
        [["create", "Inside first body"]],
      );
      ({ ops } = await step("outside", () =>
        write("outside", internal.result.id, "Outside edit"),
      ));
      assert.deepEqual(
        documentChanges(ops, internal.result.id).map((c) => c.action),
        ["edit"],
      );
      await converged(internal.result.id, "Outside edit");

      // An entry created outside, its body first saved inside with several
      // autosaves chained before publication, then edited outside.
      const external = await step("outside", () =>
        create("outside", "Created outside"),
      );
      const outsideId = external.result.id;
      assert.equal(shared(outsideId), undefined);
      ({ ops } = await step("inside", async () => {
        for (const markdown of ["a", "ab", "abc"])
          await write("inside", outsideId, markdown);
      }));
      const chained = documentChanges(ops, outsideId);
      assert.deepEqual(
        chained.map((c) => c.action),
        ["create", "edit", "edit"],
      );
      assert.equal(chained[1].generation, chained[0].generation);
      assert.deepEqual(ops[1].dependsOn, [ops[0].opId]);
      assert.deepEqual(ops[2].dependsOn, [ops[1].opId]);
      await converged(outsideId, "abc");
      ({ ops } = await step("outside", () =>
        write("outside", outsideId, "abc outside"),
      ));
      assert.deepEqual(
        documentChanges(ops, outsideId).map((c) => c.action),
        ["edit"],
      );
      await converged(outsideId, "abc outside");

      // The reverse: created and first saved outside, edited inside. The
      // document keeps the title the external site gave it while the entry
      // is renamed on both sites.
      const reverse = (
        await step("outside", () => create("outside", "Reverse"))
      ).result.id;
      ({ ops } = await step("outside", () =>
        write("outside", reverse, "Outside first body"),
      ));
      assert.deepEqual(
        documentChanges(ops, reverse).map((c) => c.action),
        ["create"],
      );
      await step("outside", () =>
        rename("outside", reverse, "Reverse renamed"),
      );
      ({ ops } = await step("inside", () =>
        rename("inside", reverse, "Reverse renamed inside"),
      ));
      assert.deepEqual(documentChanges(ops, reverse), []);
      await step("outside", () =>
        rename("outside", withBody.id, "Genesis renamed"),
      );
      await step("inside", () =>
        rename("inside", withBody.id, "Genesis renamed inside"),
      );
      ({ ops } = await step("inside", () =>
        write("inside", reverse, "Inside edit"),
      ));
      assert.deepEqual(
        documentChanges(ops, reverse).map((c) => [c.action, c.fields]),
        [["edit", ["markdown"]]],
      );
      await converged(reverse, "Inside edit");

      // An entry created outside before this fix, its body saved inside
      // while the edit conflicted: the internal site still shows that body
      // but shared state has no document. Moving or renaming it writes no
      // document; the next body save creates one.
      const stale = (await step("outside", () => create("outside", "Stale")))
        .result.id;
      db.prepare("UPDATE calendar_entries SET version_id=? WHERE id=?").run(
        storeDocumentVersion(db, {
          teamId,
          documentId: `calendar:${stale}`,
          markdown: "Body the conflict kept",
          actorId: internalUser,
        }),
        stale,
      );
      ({ ops } = await step("inside", () =>
        rename("inside", stale, "Stale renamed"),
      ));
      assert.deepEqual(documentChanges(ops, stale), []);
      assert.equal(shared(stale), undefined);
      ({ ops } = await step("inside", () =>
        write("inside", stale, "Body the conflict kept, saved again"),
      ));
      assert.deepEqual(
        documentChanges(ops, stale).map((c) => [c.action, c.base]),
        [["create", null]],
      );
      await converged(stale, "Body the conflict kept, saved again");

      // A document saved empty when the internal site still created one with
      // each entry: edited, not created again.
      const legacy = (await step("inside", () => create("inside", "Legacy")))
        .result.id;
      await step("inside", async () => {
        await write("inside", legacy, "draft");
        await write("inside", legacy, "");
      });
      db.prepare("UPDATE calendar_entries SET version_id=NULL WHERE id=?").run(
        legacy,
      );
      ({ ops } = await step("inside", () =>
        write("inside", legacy, "Legacy body"),
      ));
      assert.deepEqual(
        documentChanges(ops, legacy).map((c) => c.action),
        ["edit"],
      );
      await converged(legacy, "Legacy body");

      // Delete and restore write no document for an entry that has none, and
      // keep editing the one an entry has.
      for (const [where, id] of [
        [
          "inside",
          (await step("outside", () => create("outside", "Gone"))).result.id,
        ],
        [
          "outside",
          (await step("inside", () => create("inside", "Gone too"))).result.id,
        ],
      ]) {
        const deleted = await step(where, () => remove(where, id));
        assert.deepEqual(documentChanges(deleted.ops, id), []);
        const restored = await step(where, () =>
          restore(where, id, deleted.result),
        );
        assert.deepEqual(documentChanges(restored.ops, id), []);
        assert.equal(shared(id), undefined);
        ({ ops } = await step(where, () => write(where, id, "After restore")));
        assert.deepEqual(
          documentChanges(ops, id).map((c) => c.action),
          ["create"],
        );
        await converged(id, "After restore");
      }
      for (const where of ["inside", "outside"]) {
        const deleted = await step(where, () => remove(where, outsideId));
        assert.deepEqual(documentChanges(deleted.ops, outsideId), []);
        await step(where, () => restore(where, outsideId, deleted.result));
        const other = where === "inside" ? "outside" : "inside";
        ({ ops } = await step(other, () =>
          write(other, outsideId, `Restored ${where}`),
        ));
        assert.deepEqual(
          documentChanges(ops, outsideId).map((c) => c.action),
          ["edit"],
        );
        await converged(outsideId, `Restored ${where}`);
      }

      // A copy has no body and no document until one is saved.
      for (const [where, source] of [
        ["inside", outsideId],
        ["outside", internal.result.id],
      ]) {
        const copy = await step(where, async () =>
          ok(
            await site[where](`/calendar/entries/${source}/copy`, {
              id: randomUUID(),
            }),
          ),
        );
        assert.deepEqual(documentChanges(copy.ops, copy.result.id), []);
        assert.equal(await read(where, copy.result.id), "");
        const other = where === "inside" ? "outside" : "inside";
        ({ ops } = await step(other, () =>
          write(other, copy.result.id, "Copy body"),
        ));
        assert.deepEqual(
          documentChanges(ops, copy.result.id).map((c) => c.action),
          ["create"],
        );
        await converged(copy.result.id, "Copy body");
      }

      // The calendar marks a document by its content on both sites.
      for (const where of ["inside", "outside"]) {
        assert.equal((await entry(where, savedEmpty.id)).hasDocument, true);
        assert.equal((await entry(where, legacy)).hasDocument, true);
      }
      const blank = (await step("outside", () => create("outside", "Blank")))
        .result.id;
      await step("outside", () => write("outside", blank, ""));
      for (const where of ["inside", "outside"])
        assert.equal((await entry(where, blank)).hasDocument, false);

      const state = internalStore().readState();
      assert.deepEqual(Object.keys(state.conflicts), []);
      assert.ok(
        Object.values(state.receipts).every((r) =>
          ["applied", "noop"].includes(r.result),
        ),
      );
      assert.equal(
        stateHash(await pgStore.readState(teamId)),
        stateHash(state),
      );
    } finally {
      await Promise.allSettled(work);
      globalThis.fetch = nativeFetch;
      if (app) {
        await app.locals.sync.close();
        app.locals.cellEvents.close();
        app.locals.documentEvents.close();
      }
      if (server) await new Promise((r) => server.close(r));
      db?.close();
      await Promise.all(pools.map((p) => p.end()));
      if (pgStarted)
        spawnSync(
          join(pgBin, "pg_ctl"),
          ["-D", pgData, "-m", "immediate", "-w", "stop"],
          { stdio: "ignore" },
        );
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// Reconnection and recovery publish what the local site has that shared state
// does not. An entry's document with no saved body is not something it has,
// and a genesis document shared state holds is not something it lost.
test("reconnection and recovery neither create empty calendar documents nor delete genesis ones", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gb-calendar-reconnect-")),
    remote = join(dir, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const db = openDatabase(join(dir, "data.sqlite")),
    teamId = randomUUID(),
    userId = randomUUID(),
    token = randomUUID(),
    installationId = randomUUID();
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "Reconnect",
    json(DEFAULT_SETTINGS),
  );
  db.prepare(
    "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','admin',?)",
  ).run(userId, "reconnect@example.com", "Reconnect", new Date().toISOString());
  db.prepare("INSERT INTO memberships VALUES(?,?,'lead')").run(userId, teamId);
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    userId,
    Date.now() + 3600000,
  );
  const transport = new GitCliTransport({
      directory: join(dir, "cache.git"),
      repository: remote,
      allowLocal: true,
    }),
    profiles = [{ profileId: "local", teamId, repository: "test/reconnect" }];
  const app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: join(dir, "images"),
    syncOptions: {
      installationId,
      profiles,
      transports: { local: transport },
      schedule: false,
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await app.locals.sync.close();
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const api = async (path, body, method = body ? "POST" : "GET") =>
    ok(
      await (async () => {
        const response = await fetch(
          `http://127.0.0.1:${server.address().port}/api${path}`,
          {
            method,
            headers: {
              cookie: "weekly_session=" + token,
              "Content-Type": "application/json",
              "X-Requested-With": "WeeklyPlan",
            },
            body: body ? JSON.stringify(body) : undefined,
          },
        );
        return {
          status: response.status,
          data: unpack(await response.json()),
        };
      })(),
    );
  const create = (title) =>
    api("/calendar/entries", {
      id: randomUUID(),
      teamId,
      userId: null,
      date: "2026-10-27",
      title,
    });
  const write = async (id, markdown) => {
    const path = `/calendar/entries/${id}/document`;
    return api(
      path,
      {
        operationId: randomUUID(),
        expectedRevision: (await api(path)).revision,
        markdown,
      },
      "PUT",
    );
  };
  const genesisEmpty = await create("Genesis empty"),
    unsaved = await create("Never saved"),
    savedOffline = await create("Saved while disconnected");
  await write(genesisEmpty.id, "draft");
  await write(genesisEmpty.id, "");
  await api(
    `/admin/teams/${teamId}/connection`,
    { profileId: "local", expectedRevision: 0 },
    "PUT",
  );
  await api(`/teams/${teamId}/sync/enable`, {});
  const store = app.locals.sync.store(teamId),
    shared = (id) =>
      store.readState().entities[entityId("document", documentKey(id))];
  db.prepare("UPDATE calendar_entries SET version_id=NULL WHERE id=?").run(
    genesisEmpty.id,
  );
  assert.equal(shared(genesisEmpty.id).payload.markdown, "");
  assert.equal(shared(unsaved.id), undefined);
  await api(`/teams/${teamId}/sync/disconnect`, {});
  await write(savedOffline.id, "Saved while disconnected");
  await api(`/teams/${teamId}/sync/reconnect`, {});
  const [operation] = store.readPending();
  assert.deepEqual(
    operation.changes.map((c) => [c.entity, c.key, c.action]),
    [["document", documentKey(savedOffline.id), "create"]],
  );
  await app.locals.sync.get(teamId).run();
  assert.deepEqual(Object.keys(store.readState().conflicts), []);
  assert.equal(shared(genesisEmpty.id).payload.markdown, "");
  assert.equal(shared(unsaved.id), undefined);
  assert.equal(
    shared(savedOffline.id).payload.markdown,
    "Saved while disconnected",
  );
  await api(`/teams/${teamId}/sync/pause`, {});
  await app.locals.sync.close();
  const recovery = await recoverSync({
    db,
    teamId,
    installationId: randomUUID(),
    profiles,
    imagesDir: join(dir, "images"),
    dryRun: true,
    transports: { local: transport },
  });
  assert.equal(recovery.uncapturedChanges, 0);
});
