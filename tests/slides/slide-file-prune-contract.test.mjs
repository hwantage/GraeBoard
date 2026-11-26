import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs, { existsSync, mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import postgres from "pg";
import { postgresBusinessFixture } from "../support/business-storage-fixture.mjs";
import { migrateSlideSchema } from "../../server/migrations/postgres-slides.mjs";
import {
  SLIDE_KEPT_REVISIONS,
  SLIDE_PRUNE_LOOKBACK,
  SqliteSlideFileRepository,
  slideBlobPath,
  slideThumbnailPath,
} from "../../server/storage/slides/sqlite-slide-files.mjs";
import { SLIDE_THUMBNAIL_VERSION } from "../../shared/slides/slide-file-rules.js";
import { databaseFor } from "../../worker/storage/data.mjs";
import { PostgresSlideFileRepository } from "../../worker/storage/slides/postgres-slide-files.mjs";
import {
  slideObjectKey,
  slideThumbnailKey,
} from "../../worker/storage/slides/r2-slide-blobs.mjs";

// Content that left the kept revisions is removed by the change that pushed
// it out: a save, or a version received from the other site. Both
// repositories keep the same contract, so one set of checks runs against each.

const slide = (text) => Buffer.from(JSON.stringify({ version: 1, name: text }));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const picture = Buffer.from("ffd8ffd9", "hex");

function slideFilePruneContract(name, makeSite) {
  test(name, async (t) => {
    const site = await makeSite(t);
    if (!site) return;
    const { teamId, repository } = site;
    const put = (bytes, extra) => ({
      teamId,
      bytes,
      contentHash: sha(bytes),
      requestId: randomUUID(),
      userId: "user",
      at: new Date().toISOString(),
      ...extra,
    });
    // A file with the content of each of its revisions, the first at index 0.
    const create = async (title, bytes = slide(randomUUID())) => {
      const { id } = await repository.create(
        put(bytes, { id: randomUUID(), title }),
      );
      return { id, title, contents: [bytes], shared: null };
    };
    const save = async (file, bytes = slide(randomUUID())) => {
      const baseRevision = file.contents.length;
      file.contents.push(bytes);
      const result = await repository.replace(
        put(bytes, { fileId: file.id, baseRevision }),
      );
      assert.equal(result.saved, true);
    };
    // A version of the file the other site published.
    const receive = async (file, bytes = slide(randomUUID())) => {
      const expect = {
        exists: true,
        contentHash: sha(file.contents.at(-1)),
        title: file.title,
        deletedAt: null,
        sharedVersion: file.shared,
      };
      file.contents.push(bytes);
      file.shared = `${randomUUID()}:1`;
      assert.equal(
        await repository.syncApply(teamId, {
          meta: {
            id: file.id,
            title: file.title,
            contentHash: sha(bytes),
            byteLength: bytes.byteLength,
            chunks: [sha(bytes)],
            version: file.shared,
            updatedBy: { id: "peer" },
            updatedAt: new Date().toISOString(),
            deletedAt: null,
          },
          metaOid: "oid",
          bytes,
          take: { content: true, title: true, deleted: true },
          expect,
        }),
        true,
      );
    };
    const until = async (file, revision, change = save) => {
      while (file.contents.length < revision) await change(file);
    };
    const hash = (file, revision) => sha(file.contents[revision - 1]);
    const thumbnail = async (contentHash) =>
      assert.deepEqual(
        Buffer.from(
          await repository.putThumbnail(teamId, contentHash, picture),
        ),
        picture,
      );
    // Whether the bytes and the thumbnail of a content are stored.
    const stored = (contentHash) => [
      site.content(contentHash),
      site.thumbnail(contentHash),
    ];

    await t.test(
      "한 번의 변경이 하는 정리는 그 자료의 revision 수와 무관하다",
      async (t) => {
        for (const [label, change] of [
          ["저장", save],
          ["받은 버전", receive],
        ]) {
          const file = await create(label);
          const costAt = async (revision) => {
            await until(file, revision - 1, change);
            return site.work(() => change(file));
          };
          const early = await costAt(15);
          const late = await costAt(60);
          assert.deepEqual(
            late,
            early,
            `${label}: revision 60 costs what revision 15 did`,
          );
          // The content of the revision that left and of the ones looked back
          // at, each with its thumbnails: none of them is referred to here.
          assert.equal(
            early.removals,
            (1 + SLIDE_PRUNE_LOOKBACK) * (1 + SLIDE_THUMBNAIL_VERSION),
          );
          t.diagnostic(`${label}: ${JSON.stringify(early)}`);
        }
      },
    );

    await t.test(
      "보관 범위를 벗어난 내용은 썸네일과 함께 지우고 아직 쓰이는 내용은 남긴다",
      async () => {
        const [shared, reverted, alone] = [1, 2, 3].map(() =>
          slide(randomUUID()),
        );
        const file = await create("자료", shared);
        await create("같은 내용의 다른 자료", shared);
        await save(file, reverted);
        await save(file, alone);
        for (const bytes of [shared, reverted, alone])
          await thumbnail(sha(bytes));

        // Revision 1 leaves; revision 2 leaves while revision 13 has the same
        // content again.
        await until(file, SLIDE_KEPT_REVISIONS + 2);
        await save(file, reverted);
        assert.deepEqual(
          stored(sha(alone)),
          [true, true],
          "revision 3 is the oldest one still kept",
        );
        await save(file);
        assert.deepEqual(stored(sha(alone)), [false, false]);
        // Later saves look back at the revisions these two left.
        for (let saves = 0; saves <= SLIDE_PRUNE_LOOKBACK; saves++) {
          assert.deepEqual(
            stored(sha(shared)),
            [true, true],
            "content of another file",
          );
          assert.deepEqual(
            stored(sha(reverted)),
            [true, true],
            "content of a kept revision of the same file",
          );
          await save(file);
        }
        // Until the last revision that has the content leaves as well.
        await until(file, 13 + SLIDE_KEPT_REVISIONS);
        assert.deepEqual(stored(sha(reverted)), [true, true]);
        await save(file);
        assert.deepEqual(stored(sha(reverted)), [false, false]);
        assert.deepEqual(stored(sha(shared)), [true, true]);
      },
    );

    await t.test(
      "상대 사이트에서 받은 버전이 밀어낸 내용도 같은 방식으로 지운다",
      async () => {
        const file = await create("받기만 하는 자료");
        await thumbnail(hash(file, 1));
        await until(file, SLIDE_KEPT_REVISIONS + 1, receive);
        assert.deepEqual(stored(hash(file, 1)), [true, true]);
        await receive(file);
        assert.deepEqual(stored(hash(file, 1)), [false, false]);

        await until(file, 30, receive);
        const kept = (revisions) =>
          Array.from(
            { length: revisions },
            (_, index) => index >= revisions - 1 - SLIDE_KEPT_REVISIONS,
          );
        assert.deepEqual(
          file.contents.map((bytes) => site.content(sha(bytes))),
          kept(30),
        );
        // Saves and received versions move the same window.
        await save(file);
        assert.deepEqual(
          file.contents.map((bytes) => site.content(sha(bytes))),
          kept(31),
        );
      },
    );

    await t.test(
      "실패한 정리는 그 자료의 다음 변경이 끝내고, 되돌아보는 범위를 지난 내용은 남는다",
      async () => {
        const file = await create("정리 실패");
        await thumbnail(hash(file, 1));
        await until(file, SLIDE_KEPT_REVISIONS + 1);
        await site.whileRemovalsFail(() => save(file));
        assert.equal(
          (await repository.get(teamId, file.id)).revision,
          SLIDE_KEPT_REVISIONS + 2,
          "the save is stored whatever happens to the clean-up",
        );
        assert.deepEqual(stored(hash(file, 1)), [true, true]);
        await save(file);
        assert.deepEqual(stored(hash(file, 1)), [false, false]);

        // The limit: the removal failed on the save that pushed the content
        // out and on every save that looked back at it. No later save removes
        // it; the content after it is cleaned up as usual.
        const left = await create("남는 내용");
        await until(left, SLIDE_KEPT_REVISIONS + 1);
        for (let saves = 0; saves <= SLIDE_PRUNE_LOOKBACK; saves++)
          await site.whileRemovalsFail(() => save(left));
        await until(left, 30);
        assert.deepEqual(
          left.contents.map((bytes) => site.content(sha(bytes))),
          [
            true,
            ...Array(30 - 2 - SLIDE_KEPT_REVISIONS).fill(false),
            ...Array(SLIDE_KEPT_REVISIONS + 1).fill(true),
          ],
        );
      },
    );
  });
}

slideFilePruneContract("사내 저장소의 보관 정리 계약", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slide-prune-"));
  const repository = new SqliteSlideFileRepository({ directory });
  const teamId = randomUUID();
  let statements = 0;
  let removals = 0;
  let failing = false;
  // Every statement the store runs is prepared first, except the ones that
  // open and close a transaction.
  const { prepare, exec } = DatabaseSync.prototype;
  DatabaseSync.prototype.prepare = function (...args) {
    statements++;
    return prepare.apply(this, args);
  };
  DatabaseSync.prototype.exec = function (...args) {
    statements++;
    return exec.apply(this, args);
  };
  // The store removes a file with rmSync, bound when its module was loaded.
  const { rmSync } = fs;
  fs.rmSync = (...args) => {
    removals++;
    if (failing) throw new Error("removal failed");
    return rmSync(...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    DatabaseSync.prototype.prepare = prepare;
    DatabaseSync.prototype.exec = exec;
    fs.rmSync = rmSync;
    syncBuiltinESMExports();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    teamId,
    repository,
    content: (hash) => existsSync(slideBlobPath(directory, teamId, hash)),
    thumbnail: (hash) =>
      existsSync(
        slideThumbnailPath(directory, teamId, hash, SLIDE_THUMBNAIL_VERSION),
      ),
    async work(change) {
      statements = removals = 0;
      await change();
      return { statements, removals };
    },
    // This store reports a removal that failed, after the commit.
    async whileRemovalsFail(change) {
      failing = true;
      try {
        await assert.rejects(change(), /removal failed/);
      } finally {
        failing = false;
      }
    },
  };
});

slideFilePruneContract("외부 저장소의 보관 정리 계약", async (t) => {
  const pg = await postgresBusinessFixture(t);
  if (!pg) return null;
  await migrateSlideSchema(pg.pool);
  const teamId = pg.teamId;
  // An R2 bucket binding kept in memory. Every request is a remote round
  // trip for the external site, and so is every SQL statement.
  const objects = new Map();
  const requests = [];
  let failing = false;
  const bucket = {
    async put(key, bytes) {
      requests.push("put");
      objects.set(key, Uint8Array.from(bytes));
    },
    async get(key) {
      requests.push("get");
      const bytes = objects.get(key);
      return (
        bytes && { arrayBuffer: async () => Uint8Array.from(bytes).buffer }
      );
    },
    async head(key) {
      requests.push("head");
      return objects.has(key) ? { key } : null;
    },
    async delete(key) {
      requests.push("delete");
      if (failing) throw new Error("removal failed");
      objects.delete(key);
    },
  };
  let statements = [];
  const query = postgres.Client.prototype.query;
  postgres.Client.prototype.query = function (...args) {
    statements.push(args[0]);
    return query.apply(this, args);
  };
  t.after(() => {
    postgres.Client.prototype.query = query;
  });
  return {
    teamId,
    // The pool of the routes: every transaction opens a connection.
    repository: new PostgresSlideFileRepository({
      pool: databaseFor(pg.env, JSON.parse(pg.env.SYNC_PROFILES)[0]).pool,
      bucket,
      teamId,
    }),
    content: (hash) => objects.has(slideObjectKey(teamId, hash)),
    thumbnail: (hash) =>
      objects.has(slideThumbnailKey(teamId, hash, SLIDE_THUMBNAIL_VERSION)),
    async work(change) {
      statements = [];
      requests.length = 0;
      await change();
      return {
        statements: statements.length,
        transactions: statements.filter((text) => text === "BEGIN").length,
        requests: requests.length,
        removals: requests.filter((name) => name === "delete").length,
      };
    },
    // This store answers the save and leaves the clean-up to later changes.
    async whileRemovalsFail(change) {
      failing = true;
      try {
        await change();
      } finally {
        failing = false;
      }
    },
  };
});
