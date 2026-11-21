import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { postgresBusinessFixture } from "../support/business-storage-fixture.mjs";
import { createExternalRouteApp } from "../support/external-route-fixture.mjs";
import {
  migrateSlideSchema,
  slideSchemaMigrations,
} from "../../server/migrations/postgres-slides.mjs";
import { SLIDE_KEPT_REVISIONS } from "../../worker/storage/slides/postgres-slide-files.mjs";
import { slideRoutes } from "../../worker/slides/slide-files.mjs";
import { slideObjectKey } from "../../worker/storage/slides/r2-slide-blobs.mjs";
import { postgresHistoryVersion } from "../../shared/storage/postgres-schema-version.js";
import { SLIDE_SCHEMA_CHECKSUMS } from "../../shared/slides/slide-store-version.js";
import { MAX_SLIDE_FILE_BYTES } from "../../shared/slides/slide-file-rules.js";
import { unpack } from "../../shared/formatting/compact.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
// The release before slides: its Edge code must keep running on a database
// that already has the slide schema.
const RELEASE_BEFORE_SLIDES = "37a87022774864653647192213633b7f71d166a9";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const slide = (text, size = 0) => {
  const body = JSON.stringify({ version: 1, name: text, pad: "" });
  return Buffer.from(
    size
      ? body.replace('"pad":""', `"pad":"${"x".repeat(size - body.length)}"`)
      : body,
  );
};

// An R2 bucket binding kept in memory.
function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, bytes, options) {
      objects.set(key, { bytes: Uint8Array.from(bytes), options });
    },
    async get(key) {
      const object = objects.get(key);
      return (
        object && {
          arrayBuffer: async () =>
            object.bytes.buffer.slice(
              object.bytes.byteOffset,
              object.bytes.byteOffset + object.bytes.byteLength,
            ),
        }
      );
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { key, size: object.bytes.byteLength } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}
async function start(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (app.close) await app.close();
  });
  return `http://127.0.0.1:${server.address().port}/api`;
}
function clientAt(base, userId) {
  const call = (path, options = {}) =>
    fetch(base + path, {
      ...options,
      headers: {
        Cookie: "weekly_session=" + userId,
        "X-Requested-With": "WeeklyPlan",
        ...(options.json ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      body: options.json ? JSON.stringify(options.json) : options.body,
    });
  const data = async (path, options) => {
    const response = await call(path, options);
    return { status: response.status, body: unpack(await response.json()) };
  };
  const binary = (extra) => ({
    "Content-Type": "application/octet-stream",
    "X-Slide-Request-Id": randomUUID(),
    ...extra,
  });
  return {
    call,
    data,
    upload: (teamId, title, bytes, requestId) =>
      data(`/teams/${teamId}/slides`, {
        method: "POST",
        body: bytes,
        headers: binary({
          "X-Slide-Title": encodeURIComponent(title),
          ...(requestId ? { "X-Slide-Request-Id": requestId } : {}),
        }),
      }),
    save: (teamId, fileId, base_, bytes, requestId) =>
      data(`/teams/${teamId}/slides/${fileId}/content`, {
        method: "PUT",
        body: bytes,
        headers: binary({
          "X-Slide-Base-Revision": String(base_),
          ...(requestId ? { "X-Slide-Request-Id": requestId } : {}),
        }),
      }),
    bytes: async (teamId, fileId) => {
      const response = await call(`/teams/${teamId}/slides/${fileId}/content`);
      return {
        status: response.status,
        revision: Number(response.headers.get("X-Slide-Revision")),
        disposition: response.headers.get("content-disposition"),
        bytes: Buffer.from(await response.arrayBuffer()),
      };
    },
  };
}
async function externalSite(t) {
  const pg = await postgresBusinessFixture(t);
  if (!pg) return null;
  const bucket = memoryBucket();
  pg.env.BUCKET = bucket;
  const member = async (role) => {
    const id = randomUUID();
    await pg.control.query(
      "INSERT INTO graeboard.users(id,username,email,name,system_role,created_at) VALUES($1,$2,$2,$3,'user',$4)",
      [id, `${id}@example.test`, role || "outsider", new Date().toISOString()],
    );
    if (role)
      await pg.control.query(
        "INSERT INTO graeboard.memberships VALUES($1,$2,$3)",
        [id, pg.teamId, role],
      );
    return id;
  };
  const base = await start(
    t,
    createExternalRouteApp({ env: pg.env, defaultUserId: pg.user.id }),
  );
  return { pg, bucket, base, member, lead: clientAt(base, pg.user.id) };
}
const history = async (pool) =>
  (
    await pool.query(
      "SELECT scope,version,checksum,applied_at FROM graeboard.schema_migrations ORDER BY version",
    )
  ).rows;
const createTask = (client, teamId, title) =>
  client.data("/tasks", {
    method: "POST",
    json: { teamId, year: 2026, fields: { title } },
  });

test("외부 요청은 자료가 저장된 뒤에만 동기화를 예약한다", async (t) => {
  const site = await externalSite(t);
  if (!site) return;
  const { pg, bucket } = site;
  await migrateSlideSchema(pg.pool);
  await pg.pool.query(
    "UPDATE graeboard.team_sync_links SET mode='paused' WHERE team_id=$1",
    [pg.teamId],
  );
  const path = `/teams/${pg.teamId}/slides`;
  const scheduled = [];
  const request = async (contentType) => {
    const ctx = pg.makeContext(
      pg.user,
      new Request("https://example.test/api" + path, {
        method: "POST",
        headers: {
          "content-type": contentType,
          "x-slide-request-id": randomUUID(),
          "x-slide-title": "sample",
        },
        body: slide("sample"),
      }),
    );
    ctx.execution = {
      waitUntil(promise) {
        scheduled.push({
          promise,
          blobs: bucket.objects.size,
          visible: pg.pool.query(
            "SELECT revision FROM graeboard_slides.slide_files WHERE team_id=$1",
            [pg.teamId],
          ),
        });
      },
    };
    return slideRoutes(ctx, path, "POST", {});
  };
  const created = await request("application/octet-stream");
  assert.equal(created.status, 201);
  await Promise.all(scheduled.map(({ promise }) => promise));
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].blobs, 1);
  assert.deepEqual((await scheduled[0].visible).rows, [{ revision: 1 }]);
  await assert.rejects(request("text/plain"), (error) => error.status === 415);
  assert.equal(scheduled.length, 1);
});

test("슬라이드 스키마가 없으면 업무는 그대로 동작하고 슬라이드 요청만 거절한다", async (t) => {
  const site = await externalSite(t);
  if (!site) return;
  const { pg, lead } = site;
  const task = await createTask(lead, pg.teamId, "슬라이드 스키마 없이 저장");
  assert.equal(task.status, 200, JSON.stringify(task.body));
  const listed = await lead.data(`/tasks?teamId=${pg.teamId}&year=2026`);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.tasks.some((item) => item.id === task.body.task.id));

  for (const refused of [
    await lead.data(`/teams/${pg.teamId}/slides`),
    await lead.upload(pg.teamId, "자료", slide("자료")),
    await lead.data(`/teams/${pg.teamId}/slide-shares/${"a".repeat(21)}`),
  ]) {
    assert.equal(refused.status, 503);
    assert.match(refused.body.error, /슬라이드 저장소/);
  }
  assert.equal(site.bucket.objects.size, 0, "no bytes without a store");
  // Still working after the refusals.
  assert.equal(
    (await createTask(lead, pg.teamId, "거절 뒤에도 저장")).status,
    200,
  );
});

test("슬라이드 스키마는 graeboard 이력을 바꾸지 않고 한 번만 적용된다", async (t) => {
  const site = await externalSite(t);
  if (!site) return;
  const { pg } = site;
  const before = await history(pg.pool);
  assert.deepEqual(
    slideSchemaMigrations.map((step) => step.checksum),
    [...SLIDE_SCHEMA_CHECKSUMS],
    "the runtime manifest matches the migration files",
  );
  assert.deepEqual(await migrateSlideSchema(pg.pool, { dryRun: true }), {
    from: 0,
    to: 2,
    applied: false,
    dryRun: true,
    checksums: [...SLIDE_SCHEMA_CHECKSUMS],
  });
  assert.equal(
    (
      await pg.pool.query(
        "SELECT 1 FROM pg_namespace WHERE nspname='graeboard_slides'",
      )
    ).rowCount,
    0,
  );
  assert.equal((await migrateSlideSchema(pg.pool)).applied, true);
  assert.equal((await migrateSlideSchema(pg.pool)).applied, false);
  assert.deepEqual(await history(pg.pool), before);
  // The team history a release without slides checks is still exactly v4.
  assert.equal(postgresHistoryVersion(before, "team"), 4);
  assert.deepEqual(
    (
      await pg.pool.query(
        "SELECT version,checksum FROM graeboard_slides.schema_migrations",
      )
    ).rows,
    SLIDE_SCHEMA_CHECKSUMS.map((checksum, index) => ({
      version: index + 1,
      checksum,
    })),
  );
  assert.deepEqual(
    (
      await pg.pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='graeboard' AND table_name LIKE 'slide%'",
      )
    ).rows,
    [],
  );

  // A store left at the first step is upgraded by the same command, and
  // until then only slide requests are refused.
  await pg.pool.query(
    "DROP TABLE graeboard_slides.slide_sync_state, graeboard_slides.slide_sync_files",
  );
  await pg.pool.query(
    "DELETE FROM graeboard_slides.schema_migrations WHERE version=2",
  );
  assert.equal(
    (await site.lead.data(`/teams/${pg.teamId}/slides`)).status,
    503,
  );
  assert.deepEqual(await migrateSlideSchema(pg.pool), {
    from: 1,
    to: 2,
    applied: true,
  });
  assert.equal(
    (await site.lead.data(`/teams/${pg.teamId}/slides`)).status,
    200,
  );
  assert.deepEqual(await history(pg.pool), before);

  // A schema whose history is not this code's is refused, data kept.
  await pg.pool.query(
    "UPDATE graeboard_slides.schema_migrations SET checksum='changed'",
  );
  await assert.rejects(migrateSlideSchema(pg.pool), /data preserved/);
  const refused = await site.lead.data(`/teams/${pg.teamId}/slides`);
  assert.equal(refused.status, 503);
  assert.match(refused.body.error, /버전/);
  assert.equal(
    (await createTask(site.lead, pg.teamId, "업무는 계속")).status,
    200,
  );
});

test("외부 저장소도 사내와 같은 저장 계약을 지킨다", async (t) => {
  const site = await externalSite(t);
  if (!site) return;
  const { pg, lead, bucket, base } = site;
  await migrateSlideSchema(pg.pool);
  const teamId = pg.teamId;
  const member = clientAt(base, await site.member("member"));
  const viewer = clientAt(base, await site.member("viewer"));
  const outsider = clientAt(base, await site.member(null));

  const mine = slide("내가 만든 내용");
  const requestId = randomUUID();
  const created = await lead.upload(teamId, " 주간회의 ", mine, requestId);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(
    [created.body.title, created.body.revision, created.body.contentHash],
    ["주간회의", 1, sha(mine)],
  );
  const id = created.body.id;
  assert.equal(
    Buffer.from(
      bucket.objects.get(slideObjectKey(teamId, sha(mine))).bytes,
    ).equals(mine),
    true,
    "bytes are stored unchanged under the slide prefix",
  );
  const read = await lead.bytes(teamId, id);
  assert.equal(read.bytes.equals(mine), true);
  assert.match(read.disposition, /\.canvaslide$/);

  // Lost create response, another member's save in between, then the retry.
  const theirs = slide("다른 팀원이 고친 내용");
  assert.equal((await member.save(teamId, id, 1, theirs)).body.revision, 2);
  const retried = await lead.upload(teamId, "주간회의", mine, requestId);
  assert.deepEqual(
    [
      retried.status,
      retried.body.id,
      retried.body.revision,
      retried.body.contentHash,
    ],
    [201, id, 1, sha(mine)],
  );
  const stale = await lead.save(
    teamId,
    id,
    retried.body.revision,
    slide("내 다음 변경"),
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.current.revision, 2);
  assert.equal((await lead.bytes(teamId, id)).bytes.equals(theirs), true);
  const saveId = randomUUID();
  const third = slide("세 번째");
  assert.equal(
    (await member.save(teamId, id, 2, third, saveId)).body.revision,
    3,
  );
  assert.equal(
    (await lead.save(teamId, id, 3, slide("네 번째"))).body.revision,
    4,
  );
  const replayed = await member.save(teamId, id, 2, third, saveId);
  assert.deepEqual(
    [replayed.status, replayed.body.revision, replayed.body.contentHash],
    [200, 3, sha(third)],
  );
  assert.equal(
    (await member.save(teamId, id, 2, slide("다른 내용"), saveId)).status,
    409,
  );
  assert.equal((await lead.save(teamId, id, 0, mine)).status, 428);

  // Permissions.
  assert.equal((await viewer.bytes(teamId, id)).status, 200);
  assert.equal(
    (await viewer.data(`/teams/${teamId}/slides`)).body.canWrite,
    false,
  );
  for (const refused of [
    await viewer.save(teamId, id, 4, mine),
    await viewer.upload(teamId, "열람자", mine),
    await viewer.data(`/teams/${teamId}/slides/${id}`, { method: "DELETE" }),
    await outsider.data(`/teams/${teamId}/slides`),
    await outsider.save(teamId, id, 4, mine),
  ])
    assert.equal(refused.status, 403);
  assert.equal((await outsider.bytes(teamId, id)).status, 403);

  // Rename, copy, share, delete.
  const base_ = `/teams/${teamId}/slides`;
  const renamed = await lead.data(`${base_}/${id}`, {
    method: "PATCH",
    json: { title: "새 이름" },
  });
  assert.deepEqual([renamed.body.title, renamed.body.revision], ["새 이름", 4]);
  const copy = await lead.data(`${base_}/${id}/copy`, {
    method: "POST",
    json: { title: "새 이름 사본", requestId: randomUUID() },
  });
  assert.equal(copy.status, 201);
  const shareBody = JSON.stringify({ access: "present", document: {} });
  const share = await viewer.data(`/teams/${teamId}/slide-shares`, {
    method: "POST",
    body: shareBody,
    headers: { "Content-Type": "text/plain" },
  });
  assert.equal(share.status, 201);
  assert.equal(
    (await member.data(`/teams/${teamId}/slide-shares/${share.body.id}`)).body
      .body,
    shareBody,
  );
  assert.equal(
    (await outsider.data(`/teams/${teamId}/slide-shares/${share.body.id}`))
      .status,
    403,
  );
  await pg.pool.query(
    "UPDATE graeboard_slides.slide_shares SET expires_at=$1",
    [new Date(Date.now() - 1000).toISOString()],
  );
  assert.equal(
    (await member.data(`/teams/${teamId}/slide-shares/${share.body.id}`))
      .status,
    404,
  );
  assert.equal(
    (await lead.data(`${base_}/${id}`, { method: "DELETE" })).status,
    200,
  );
  const afterDelete = await lead.upload(teamId, "주간회의", mine, requestId);
  assert.deepEqual([afterDelete.body.id, afterDelete.body.revision], [id, 1]);
  assert.equal((await lead.save(teamId, id, 1, slide("삭제 뒤"))).status, 404);
  assert.deepEqual(
    (await lead.data(base_)).body.files.map((file) => file.id),
    [copy.body.id],
  );

  // Validation and the common 25 MiB limit.
  assert.equal((await lead.upload(teamId, "", mine)).status, 400);
  assert.equal(
    (await lead.upload(teamId, "형식", Buffer.from("PK"))).status,
    400,
  );
  const limit = slide("limit", MAX_SLIDE_FILE_BYTES);
  const stored = await lead.upload(teamId, "한도", limit);
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  assert.equal(
    sha((await lead.bytes(teamId, stored.body.id)).bytes),
    sha(limit),
  );
  assert.equal(
    (await lead.upload(teamId, "초과", slide("over", MAX_SLIDE_FILE_BYTES + 1)))
      .status,
    413,
  );
});

test("외부 저장소는 보관 범위를 벗어난 내용만 R2에서 지우고 손상된 파일을 원본으로 내보내지 않는다", async (t) => {
  const site = await externalSite(t);
  if (!site) return;
  const { pg, lead, bucket } = site;
  await migrateSlideSchema(pg.pool);
  const teamId = pg.teamId;
  const first = slide("r1");
  const file = (await lead.upload(teamId, "자료", first)).body;
  const shared = (await lead.upload(teamId, "같은 내용", first)).body;
  const hashes = [sha(first)];
  for (let revision = 1; revision <= SLIDE_KEPT_REVISIONS + 3; revision++) {
    const bytes = slide(`r${revision + 1}`);
    hashes.push(sha(bytes));
    assert.equal(
      (await lead.save(teamId, file.id, revision, bytes)).status,
      200,
    );
  }
  const present = (hash) => bucket.objects.has(slideObjectKey(teamId, hash));
  assert.equal(present(hashes[0]), true, "still the other file's content");
  assert.deepEqual(hashes.slice(1).map(present), [
    false,
    false,
    ...Array(SLIDE_KEPT_REVISIONS + 1).fill(true),
  ]);
  assert.equal((await lead.bytes(teamId, shared.id)).bytes.equals(first), true);

  bucket.objects.get(slideObjectKey(teamId, hashes.at(-1))).bytes =
    new TextEncoder().encode("{}");
  assert.equal((await lead.bytes(teamId, file.id)).status, 500);
});

test("보관 범위를 벗어난 내용을 지우는 동안 같은 내용으로 만든 새 자료는 원본을 잃지 않는다", async (t) => {
  const site = await externalSite(t);
  if (!site) return;
  const { pg, lead, bucket } = site;
  await migrateSlideSchema(pg.pool);
  const teamId = pg.teamId;
  const reused = slide("다시 쓰일 내용");
  const file = (await lead.upload(teamId, "자료", reused)).body;
  for (let revision = 1; revision <= SLIDE_KEPT_REVISIONS; revision++)
    assert.equal(
      (await lead.save(teamId, file.id, revision, slide(`r${revision + 1}`)))
        .status,
      200,
    );
  const key = slideObjectKey(teamId, sha(reused));
  assert.equal(bucket.objects.has(key), true);

  // The physical delete of the expired content is held open, exactly where a
  // slow object store would be, while the same bytes are saved as a new file.
  const remove = bucket.delete.bind(bucket);
  let started;
  const reached = new Promise((resolve) => (started = resolve));
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  bucket.delete = async (target) => {
    if (target === key) {
      started();
      await gate;
    }
    return remove(target);
  };
  const expiring = lead.save(
    teamId,
    file.id,
    SLIDE_KEPT_REVISIONS + 1,
    slide("만료시키는 저장"),
  );
  await reached;
  const creating = lead.upload(teamId, "같은 내용의 새 자료", reused);
  // Give the create every chance to finish before the delete does.
  await new Promise((resolve) => setTimeout(resolve, 300));
  release();
  const [saved, created] = await Promise.all([expiring, creating]);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const read = await lead.bytes(teamId, created.body.id);
  assert.equal(read.status, 200, "the new file's original is still stored");
  assert.equal(read.bytes.equals(reused), true);

  // The same holds when the content comes back as a new revision.
  bucket.delete = remove;
  const other = (await lead.upload(teamId, "다른 자료", slide("처음"))).body;
  let again;
  const reachedAgain = new Promise((resolve) => (again = resolve));
  let releaseAgain;
  const gateAgain = new Promise((resolve) => (releaseAgain = resolve));
  const firstKey = slideObjectKey(teamId, sha(slide("처음")));
  for (let revision = 1; revision <= SLIDE_KEPT_REVISIONS; revision++)
    await lead.save(teamId, other.id, revision, slide(`o${revision + 1}`));
  bucket.delete = async (target) => {
    if (target === firstKey) {
      again();
      await gateAgain;
    }
    return remove(target);
  };
  const expiringAgain = lead.save(
    teamId,
    other.id,
    SLIDE_KEPT_REVISIONS + 1,
    slide("만료시키는 저장 2"),
  );
  await reachedAgain;
  const reverting = lead.save(
    teamId,
    file.id,
    SLIDE_KEPT_REVISIONS + 2,
    slide("처음"),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  releaseAgain();
  const [, reverted] = await Promise.all([expiringAgain, reverting]);
  assert.equal(reverted.status, 200, JSON.stringify(reverted.body));
  assert.equal(
    (await lead.bytes(teamId, file.id)).bytes.equals(slide("처음")),
    true,
  );
});

test("슬라이드 도입 전 릴리스의 외부 코드는 슬라이드 스키마가 있는 DB에서 업무를 그대로 읽고 쓴다", async (t) => {
  const site = await externalSite(t);
  if (!site) return;
  const { pg, lead } = site;
  await migrateSlideSchema(pg.pool);
  const file = await lead.upload(pg.teamId, "새 릴리스의 자료", slide("자료"));
  assert.equal(file.status, 201);

  // The actual source of the earlier release, read from Git.
  const old = mkdtempSync(join(tmpdir(), "graeboard-before-slides-"));
  t.after(() => rmSync(old, { recursive: true, force: true }));
  let archive;
  try {
    archive = execFileSync(
      "git",
      [
        "archive",
        RELEASE_BEFORE_SLIDES,
        "worker",
        "server",
        "shared",
        "edge",
        "tests/support",
        "package.json",
      ],
      { cwd: root, maxBuffer: 256 * 1024 * 1024 },
    );
  } catch {
    assert.fail(
      `Git commit ${RELEASE_BEFORE_SLIDES} is required: git fetch origin ${RELEASE_BEFORE_SLIDES}`,
    );
  }
  mkdirSync(old, { recursive: true });
  execFileSync("tar", ["-x", "-C", old], { input: archive });
  symlinkSync(join(root, "node_modules"), join(old, "node_modules"));
  const { createExternalRouteApp: createOld } = await import(
    pathToFileURL(join(old, "tests/support/external-route-fixture.mjs")).href
  );
  const oldClient = clientAt(
    await start(t, createOld({ env: pg.env, defaultUserId: pg.user.id })),
    pg.user.id,
  );
  // Reads what the new release wrote, writes, and the new release reads back.
  const before = await createTask(lead, pg.teamId, "새 릴리스가 만든 업무");
  const written = await createTask(
    oldClient,
    pg.teamId,
    "이전 릴리스가 만든 업무",
  );
  assert.equal(written.status, 200, JSON.stringify(written.body));
  for (const client of [oldClient, lead]) {
    const listed = await client.data(`/tasks?teamId=${pg.teamId}&year=2026`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const ids = listed.body.tasks.map((task) => task.id);
    assert.ok(ids.includes(before.body.task.id));
    assert.ok(ids.includes(written.body.task.id));
  }
  // The earlier release has no slide route; the stored file is untouched.
  assert.equal(
    (await oldClient.data(`/teams/${pg.teamId}/slides`)).status,
    404,
  );
  assert.equal(
    (await lead.bytes(pg.teamId, file.body.id)).bytes.equals(slide("자료")),
    true,
  );
});
