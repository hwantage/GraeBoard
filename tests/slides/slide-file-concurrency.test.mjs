import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SLIDE_KEPT_REVISIONS,
  SqliteSlideFileRepository,
  slideBlobPath,
} from "../../server/storage/slides/sqlite-slide-files.mjs";
import { SlideFileService } from "../../server/storage/slides/slide-file-service.mjs";
import { syncSlideFiles } from "../../server/sync/core/slide-file-branch.mjs";
import { MAX_SLIDE_FILE_BYTES } from "../../shared/slides/slide-file-rules.js";
import { sha, slide } from "../support/slide-sync-fixture.mjs";

// The internal site is one process: while it handles the bytes of a slide
// file, every other request waits unless that work leaves the event loop
// free. These checks run the store as the server does and look at what else
// got done meanwhile, and at what two overlapping operations leave behind.

function store(t, options) {
  const directory = mkdtempSync(join(tmpdir(), "slide-concurrency-"));
  const repository = new SqliteSlideFileRepository({ directory, ...options });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const teamId = randomUUID();
  const service = new SlideFileService(
    repository,
    { id: "member", teamIds: [teamId], teamRoles: { [teamId]: "member" } },
    { teamAccess() {} },
  );
  const put = (bytes, extra) => ({
    teamId,
    bytes,
    contentHash: sha(bytes),
    requestId: randomUUID(),
    userId: "member",
    at: new Date().toISOString(),
    ...extra,
  });
  const present = (bytes) =>
    existsSync(slideBlobPath(directory, teamId, sha(bytes)));
  return { directory, repository, teamId, service, put, present };
}

// What the server did until `work` settled: how often its event loop turned,
// and whether a request that arrived after `work` began was answered first.
// Neither depends on how fast the machine is: work that never leaves the
// thread settles before the loop turns even once.
async function meanwhile(work, request) {
  let settled = false;
  let turns = 0;
  let answeredFirst = false;
  const pending = work().finally(() => (settled = true));
  setImmediate(function turn() {
    if (settled) return;
    turns++;
    setImmediate(turn);
  });
  setImmediate(async () => {
    await request();
    answeredFirst = !settled;
  });
  return { result: await pending, turns, answeredFirst };
}
const assertServed = (name, { turns, answeredFirst }, atLeast) => {
  assert.equal(
    answeredFirst,
    true,
    `${name}: another request was answered before it finished`,
  );
  assert.ok(
    turns >= atLeast,
    `${name}: the event loop turned ${turns} times, expected at least ${atLeast}`,
  );
};

test("25MiB 자료를 만들고·저장하고·읽고·복사하는 동안에도 다른 요청에 답한다", async (t) => {
  const { service, teamId } = store(t);
  const list = () => service.list(teamId);
  const first = slide("first", MAX_SLIDE_FILE_BYTES);
  const next = slide("next", MAX_SLIDE_FILE_BYTES);

  const created = await meanwhile(
    () =>
      service.create(teamId, {
        title: "큰 자료",
        bytes: first,
        requestId: randomUUID(),
      }),
    list,
  );
  // Hashing, writing, syncing and moving the file are separate steps.
  assertServed("create", created, 4);
  assert.equal(created.result.contentHash, sha(first));

  const saved = await meanwhile(
    () =>
      service.save(teamId, created.result.id, {
        baseRevision: 1,
        bytes: next,
        requestId: randomUUID(),
      }),
    list,
  );
  assertServed("save", saved, 4);
  assert.equal(saved.result.revision, 2);

  const read = await meanwhile(
    () => service.read(teamId, created.result.id),
    list,
  );
  // Reading and verifying the hash.
  assertServed("read", read, 2);
  assert.equal(Buffer.from(read.result.bytes).equals(next), true);

  const copied = await meanwhile(
    () =>
      service.copy(teamId, created.result.id, {
        title: "큰 자료 사본",
        requestId: randomUUID(),
      }),
    list,
  );
  assertServed("copy", copied, 2);
  assert.equal(copied.result.contentHash, sha(next));
});

// A branch kept in memory. Its calls never leave the thread, so every turn of
// the event loop during a pass comes from the store.
function memoryBranch() {
  const commits = new Map();
  let head = null;
  return {
    readHead: async () => head,
    readCommit: async (oid) => ({
      files: [...commits.get(oid)].map(([path, file]) => ({
        path,
        oid: file.oid,
      })),
    }),
    readFile: async (oid, path) => commits.get(oid).get(path).bytes,
    createCandidate: async (parent, files) => {
      const tree = new Map(parent ? commits.get(parent) : []);
      for (const [path, bytes] of files)
        tree.set(path, { oid: randomUUID(), bytes });
      const oid = randomUUID();
      commits.set(oid, tree);
      return oid;
    },
    publish: async (commit, parent) => {
      if (head !== parent) return false;
      head = commit;
      return true;
    },
  };
}

test("동기화 한 회차가 25MiB 자료 여러 개를 게시하고 받는 동안에도 다른 요청에 답한다", async (t) => {
  const inside = store(t);
  const outside = store(t);
  const teamId = inside.teamId;
  const transport = memoryBranch();
  const files = 3;
  for (let index = 0; index < files; index++)
    await inside.repository.create(
      inside.put(slide(`file ${index}`, MAX_SLIDE_FILE_BYTES), {
        id: randomUUID(),
        title: `자료 ${index}`,
      }),
    );

  const published = await meanwhile(
    () =>
      syncSlideFiles({
        transport,
        store: inside.repository,
        teamId,
        site: "internal",
      }),
    () => inside.service.list(teamId),
  );
  assert.equal(published.result.published, files);
  // At least the read of each file leaves the thread.
  assertServed("publish", published, files);

  const received = await meanwhile(
    () =>
      syncSlideFiles({
        transport,
        store: outside.repository,
        teamId,
        site: "external",
      }),
    () => outside.repository.list(teamId),
  );
  assert.equal(received.result.received, files);
  assertServed("receive", received, files);
  assert.deepEqual(
    outside.repository
      .list(teamId)
      .map((file) => file.contentHash)
      .sort(),
    inside.repository
      .list(teamId)
      .map((file) => file.contentHash)
      .sort(),
  );
});

test("같은 기준에서 동시에 온 두 저장은 하나만 반영되고 다른 하나는 409로 두 내용을 모두 남긴다", async (t) => {
  const { service, repository, teamId, present } = store(t);
  const file = await service.create(teamId, {
    title: "자료",
    bytes: slide("원본"),
    requestId: randomUUID(),
  });
  const contents = [slide("내 변경"), slide("다른 팀원의 변경")];
  const outcomes = await Promise.allSettled(
    contents.map((bytes) =>
      service.save(teamId, file.id, {
        baseRevision: 1,
        bytes,
        requestId: randomUUID(),
      }),
    ),
  );
  const won = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
  const lost = outcomes[1 - won];
  assert.equal(outcomes[won].value.revision, 2);
  assert.equal(lost.status, "rejected");
  assert.equal(lost.reason.status, 409);
  assert.equal(lost.reason.details.current.revision, 2);
  assert.equal(lost.reason.details.current.contentHash, sha(contents[won]));
  const stored = await repository.read(teamId, file.id);
  assert.equal(stored.file.revision, 2);
  assert.equal(Buffer.from(stored.bytes).equals(contents[won]), true);
  assert.deepEqual(contents.map(present), [true, true]);
});

test("같은 생성 요청이 동시에 두 번 와도 자료는 하나만 생긴다", async (t) => {
  const { service, teamId } = store(t);
  const request = {
    title: "한 번만",
    bytes: slide("새 자료"),
    requestId: randomUUID(),
  };
  const [first, second] = await Promise.all([
    service.create(teamId, request),
    service.create(teamId, request),
  ]);
  assert.equal(first.id, second.id);
  assert.deepEqual([first.revision, second.revision], [1, 1]);
  assert.equal((await service.list(teamId)).files.length, 1);
});

test("바이트를 쓰는 동안 삭제되거나 이름이 바뀐 자료에는 저장을 반영하지 않는다", async (t) => {
  const { repository, teamId, put } = store(t);
  const original = slide("원본");
  const create = (title) =>
    repository.create(put(original, { id: randomUUID(), title }));
  const removed = await create("지울 자료");
  const renamed = await create("자료");
  const at = new Date().toISOString();

  // Each save has passed its first look at the file and is writing bytes.
  const afterDelete = repository.replace(
    put(slide("삭제 뒤 저장"), { fileId: removed.id, baseRevision: 1 }),
  );
  repository.remove({ teamId, fileId: removed.id, at });
  const afterRename = repository.replace(
    put(slide("내 이름으로 저장"), {
      fileId: renamed.id,
      baseRevision: 1,
      baseTitle: "자료",
      title: "내 이름",
    }),
  );
  repository.rename({
    teamId,
    fileId: renamed.id,
    title: "동료의 이름",
    userId: "peer",
    at,
  });

  assert.equal(await afterDelete, null, "answered as a missing file");
  const refused = await afterRename;
  assert.equal(refused.saved, false);
  assert.deepEqual(
    [refused.file.title, refused.file.revision, refused.file.contentHash],
    ["동료의 이름", 1, sha(original)],
  );
  // Neither file got a revision; the deleted one stays deleted.
  const rows = new Map(
    repository.syncFiles(teamId).map((file) => [file.id, file]),
  );
  for (const [id, deleted] of [
    [removed.id, true],
    [renamed.id, false],
  ])
    assert.deepEqual(
      [
        rows.get(id).revision,
        rows.get(id).contentHash,
        !!rows.get(id).deletedAt,
      ],
      [1, sha(original), deleted],
    );
});

test("동기화가 받은 버전을 쓰는 동안 이쪽에서 저장하면 둘 중 먼저 기록된 쪽만 반영된다", async (t) => {
  const { repository, teamId, put } = store(t);
  const original = slide("원본");
  const file = await repository.create(
    put(original, { id: randomUUID(), title: "자료" }),
  );
  const theirs = slide("상대 사이트의 변경");
  const mine = slide("이쪽의 변경");
  const [applied, saved] = await Promise.all([
    repository.syncApply(teamId, {
      meta: {
        id: file.id,
        title: "자료",
        contentHash: sha(theirs),
        byteLength: theirs.byteLength,
        chunks: [sha(theirs)],
        version: `${randomUUID()}:1`,
        updatedBy: { id: "peer" },
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      },
      metaOid: "oid",
      bytes: theirs,
      take: { content: true, title: true, deleted: true },
      expect: {
        exists: true,
        contentHash: sha(original),
        title: "자료",
        deletedAt: null,
        sharedVersion: null,
      },
    }),
    repository.replace(put(mine, { fileId: file.id, baseRevision: 1 })),
  ]);
  // The received version is not applied over a save it did not see, and a
  // save is refused once the received version moved the revision.
  assert.notEqual(applied, saved.saved);
  const stored = await repository.read(teamId, file.id);
  assert.equal(stored.file.revision, 2);
  assert.equal(Buffer.from(stored.bytes).equals(applied ? theirs : mine), true);
});

test("보관 범위를 벗어난 내용을 지우는 저장과 그 내용을 다시 쓰는 저장이 겹쳐도 자료의 파일은 남는다", async (t) => {
  const { repository, teamId, put, present } = store(t);
  const contents = [slide("r1")];
  const file = await repository.create(
    put(contents[0], { id: randomUUID(), title: "자료" }),
  );
  const save = () => {
    contents.push(slide(`r${contents.length + 1}`));
    return repository.replace(
      put(contents.at(-1), {
        fileId: file.id,
        baseRevision: contents.length - 1,
      }),
    );
  };
  for (let saves = 0; saves <= SLIDE_KEPT_REVISIONS; saves++) await save();
  assert.equal(present(contents[0]), false, "revision 1 is no longer kept");

  // Every save removes again whatever left the kept range and nothing refers
  // to. At the same moment another file is created with that very content:
  // its bytes are written while the save looks for unreferenced files.
  for (let round = 0; round < 30; round++) {
    const reused = contents[round];
    const [saved, created] = await Promise.all([
      save(),
      repository.create(
        put(reused, { id: randomUUID(), title: `다시 쓴 내용 ${round}` }),
      ),
    ]);
    assert.equal(saved.saved, true);
    assert.equal(
      Buffer.from((await repository.read(teamId, created.id)).bytes).equals(
        reused,
      ),
      true,
      `round ${round}: the new file's bytes are on disk`,
    );
  }
});

test("바이트를 쓰는 동안 팀이 영구 삭제되면 그 팀의 자료와 파일을 되살리지 않는다", async (t) => {
  let alive = true;
  const { repository, directory, teamId, put } = store(t, {
    teamExists: () => alive,
  });
  await repository.create(
    put(slide("삭제 전 자료"), { id: randomUUID(), title: "삭제 전 자료" }),
  );
  // This save has passed the permission check and is writing bytes.
  const creating = repository.create(
    put(slide("삭제 중 생성"), { id: randomUUID(), title: "삭제 중 생성" }),
  );
  // The control repository deletes the team, then its slide files.
  alive = false;
  repository.removeTeam(teamId);

  await assert.rejects(creating, { status: 404 });
  assert.deepEqual(repository.syncFiles(teamId), []);
  assert.equal(existsSync(join(directory, "blobs", teamId)), false);
  assert.deepEqual(readdirSync(join(directory, "tmp")), []);
});

// Runs `during` at the one moment no timing can reach from outside: the bytes
// are written and their folder exists, and the file is about to be moved in.
function beforeMove(t, during) {
  const rename = fsPromises.rename;
  fsPromises.rename = (...paths) => {
    during();
    return rename(...paths);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fsPromises.rename = rename;
    syncBuiltinESMExports();
  });
}

test("다 쓴 파일을 옮기기 직전에 팀이 영구 삭제되면 404로 끝나고, 팀이 그대로면 쓰기 오류를 그대로 알린다", async (t) => {
  let alive = true;
  const { repository, directory, teamId, put } = store(t, {
    teamExists: () => alive,
  });
  const folder = join(directory, "blobs", teamId);
  let during;
  beforeMove(t, () => during());
  const create = (title) =>
    repository.create(put(slide(title), { id: randomUUID(), title }));

  // Only the folder goes: the team is still there, so this is an I/O error.
  during = () => rmSync(folder, { recursive: true, force: true });
  await assert.rejects(create("폴더만 사라짐"), { code: "ENOENT" });
  assert.deepEqual(readdirSync(join(directory, "tmp")), []);

  // The control repository deletes the team, then its slide files.
  during = () => {
    alive = false;
    repository.removeTeam(teamId);
  };
  await assert.rejects(create("삭제 중 생성"), { status: 404 });
  assert.deepEqual(repository.syncFiles(teamId), []);
  assert.equal(existsSync(folder), false);
  assert.deepEqual(readdirSync(join(directory, "tmp")), []);
});

test("조각을 받아 두는 동안 팀이 영구 삭제되면 그 조각을 남기지 않는다", async (t) => {
  let alive = true;
  const { repository, directory, teamId } = store(t, {
    teamExists: () => alive,
  });
  // A pass has its state before it stages anything.
  repository.syncState(teamId);
  const chunk = slide("조각");
  const staging = repository.syncStage(teamId, sha(chunk), chunk);
  alive = false;
  repository.removeTeam(teamId);

  await staging;
  assert.equal(existsSync(join(directory, "staging", teamId)), false);
  assert.deepEqual(readdirSync(join(directory, "tmp")), []);
  assert.equal(await repository.syncStaged(teamId, sha(chunk)), null);
});
