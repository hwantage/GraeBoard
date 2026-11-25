import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postgresBusinessFixture } from "../support/business-storage-fixture.mjs";
import { migrateSlideSchema } from "../../server/migrations/postgres-slides.mjs";
import { SlideFileService } from "../../server/storage/slides/slide-file-service.mjs";
import {
  SLIDE_KEPT_REVISIONS,
  SqliteSlideFileRepository,
  slideThumbnailPath,
} from "../../server/storage/slides/sqlite-slide-files.mjs";
import { SLIDE_THUMBNAIL_VERSION } from "../../shared/slides/slide-file-rules.js";
import { PostgresSlideFileRepository } from "../../worker/storage/slides/postgres-slide-files.mjs";
import { slideThumbnailKey } from "../../worker/storage/slides/r2-slide-blobs.mjs";

// Card thumbnails are stored per site: files next to the slide store on the
// internal site, objects in the team's bucket on the external one. Both
// repositories keep the same contract, so one set of checks runs against each.

const slide = (text) => Buffer.from(JSON.stringify({ version: 1, name: text }));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// The smallest picture the service accepts: a JPEG frame header of 160x90,
// then bytes that tell one picture from another.
const jpegBytes = (tag) =>
  Buffer.concat([
    Buffer.from("ffd8ffc0000b08005a00a001011100", "hex"),
    Buffer.from(tag),
    Buffer.from("ffd9", "hex"),
  ]);
const jpeg = (tag) =>
  "data:image/jpeg;base64," + jpegBytes(tag).toString("base64");

function slideThumbnailContract(name, makeSite) {
  test(name, async (t) => {
    const site = await makeSite(t);
    if (!site) return;
    const { teamId } = site;
    const version = SLIDE_THUMBNAIL_VERSION;
    // A service as the routes build one per request. Its memory cache belongs
    // to the repository, so a new repository is a restarted server (or
    // another Edge isolate): it knows only what the store kept.
    const as = (repository, role = "member") =>
      new SlideFileService(
        repository,
        { id: role, teamIds: [teamId], teamRoles: { [teamId]: role } },
        { teamAccess() {} },
      );
    const create = (service, text) =>
      service.create(teamId, {
        title: text,
        bytes: slide(`${text} ${randomUUID()}`),
        requestId: randomUUID(),
      });
    const save = (service, file, baseRevision) =>
      service.save(teamId, file.id, {
        baseRevision,
        bytes: slide(`${file.title} ${randomUUID()}`),
        requestId: randomUUID(),
      });
    const put = (service, file, image, hash = file.contentHash) =>
      service.putThumbnail(teamId, file.id, { hash, image });
    const image = async (service, file) =>
      (await service.thumbnail(teamId, file.id)).image;
    const stored = (hash, drawing = version) => {
      const bytes = site.stored(hash, drawing);
      return bytes && Buffer.from(bytes);
    };

    await t.test("저장한 썸네일은 서버를 다시 시작해도 남는다", async () => {
      const service = as(site.open());
      const file = await create(service, "재시작");
      assert.deepEqual(await service.thumbnail(teamId, file.id), {
        hash: file.contentHash,
        image: null,
      });
      assert.deepEqual(await put(service, file, jpeg("first")), {});
      assert.equal(await image(service, file), jpeg("first"));
      assert.deepEqual(
        stored(file.contentHash),
        jpegBytes("first"),
        "the store keeps the JPEG itself, not its data URL",
      );
      assert.deepEqual(await as(site.open()).thumbnail(teamId, file.id), {
        hash: file.contentHash,
        image: jpeg("first"),
      });
      // A viewer reads what a contributor stored.
      assert.equal(await image(as(site.open(), "viewer"), file), jpeg("first"));
    });

    await t.test(
      "빈 캔버스의 빈 썸네일도 없는 것과 구분해 남긴다",
      async () => {
        const service = as(site.open());
        const file = await create(service, "빈 캔버스");
        assert.deepEqual(await put(service, file, ""), {});
        assert.equal(await image(service, file), "");
        assert.equal(await image(as(site.open()), file), "");
        assert.equal(stored(file.contentHash).length, 1);
      },
    );

    await t.test("같은 내용에는 먼저 저장한 썸네일이 남는다", async () => {
      const repository = site.open();
      const service = as(repository);
      const file = await create(service, "먼저 쓴 쪽");
      await put(service, file, jpeg("first"));
      assert.deepEqual(await put(service, file, jpeg("second")), {});
      assert.equal(await image(service, file), jpeg("first"));
      // A server that no longer has the first one in memory still keeps it.
      const restarted = as(site.open());
      assert.deepEqual(await put(restarted, file, jpeg("third")), {});
      assert.equal(await image(restarted, file), jpeg("first"));
      assert.deepEqual(stored(file.contentHash), jpegBytes("first"));

      // Two members draw the same card at the same moment.
      for (let round = 0; round < 5; round++) {
        const both = await create(service, `동시 ${round}`);
        const pictures = [jpeg(`a${round}`), jpeg(`b${round}`)];
        assert.deepEqual(
          await Promise.all([
            put(service, both, pictures[0]),
            put(as(repository, "lead"), both, pictures[1]),
          ]),
          [{}, {}],
        );
        const served = await image(service, both);
        assert.ok(pictures.includes(served), `round ${round}: one of the two`);
        assert.equal(
          await image(as(site.open()), both),
          served,
          `round ${round}: a restart serves the picture memory served`,
        );
      }
    });

    await t.test("거절한 요청은 아무것도 저장하지 않는다", async () => {
      const service = as(site.open());
      const file = await create(service, "거절");
      const saved = await save(service, file, 1);
      // The picture of content the file no longer shows.
      await assert.rejects(put(service, file, jpeg("stale")), { status: 409 });
      await assert.rejects(
        put(as(site.open(), "viewer"), saved, jpeg("viewer")),
        { status: 403 },
      );
      for (const invalid of [
        "data:image/svg+xml,abc",
        "data:image/jpeg;base64," +
          Buffer.from("not a jpeg").toString("base64"),
        null,
      ])
        await assert.rejects(put(service, saved, invalid), { status: 400 });
      assert.equal(stored(file.contentHash), null);
      assert.equal(stored(saved.contentHash), null);
      assert.equal(await image(as(site.open()), saved), null);
    });

    await t.test(
      "보관 범위를 벗어난 내용의 썸네일은 그리기 버전과 관계없이 지운다",
      async () => {
        const current = as(site.open());
        // The code after the drawing changed: SLIDE_THUMBNAIL_VERSION raised by
        // one, running on the same store.
        const next = as(site.open({ thumbnailVersion: version + 1 }));
        const first = await create(current, "보관");
        await put(current, first, jpeg("old drawing"));

        // A picture of the older drawing is not served: the card is drawn again
        // and stored next to the old one.
        assert.equal(await image(next, first), null);
        await put(next, first, jpeg("new drawing"));
        assert.equal(await image(next, first), jpeg("new drawing"));
        assert.equal(await image(as(site.open()), first), jpeg("old drawing"));
        assert.deepEqual(stored(first.contentHash), jpegBytes("old drawing"));
        assert.deepEqual(
          stored(first.contentHash, version + 1),
          jpegBytes("new drawing"),
        );

        let file = await save(next, first, 1);
        const second = file;
        await put(next, second, jpeg("second"));
        while (file.revision <= SLIDE_KEPT_REVISIONS)
          file = await save(next, file, file.revision);
        assert.notEqual(
          stored(first.contentHash),
          null,
          "revision 1 is the oldest one still kept",
        );
        file = await save(next, file, file.revision);
        assert.equal(stored(first.contentHash), null);
        assert.equal(stored(first.contentHash, version + 1), null);
        assert.deepEqual(
          stored(second.contentHash, version + 1),
          jpegBytes("second"),
          "the thumbnail of content that is still kept stays",
        );
      },
    );

    await t.test(
      "저장소를 쓸 수 없어도 요청은 실패하지 않고 메모리로 답한다",
      async (t) => {
        const repository = site.open();
        const service = as(repository);
        const file = await create(service, "저장소 장애");
        const failing = async () => {
          throw new Error("store unavailable");
        };
        const read = t.mock.method(repository, "thumbnail", failing);
        assert.deepEqual(await service.thumbnail(teamId, file.id), {
          hash: file.contentHash,
          image: null,
        });
        read.mock.restore();
        const write = t.mock.method(repository, "putThumbnail", failing);
        assert.deepEqual(await put(service, file, jpeg("memory only")), {});
        write.mock.restore();
        assert.equal(await image(service, file), jpeg("memory only"));
        assert.equal(stored(file.contentHash), null);
        // Nothing was stored, so after a restart the card is drawn again.
        const restarted = as(site.open());
        assert.equal(await image(restarted, file), null);
        await put(restarted, file, jpeg("drawn again"));
        assert.equal(await image(as(site.open()), file), jpeg("drawn again"));
      },
    );
  });
}

slideThumbnailContract("사내 저장소의 썸네일 계약", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slide-thumbnails-"));
  const teamId = randomUUID();
  const opened = [];
  t.after(() => {
    for (const repository of opened) repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    teamId,
    open(options) {
      const repository = new SqliteSlideFileRepository({
        directory,
        ...options,
      });
      opened.push(repository);
      return repository;
    },
    stored(hash, version) {
      const path = slideThumbnailPath(directory, teamId, hash, version);
      return existsSync(path) ? readFileSync(path) : null;
    },
  };
});

// An R2 bucket binding kept in memory.
function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    put: async (key, bytes) => void objects.set(key, Uint8Array.from(bytes)),
    get: async (key) => {
      const bytes = objects.get(key);
      return (
        bytes && { arrayBuffer: async () => Uint8Array.from(bytes).buffer }
      );
    },
    head: async (key) => (objects.has(key) ? { key } : null),
    delete: async (key) => void objects.delete(key),
  };
}

slideThumbnailContract("외부 저장소의 썸네일 계약", async (t) => {
  const pg = await postgresBusinessFixture(t);
  if (!pg) return null;
  await migrateSlideSchema(pg.pool);
  const bucket = memoryBucket();
  return {
    teamId: pg.teamId,
    open: (options) =>
      new PostgresSlideFileRepository({
        pool: pg.pool,
        bucket,
        teamId: pg.teamId,
        ...options,
      }),
    stored: (hash, version) =>
      bucket.objects.get(slideThumbnailKey(pg.teamId, hash, version)) ?? null,
  };
});

test("사내에서 팀을 영구 삭제하면 그 팀의 썸네일도 함께 지운다", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slide-thumbnails-"));
  const repository = new SqliteSlideFileRepository({ directory });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const [removed, kept] = [randomUUID(), randomUUID()];
  const hashes = {};
  for (const teamId of [removed, kept]) {
    const bytes = slide(teamId);
    hashes[teamId] = sha(bytes);
    await repository.create({
      id: randomUUID(),
      teamId,
      title: "자료",
      bytes,
      contentHash: hashes[teamId],
      requestId: randomUUID(),
      userId: "member",
      at: new Date().toISOString(),
    });
    assert.deepEqual(
      await repository.putThumbnail(teamId, hashes[teamId], jpegBytes(teamId)),
      jpegBytes(teamId),
    );
  }
  repository.removeTeam(removed);
  assert.equal(existsSync(join(directory, "thumbnails", removed)), false);
  assert.equal(await repository.thumbnail(removed, hashes[removed]), null);
  assert.deepEqual(
    Buffer.from(await repository.thumbnail(kept, hashes[kept])),
    jpegBytes(kept),
  );
});
