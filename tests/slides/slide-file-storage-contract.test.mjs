import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../server/app.mjs";
import { openDatabase } from "../../server/db.mjs";
import {
  SLIDE_KEPT_REVISIONS,
  SLIDE_STORE_FILE,
  SqliteSlideFileRepository,
  openSlideDatabase,
  slideBlobPath,
} from "../../server/storage/slides/sqlite-slide-files.mjs";
import { SlideFileService } from "../../server/storage/slides/slide-file-service.mjs";
import {
  MAX_SLIDE_FILE_BYTES,
  SLIDE_SHARE_TTL_MS,
} from "../../shared/slides/slide-file-rules.js";
import { unpack } from "../../shared/formatting/compact.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// A `.canvaslide` file is one JSON object; the server never reads inside it.
const slide = (text, size = 0) => {
  const body = JSON.stringify({ version: 1, name: text, pad: "" });
  return Buffer.from(
    size
      ? body.replace('"pad":""', `"pad":"${"x".repeat(size - body.length)}"`)
      : body,
  );
};

async function site(t, directory = mkdtempSync(join(tmpdir(), "slides-"))) {
  const db = openDatabase(join(directory, "team.sqlite"));
  const app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: join(directory, "images"),
    slideFilesDir: join(directory, "slide-files"),
    slideEditorDir: join(directory, "editor"),
    syncOptions: { setupConfigPath: join(directory, ".env") },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    await new Promise((resolve) => server.close(resolve));
    await app.locals.sync.close();
    app.locals.slideFileRepository.close();
    db.close();
  };
  t.after(async () => {
    if (server.listening) await close();
    rmSync(directory, { recursive: true, force: true });
  });
  const client = (cookie = "") => {
    const call = async (path, options = {}) => {
      const response = await fetch(origin + path, {
        ...options,
        headers: {
          "X-Requested-With": "WeeklyPlan",
          ...(cookie ? { cookie } : {}),
          ...(options.json ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
        body: options.json ? JSON.stringify(options.json) : options.body,
      });
      return response;
    };
    const data = async (path, options) => {
      const response = await call(path, options);
      return { status: response.status, body: unpack(await response.json()) };
    };
    const upload = (teamId, title, bytes, requestId = randomUUID()) =>
      data(`/api/teams/${teamId}/slides`, {
        method: "POST",
        body: bytes,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Slide-Title": encodeURIComponent(title),
          "X-Slide-Request-Id": requestId,
        },
      });
    const save = (teamId, fileId, base, bytes, requestId = randomUUID()) =>
      data(`/api/teams/${teamId}/slides/${fileId}/content`, {
        method: "PUT",
        body: bytes,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Slide-Base-Revision": String(base),
          "X-Slide-Request-Id": requestId,
        },
      });
    const bytes = async (teamId, fileId) => {
      const response = await call(
        `/api/teams/${teamId}/slides/${fileId}/content`,
      );
      return {
        status: response.status,
        revision: Number(response.headers.get("X-Slide-Revision")),
        bytes: Buffer.from(await response.arrayBuffer()),
      };
    };
    return { call, data, upload, save, bytes };
  };
  const session = (response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  const login = async (username, password) =>
    client(
      session(
        await client().call("/api/auth/login", {
          method: "POST",
          json: { username, password },
        }),
      ),
    );
  return { app, db, directory, origin, client, session, login, close };
}
async function team(t, directory) {
  const host = await site(t, directory);
  const setup = await host.client().call("/api/auth/setup", {
    method: "POST",
    json: {
      username: "lead@example.com",
      password: "lead-password-1",
      name: "팀장",
      teamName: "슬라이드팀",
    },
  });
  assert.equal(setup.status, 201);
  const lead = host.client(host.session(setup));
  const teamId = (await lead.data("/api/bootstrap")).body.teams[0].id;
  const add = async (role) => {
    const username = `${role || "outsider"}-${randomUUID()}@example.com`;
    const created = await lead.data("/api/admin/users", {
      method: "POST",
      json: {
        username,
        password: "peer-password-1",
        name: role || "외부인",
        memberships: role ? [{ teamId, role }] : [],
      },
    });
    assert.equal(created.status, 201);
    return host.login(username, "peer-password-1");
  };
  return { ...host, lead, teamId, add };
}

test("편집기 제목과 파일을 함께 저장하고 목록에서 바뀐 제목과 경합하면 둘 다 보존한다", async (t) => {
  const { lead, teamId } = await team(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const file = (await lead.upload(teamId, "처음", slide("처음"))).body;
  t.mock.timers.tick(1000);
  const newer = (await lead.upload(teamId, "나중 자료", slide("나중 자료")))
    .body;
  const listPath = "/api/teams/" + teamId + "/slides";
  const path = listPath + "/" + file.id;
  t.mock.timers.tick(1000);
  const save = (baseTitle, title, revision) =>
    lead.data(path + "/content", {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Slide-Request-Id": randomUUID(),
        "X-Slide-Base-Revision": String(revision),
        "X-Slide-Base-Title": encodeURIComponent(baseTitle),
        "X-Slide-Title": encodeURIComponent(title),
      },
      body: slide(title),
    });
  const saved = await save("처음", "새 이름", 1);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 2);
  assert.equal(saved.body.title, "새 이름");
  await lead.data(path, { method: "PATCH", json: { title: "동료의 이름" } });
  assert.deepEqual(
    (await lead.data(listPath)).body.files.map((row) => row.id),
    [newer.id, file.id],
    "editing or renaming an older file must preserve creation order",
  );
  const conflict = await save("새 이름", "내 이름", 2);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.details.current.title, "동료의 이름");
  assert.deepEqual((await lead.bytes(teamId, file.id)).bytes, slide("새 이름"));
  assert.equal((await lead.data(path)).body.revision, 2);
  assert.equal((await save("동료의 이름", " ", 2)).status, 400);
});

test("팀 자료는 받은 바이트 그대로 저장되고 서버를 다시 열어도 남는다", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slides-"));
  const first = await team(t, directory);
  const original = slide("주간회의");
  const created = await first.lead.upload(first.teamId, " 주간회의 ", original);
  assert.equal(created.status, 201);
  assert.deepEqual(
    {
      title: created.body.title,
      revision: created.body.revision,
      byteLength: created.body.byteLength,
      contentHash: created.body.contentHash,
    },
    {
      title: "주간회의",
      revision: 1,
      byteLength: original.byteLength,
      contentHash: sha(original),
    },
  );
  const edited = slide("주간회의 2차");
  assert.equal(
    (await first.lead.save(first.teamId, created.body.id, 1, edited)).body
      .revision,
    2,
  );
  assert.equal(
    readFileSync(
      slideBlobPath(join(directory, "slide-files"), first.teamId, sha(edited)),
    ).equals(edited),
    true,
  );
  await first.close();

  // A new process on the same paths: the same file, revision and bytes.
  const db = openDatabase(join(directory, "team.sqlite"));
  const repository = new SqliteSlideFileRepository({
    directory: join(directory, "slide-files"),
  });
  t.after(() => {
    repository.close();
    db.close();
  });
  const stored = repository.read(first.teamId, created.body.id);
  assert.equal(stored.file.revision, 2);
  assert.equal(Buffer.from(stored.bytes).equals(edited), true);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'slide%'").all(),
    [],
    "the task database has no slide table",
  );
});

test("기준 버전이 다르면 저장하지 않고 두 내용을 모두 보존하며 같은 요청은 한 번만 반영한다", async (t) => {
  const { lead, teamId, add, directory } = await team(t);
  const member = await add("member");
  const file = (await lead.upload(teamId, "충돌", slide("원본"))).body;
  const mine = slide("내 변경");
  const theirs = slide("다른 팀원의 변경");
  const requestId = randomUUID();
  const first = await member.save(teamId, file.id, 1, theirs, requestId);
  assert.equal(first.body.revision, 2);

  const refused = await lead.save(teamId, file.id, 1, mine);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.details.current.revision, 2);
  assert.equal(refused.body.details.current.contentHash, sha(theirs));
  assert.equal((await lead.bytes(teamId, file.id)).bytes.equals(theirs), true);

  // A lost response is retried with the same request ID.
  const retry = await member.save(teamId, file.id, 1, theirs, requestId);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.revision, 2);
  assert.equal(
    (await lead.data(`/api/teams/${teamId}/slides/${file.id}`)).body.revision,
    2,
  );
  const again = await lead.upload(
    teamId,
    "한 번만",
    slide("새 자료"),
    requestId,
  );
  const repeated = await lead.upload(
    teamId,
    "한 번만",
    slide("새 자료"),
    requestId,
  );
  assert.equal(again.body.id, repeated.body.id);
  assert.equal(
    (await lead.data(`/api/teams/${teamId}/slides`)).body.files.filter(
      (item) => item.title === "한 번만",
    ).length,
    1,
  );
  // My refused bytes were written before the check and stay readable on disk.
  assert.equal(
    existsSync(
      slideBlobPath(join(directory, "slide-files"), teamId, sha(mine)),
    ),
    true,
  );
  assert.equal((await lead.save(teamId, file.id, 0, mine)).status, 428);
});

test("응답을 잃은 생성 요청을 다시 보내면 처음 만든 결과를 받고, 그 사이의 다른 저장을 덮지 않는다", async (t) => {
  const { lead, teamId, add } = await team(t);
  const member = await add("member");
  const mine = slide("내가 만든 내용");
  const requestId = randomUUID();
  // The response of this create never reached the author.
  const created = await lead.upload(teamId, "새 자료", mine, requestId);
  const theirs = slide("다른 팀원이 고친 내용");
  assert.equal(
    (await member.save(teamId, created.body.id, 1, theirs)).body.revision,
    2,
  );
  await member.data(`/api/teams/${teamId}/slides/${created.body.id}`, {
    method: "PATCH",
    json: { title: "바뀐 이름" },
  });

  const retried = await lead.upload(teamId, "새 자료", mine, requestId);
  assert.equal(retried.status, 201);
  assert.deepEqual(
    {
      id: retried.body.id,
      revision: retried.body.revision,
      contentHash: retried.body.contentHash,
      byteLength: retried.body.byteLength,
      updatedBy: retried.body.updatedBy,
    },
    {
      id: created.body.id,
      revision: 1,
      contentHash: sha(mine),
      byteLength: mine.byteLength,
      updatedBy: created.body.updatedBy,
    },
  );
  // The author's session is bound to revision 1, so its next save is refused.
  const stale = await lead.save(
    teamId,
    created.body.id,
    retried.body.revision,
    slide("내 다음 변경"),
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.current.revision, 2);
  assert.equal(
    (await lead.bytes(teamId, created.body.id)).bytes.equals(theirs),
    true,
  );

  // The same holds for a repeated save, and when the file was deleted since.
  const saveId = randomUUID();
  const third = slide("세 번째");
  assert.equal(
    (await member.save(teamId, created.body.id, 2, third, saveId)).body
      .revision,
    3,
  );
  assert.equal(
    (await lead.save(teamId, created.body.id, 3, slide("네 번째"))).body
      .revision,
    4,
  );
  const replayed = await member.save(teamId, created.body.id, 2, third, saveId);
  assert.deepEqual(
    [replayed.status, replayed.body.revision, replayed.body.contentHash],
    [200, 3, sha(third)],
  );
  assert.equal(
    (await member.save(teamId, created.body.id, 2, slide("다른 내용"), saveId))
      .status,
    409,
    "a request ID names one payload",
  );
  assert.equal(
    (await lead.upload(teamId, "새 자료", slide("다른 내용"), requestId))
      .status,
    409,
  );

  await member.data(`/api/teams/${teamId}/slides/${created.body.id}`, {
    method: "DELETE",
  });
  const afterDelete = await lead.upload(teamId, "새 자료", mine, requestId);
  assert.deepEqual(
    [afterDelete.body.id, afterDelete.body.revision],
    [created.body.id, 1],
  );
  assert.equal(
    (await lead.save(teamId, created.body.id, 1, slide("삭제 뒤 저장"))).status,
    404,
  );
  assert.equal(
    (await lead.data(`/api/teams/${teamId}/slides`)).body.files.length,
    0,
    "the retry did not bring the deleted file back",
  );
});

test("열람자는 읽기만 하고 팀 밖 사용자와 비로그인 요청은 원본을 받지 못한다", async (t) => {
  const { lead, teamId, add, client } = await team(t);
  const bytes = slide("권한");
  const file = (await lead.upload(teamId, "권한", bytes)).body;
  const viewer = await add("viewer");
  const outsider = await add(null);
  const base = `/api/teams/${teamId}/slides`;
  assert.equal((await viewer.bytes(teamId, file.id)).bytes.equals(bytes), true);
  assert.equal((await viewer.data(base)).body.canWrite, false);
  for (const refused of [
    await viewer.save(teamId, file.id, 1, bytes),
    await viewer.upload(teamId, "열람자", bytes),
    await viewer.data(`${base}/${file.id}`, {
      method: "PATCH",
      json: { title: "x" },
    }),
    await viewer.data(`${base}/${file.id}/copy`, {
      method: "POST",
      json: { title: "x", requestId: randomUUID() },
    }),
    await viewer.data(`${base}/${file.id}`, { method: "DELETE" }),
    await outsider.data(base),
    await outsider.data(`${base}/${file.id}`),
    await outsider.save(teamId, file.id, 1, bytes),
  ])
    assert.equal(refused.status, 403);
  assert.equal((await outsider.bytes(teamId, file.id)).status, 403);
  assert.equal((await client().bytes(teamId, file.id)).status, 401);
  assert.equal((await lead.data(`${base}/${file.id}`)).body.revision, 1);

  // Another team's ID never reaches this team's file.
  const other = await lead.data("/api/admin/teams", {
    method: "POST",
    json: { name: "다른 팀" },
  });
  assert.equal(other.status, 201);
  assert.equal((await lead.bytes(other.body.id, file.id)).status, 404);
  assert.equal((await lead.save(other.body.id, file.id, 1, bytes)).status, 404);
});

test("이름 변경·사본·삭제와 파일 검증", async (t) => {
  const { lead, teamId } = await team(t);
  const base = `/api/teams/${teamId}/slides`;
  const bytes = slide("자료");
  const file = (await lead.upload(teamId, "자료", bytes)).body;
  const renamed = await lead.data(`${base}/${file.id}`, {
    method: "PATCH",
    json: { title: "새 이름" },
  });
  assert.deepEqual([renamed.body.title, renamed.body.revision], ["새 이름", 1]);
  const copy = await lead.data(`${base}/${file.id}/copy`, {
    method: "POST",
    json: { title: "새 이름 사본", requestId: randomUUID() },
  });
  assert.equal(copy.status, 201);
  assert.notEqual(copy.body.id, file.id);
  assert.equal(
    (await lead.bytes(teamId, copy.body.id)).bytes.equals(bytes),
    true,
  );
  const download = await lead.call(`${base}/${file.id}/content`);
  assert.match(
    download.headers.get("content-disposition"),
    /filename\*=UTF-8''%EC%83%88%20%EC%9D%B4%EB%A6%84\.canvaslide$/,
  );
  await download.arrayBuffer();

  assert.equal(
    (await lead.data(`${base}/${file.id}`, { method: "DELETE" })).status,
    200,
  );
  assert.equal((await lead.bytes(teamId, file.id)).status, 404);
  assert.equal((await lead.save(teamId, file.id, 1, bytes)).status, 404);
  assert.deepEqual(
    (await lead.data(base)).body.files.map((item) => item.id),
    [copy.body.id],
  );

  assert.equal((await lead.upload(teamId, "", bytes)).status, 400);
  assert.equal((await lead.upload(teamId, "x".repeat(121), bytes)).status, 400);
  assert.equal(
    (await lead.upload(teamId, "형식", Buffer.from("PK\u0003\u0004"))).status,
    400,
  );
  assert.equal(
    (await lead.upload(teamId, "요청 ID", bytes, "short")).status,
    400,
  );
  assert.equal(
    (
      await lead.data(base, {
        method: "POST",
        json: { title: "JSON 본문" },
        headers: { "X-Slide-Title": "x", "X-Slide-Request-Id": randomUUID() },
      })
    ).status,
    415,
  );
});

test("파일 한도 25MiB는 경계까지 저장하고 넘으면 거절한다", async (t) => {
  const { lead, teamId } = await team(t);
  const limit = slide("limit", MAX_SLIDE_FILE_BYTES);
  assert.equal(limit.byteLength, 25 * 1024 * 1024);
  const stored = await lead.upload(teamId, "한도", limit);
  assert.equal(stored.status, 201);
  assert.equal(stored.body.byteLength, MAX_SLIDE_FILE_BYTES);
  assert.equal(
    sha((await lead.bytes(teamId, stored.body.id)).bytes),
    sha(limit),
  );
  const over = await lead.upload(
    teamId,
    "초과",
    slide("over", MAX_SLIDE_FILE_BYTES + 1),
  );
  assert.equal(over.status, 413);
  assert.equal(
    (
      await lead.save(
        teamId,
        stored.body.id,
        1,
        slide("over", MAX_SLIDE_FILE_BYTES + 1),
      )
    ).status,
    413,
  );
  assert.equal(
    (await lead.data(`/api/teams/${teamId}/slides`)).body.files.length,
    1,
  );
});

test("바이트는 현재와 직전 10개 revision만 남기고 다른 자료가 쓰는 내용은 지우지 않는다", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slides-"));
  const repository = new SqliteSlideFileRepository({ directory });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const teamId = randomUUID();
  const put = (bytes, extra) => ({
    teamId,
    bytes,
    contentHash: sha(bytes),
    requestId: randomUUID(),
    userId: "user",
    at: new Date().toISOString(),
    ...extra,
  });
  const first = slide("r1");
  const file = repository.create(
    put(first, { id: randomUUID(), title: "자료" }),
  );
  const shared = repository.create(
    put(first, { id: randomUUID(), title: "같은 내용" }),
  );
  const hashes = [sha(first)];
  for (let revision = 1; revision <= SLIDE_KEPT_REVISIONS + 3; revision++) {
    const bytes = slide(`r${revision + 1}`);
    hashes.push(sha(bytes));
    assert.equal(
      repository.replace(
        put(bytes, { fileId: file.id, baseRevision: revision }),
      ).saved,
      true,
    );
  }
  const present = (hash) => existsSync(slideBlobPath(directory, teamId, hash));
  // Revision 1 is still the other file's content.
  assert.equal(present(hashes[0]), true);
  assert.deepEqual(hashes.slice(1).map(present), [
    false,
    false,
    ...Array(SLIDE_KEPT_REVISIONS + 1).fill(true),
  ]);
  assert.equal(
    Buffer.from(repository.read(teamId, shared.id).bytes).equals(first),
    true,
  );
  assert.equal(
    repository.get(teamId, file.id).revision,
    SLIDE_KEPT_REVISIONS + 4,
  );

  // A damaged file is reported, never returned as the team original.
  writeFileSync(slideBlobPath(directory, teamId, hashes.at(-1)), "{}");
  assert.throws(() => repository.read(teamId, file.id), /해시/);

  repository.removeTeam(teamId);
  assert.deepEqual(repository.list(teamId), []);
  assert.equal(existsSync(join(directory, "blobs", teamId)), false);
});

test("임시 공유는 24시간 뒤 사라지고 팀 원본과 다른 곳에 보관한다", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slides-"));
  const repository = new SqliteSlideFileRepository({ directory });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let now = new Date("2026-11-21T00:00:00Z");
  const teamId = randomUUID();
  const member = {
    id: "member",
    teamIds: [teamId],
    teamRoles: { [teamId]: "viewer" },
  };
  const service = (user) =>
    new SlideFileService(repository, user, {
      teamAccess(candidate, id) {
        if (!candidate.teamIds.includes(id))
          throw Object.assign(new Error("denied"), { status: 403 });
      },
      now: () => now,
    });
  const body = JSON.stringify({ access: "present", document: {} });
  const { id } = await service(member).createShare(teamId, body);
  assert.match(id, /^[A-Za-z0-9_-]{21}$/);
  assert.equal(await service(member).readShare(teamId, id), body);
  assert.deepEqual(repository.list(teamId), [], "a share is not a team file");
  await assert.rejects(
    service({ id: "other", teamIds: [], teamRoles: {} }).readShare(teamId, id),
    { status: 403 },
  );
  await assert.rejects(service(member).readShare(randomUUID(), id), {
    status: 403,
  });
  now = new Date(now.getTime() + SLIDE_SHARE_TTL_MS);
  await assert.rejects(service(member).readShare(teamId, id), { status: 404 });
  await assert.rejects(
    service(member).createShare(teamId, "x".repeat(5 * 1024 * 1024 + 1)),
    { status: 413 },
  );
});

test("지원하지 않는 슬라이드 저장소는 데이터를 둔 채 열기를 거절한다", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slides-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fresh = join(directory, "fresh");
  const db = openSlideDatabase(fresh);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(
    db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
  openSlideDatabase(fresh).close();

  const raw = (name, sql) => {
    mkdirSync(join(directory, name));
    const database = new DatabaseSync(join(directory, name, SLIDE_STORE_FILE));
    database.exec(sql);
    database.close();
  };
  raw("newer", "CREATE TABLE slide_files(id TEXT); PRAGMA user_version=3;");
  raw("unversioned", "CREATE TABLE slide_files(id TEXT);");
  for (const name of ["newer", "unversioned"]) {
    assert.throws(() => openSlideDatabase(join(directory, name)));
    assert.throws(
      () => new SqliteSlideFileRepository({ directory: join(directory, name) }),
    );
    const kept = new DatabaseSync(join(directory, name, SLIDE_STORE_FILE));
    assert.equal(
      kept
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='slide_files'",
        )
        .get().n,
      1,
    );
    kept.close();
  }
  const changed = new DatabaseSync(join(fresh, SLIDE_STORE_FILE));
  changed.exec("UPDATE schema_migrations SET checksum='changed'");
  changed.close();
  assert.throws(() => openSlideDatabase(fresh), /변환 이력/);
});

test("팀을 영구 삭제하면 그 팀의 슬라이드 자료와 파일도 함께 지운다", async (t) => {
  const { lead, teamId, directory, app } = await team(t);
  const created = await lead.data("/api/admin/teams", {
    method: "POST",
    json: { name: "지울 팀" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const doomed = created.body.id;
  const keep = (await lead.upload(teamId, "남는 자료", slide("남는 자료")))
    .body;
  const gone = await lead.upload(doomed, "지울 자료", slide("지울 자료"));
  assert.equal(gone.status, 201, JSON.stringify(gone.body));
  const removed = await lead.data(`/api/admin/teams/${doomed}`, {
    method: "DELETE",
    json: { confirmed: true },
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual(app.locals.slideFileRepository.list(doomed), []);
  assert.equal(
    existsSync(join(directory, "slide-files", "blobs", doomed)),
    false,
  );
  assert.deepEqual(readdirSync(join(directory, "slide-files", "blobs")), [
    teamId,
  ]);
  assert.equal((await lead.bytes(teamId, keep.id)).status, 200);
});
