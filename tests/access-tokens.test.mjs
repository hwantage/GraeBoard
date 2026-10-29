import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  sqliteBusinessFixture,
  postgresBusinessFixture,
} from "./business-storage-fixture.mjs";
import { createExternalRouteApp } from "./external-route-fixture.mjs";
import { unpack } from "../shared/compact.js";
import { backupDatabase } from "../scripts/backup.mjs";
import { restoreDatabase } from "../scripts/restore.mjs";
import {
  migrateSqlite,
  sqliteVersion,
  assertSqliteIntegrity,
} from "../server/migrations/sqlite.mjs";
import {
  migratePostgres,
  accessTokenMigrations,
} from "../server/migrations/postgres.mjs";
import {
  ACCESS_TOKEN_CHECKSUM,
  postgresHistoryVersion,
} from "../shared/postgres-schema-version.js";
import { accessTokenRoutes } from "../worker/access-tokens.mjs";
import { stateHash } from "../server/sync/protocol.mjs";

async function http(t, app, userId) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return async (
    path,
    method = "GET",
    body,
    actor = userId,
    extraHeaders = {},
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api${path}`,
      {
        method,
        headers: {
          "X-Requested-With": "WeeklyPlan",
          "Content-Type": "application/json",
          ...(actor ? { Cookie: `weekly_session=${actor}` } : {}),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    return { status: response.status, body: unpack(await response.json()) };
  };
}
async function contract(call, otherId, readStored, readAudit) {
  assert.equal(
    (
      await call("/access-tokens", "POST", {
        id: randomUUID(),
        name: "위조",
        userId: otherId,
      })
    ).status,
    400,
  );
  const id = randomUUID();
  const input = { id, name: " 개인 일정 조회 " };
  const created = await call("/access-tokens", "POST", input);
  assert.ok([200, 201].includes(created.status));
  const token = created.body;
  assert.match(token.token, /^gbt_[a-f0-9]{64}$/);
  assert.equal(token.name, "개인 일정 조회");
  assert.equal("expiresAt" in token, false);
  const stored = await readStored(id);
  assert.equal(
    stored.token_hash,
    createHash("sha256").update(token.token).digest("hex"),
  );
  assert.ok(!JSON.stringify(stored).includes(token.token));
  const listed = (await call("/access-tokens")).body.tokens;
  assert.equal(listed.length, 1);
  assert.deepEqual(
    Object.keys(listed[0]).sort(),
    ["id", "name", "prefix", "createdAt"].sort(),
  );
  assert.equal(
    (await call(`/access-tokens/${id}/reveal`)).body.token,
    token.token,
  );
  assert.equal(
    (await call(`/access-tokens/${id}/reveal`, "GET", undefined, otherId))
      .status,
    404,
  );
  assert.equal((await call("/access-tokens", "POST", input)).status, 409);
  assert.deepEqual(await readStored(id), stored);
  assert.deepEqual(
    (await call("/access-tokens", "GET", undefined, otherId)).body.tokens,
    [],
  );
  assert.equal(
    (await call(`/access-tokens/${id}`, "DELETE", {}, otherId)).status,
    404,
  );
  assert.ok(await readStored(id));
  assert.equal((await call(`/access-tokens/${id}`, "DELETE", {})).status, 200);
  assert.equal(await readStored(id), undefined);
  const audit = JSON.stringify(await readAudit());
  assert.ok(audit.includes("access-token-create"));
  assert.ok(audit.includes("access-token-delete"));
  assert.ok(!audit.includes(token.token));
  assert.ok(!audit.includes(stored.token_hash));
  for (let i = 0; i < 19; i++)
    assert.ok(
      [200, 201].includes(
        (
          await call("/access-tokens", "POST", {
            id: randomUUID(),
            name: `토큰 ${i}`,
          })
        ).status,
      ),
    );
  const last = await Promise.all(
    Array.from({ length: 3 }, () =>
      call("/access-tokens", "POST", { id: randomUUID(), name: "동시 생성" }),
    ),
  );
  assert.equal(last.filter((result) => result.status < 300).length, 1);
  assert.equal((await call("/access-tokens")).body.tokens.length, 20);
}

test("SQLite token management isolates owners, hashes secrets, caps concurrent creation and clears restored tokens", async (t) => {
  const f = sqliteBusinessFixture(t),
    otherId = randomUUID();
  f.db.prepare("UPDATE users SET system_role='user' WHERE id=?").run(f.user.id);
  f.db
    .prepare(
      "INSERT INTO users(id,username,name,password,created_at) VALUES(?,?,'Other','!','2026-01-01')",
    )
    .run(otherId, otherId + "@example.test");
  f.db
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(
      createHash("sha256").update(otherId).digest("hex"),
      otherId,
      Date.now() + 600000,
    );
  const call = await http(t, f.app, f.user.id);
  assert.equal(
    (await call("/access-tokens", "GET", undefined, null)).status,
    401,
  );
  assert.equal(
    (
      await call("/access-tokens", "GET", undefined, null, {
        Authorization: "Bearer gbt_" + "a".repeat(64),
      })
    ).status,
    401,
  );
  await contract(
    call,
    otherId,
    async (id) =>
      f.db.prepare("SELECT * FROM access_tokens WHERE id=?").get(id),
    async () =>
      f.db
        .prepare("SELECT * FROM audit WHERE action LIKE 'access-token-%'")
        .all(),
  );
  const backup = join(f.dir, "token-backup.sqlite"),
    restoredPath = join(f.dir, "token-restored.sqlite");
  backupDatabase(join(f.dir, "data.sqlite"), backup);
  restoreDatabase(backup, restoredPath, {
    documentImagesDir: join(f.dir, "restored-images"),
  });
  const restored = new DatabaseSync(restoredPath);
  try {
    assert.equal(
      restored.prepare("SELECT COUNT(*) n FROM access_tokens").get().n,
      0,
    );
    assert.equal(restored.prepare("SELECT COUNT(*) n FROM users").get().n, 2);
    assertSqliteIntegrity(restored);
  } finally {
    restored.close();
  }
});

test("actual PostgreSQL control routes enforce the same owner and secret contract", async (t) => {
  const f = await postgresBusinessFixture(t);
  if (!f) return;
  const otherId = randomUUID();
  f.env.GRAEBOARD_ACCESS_TOKEN_KEY = randomBytes(32).toString("base64");
  await f.control.query(
    "UPDATE graeboard.users SET system_role='user' WHERE id=$1",
    [f.user.id],
  );
  await f.control.query(
    "INSERT INTO graeboard.users(id,username,email,name,created_at) VALUES($1,$2,$2,'Other','2026-01-01')",
    [otherId, otherId + "@example.test"],
  );
  const app = createExternalRouteApp({ env: f.env, defaultUserId: f.user.id });
  t.after(() => app.close());
  const call = await http(t, app, f.user.id);
  await contract(
    call,
    otherId,
    async (id) =>
      (
        await f.control.query(
          "SELECT * FROM graeboard.access_tokens WHERE id=$1",
          [id],
        )
      ).rows[0],
    async () =>
      (
        await f.control.query(
          "SELECT * FROM graeboard.control_audit WHERE action LIKE 'access-token-%'",
        )
      ).rows,
  );
});

test("SQLite v32 → v33 is atomic, preserves data and is retryable", (t) => {
  const f = sqliteBusinessFixture(t);
  f.db.exec(
    "DROP TABLE access_tokens; DELETE FROM schema_migrations WHERE version>=33; PRAGMA user_version=32",
  );
  const before = f.db.prepare("SELECT * FROM cells").all();
  assert.equal(migrateSqlite(f.db, { dryRun: true }).to, 33);
  assert.equal(sqliteVersion(f.db), 32);
  assert.throws(
    () =>
      migrateSqlite(f.db, {
        afterDdl(version) {
          if (version === 33) throw new Error("token ddl crash");
        },
      }),
    /token ddl crash/,
  );
  assert.equal(sqliteVersion(f.db), 32);
  assert.equal(
    f.db
      .prepare("SELECT name FROM sqlite_master WHERE name='access_tokens'")
      .get(),
    undefined,
  );
  assert.equal(migrateSqlite(f.db).to, 33);
  assert.deepEqual(f.db.prepare("SELECT * FROM cells").all(), before);
  assert.equal(migrateSqlite(f.db).applied, false);
  assertSqliteIntegrity(f.db);
});

test("actual PostgreSQL token migrations preserve control/site data and roll back; site tokens stay outside team state", async (t) => {
  const f = await postgresBusinessFixture(t);
  if (!f) return;
  assert.equal(accessTokenMigrations.control.checksum, ACCESS_TOKEN_CHECKSUM);
  assert.equal(accessTokenMigrations.site.checksum, ACCESS_TOKEN_CHECKSUM);
  await migratePostgres(f.pool, { scope: "site", teamId: f.teamId });
  await f.pool.query(
    "INSERT INTO graeboard_site.users(id,username,email,name,created_at) VALUES($1,'site@example.test','site@example.test','Site','2026-01-01')",
    [f.user.id],
  );
  const stateBefore = stateHash(await f.adapter.readState(f.teamId));
  for (const [scope, pool, schema, version] of [
    ["control", f.control, "graeboard", 2],
    ["site", f.pool, "graeboard_site", 3],
  ]) {
    const users = (await pool.query(`SELECT * FROM ${schema}.users`)).rows;
    await pool.query(
      `DROP TABLE ${schema}.access_tokens; DELETE FROM ${schema}.schema_migrations WHERE version>=${version}`,
    );
    const options = { scope, teamId: scope === "site" ? f.teamId : undefined };
    assert.equal(
      (await migratePostgres(pool, { ...options, dryRun: true })).to,
      version,
    );
    await assert.rejects(
      () =>
        migratePostgres(pool, {
          ...options,
          afterDdl() {
            throw new Error("tokens rollback");
          },
        }),
      /tokens rollback/,
    );
    assert.equal(
      (await pool.query(`SELECT to_regclass('${schema}.access_tokens') name`))
        .rows[0].name,
      null,
    );
    const previous = (
      await pool.query(
        `SELECT * FROM ${schema}.schema_migrations ORDER BY version`,
      )
    ).rows;
    assert.throws(() => postgresHistoryVersion(previous, scope), /mismatch/);
    await migratePostgres(pool, options);
    assert.deepEqual(
      (await pool.query(`SELECT * FROM ${schema}.users`)).rows,
      users,
    );
    assert.equal((await migratePostgres(pool, options)).applied, false);
  }
  const ctx = {
    user: f.user,
    env: {
      PG_SITE: f.env.PG_TEAM,
      SITE_TEAM_ID: f.teamId,
      GRAEBOARD_ACCESS_TOKEN_KEY: randomBytes(32).toString("base64"),
    },
  };
  const created = await accessTokenRoutes(ctx, "/access-tokens", "POST", {
    id: randomUUID(),
    name: "외부 개인 토큰",
  });
  assert.match(created.token, /^gbt_/);
  assert.equal(
    (await accessTokenRoutes(ctx, "/access-tokens", "GET", {})).tokens.length,
    1,
  );
  assert.equal(stateHash(await f.adapter.readState(f.teamId)), stateBefore);
  await accessTokenRoutes(ctx, `/access-tokens/${created.id}`, "DELETE", {});
  assert.equal(
    (await accessTokenRoutes(ctx, "/access-tokens", "GET", {})).tokens.length,
    0,
  );
});

test("token encryption survives reopening the DB and rejects moved ciphertext, tampering and missing keys", async (t) => {
  const { accessTokenKey } = await import("../server/access-token-key.mjs");
  const { prepareAccessToken, revealAccessToken } =
    await import("../server/storage/access-token-service.mjs");
  const { statSync, unlinkSync, existsSync } = await import("node:fs");
  const f = sqliteBusinessFixture(t);
  const key = accessTokenKey(f.db);
  assert.equal(statSync(join(f.dir, "access-token.key")).mode & 0o777, 0o600);
  const id = randomUUID(),
    prepared = await prepareAccessToken(
      { id, name: "Persistent" },
      { userId: f.user.id, key },
    );
  const row = {
    id,
    user_id: f.user.id,
    token_hash: prepared.hash,
    token_ciphertext: prepared.ciphertext,
  };
  f.db
    .prepare("INSERT INTO access_tokens VALUES(?,?,?,?,?,?,?)")
    .run(
      id,
      f.user.id,
      "Persistent",
      prepared.hash,
      prepared.metadata.prefix,
      prepared.metadata.createdAt,
      prepared.ciphertext,
    );
  const reopened = new DatabaseSync(join(f.dir, "data.sqlite"));
  t.after(() => reopened.close());
  assert.equal(
    await revealAccessToken(row, accessTokenKey(reopened)),
    prepared.token,
  );
  await assert.rejects(
    () => revealAccessToken({ ...row, user_id: randomUUID() }, key),
    /복호화/,
  );
  const sealed = JSON.parse(row.token_ciphertext);
  sealed.data = (sealed.data[0] === "A" ? "B" : "A") + sealed.data.slice(1);
  await assert.rejects(
    () =>
      revealAccessToken(
        { ...row, token_ciphertext: JSON.stringify(sealed) },
        key,
      ),
    /복호화/,
  );
  unlinkSync(join(f.dir, "access-token.key"));
  const missing = new DatabaseSync(join(f.dir, "data.sqlite"));
  try {
    assert.throws(() => accessTokenKey(missing), /키 파일이 없습니다/);
  } finally {
    missing.close();
  }
  assert.equal(existsSync(join(f.dir, "access-token.key")), false);
});
