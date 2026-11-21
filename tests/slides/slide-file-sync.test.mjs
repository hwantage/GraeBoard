import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SqliteSlideFileRepository } from "../../server/storage/slides/sqlite-slide-files.mjs";
import {
  settle,
  slide,
  slideSyncContract,
  twoPeers,
} from "../support/slide-sync-fixture.mjs";

const sqliteStores = (t, directory) => {
  const stores = {
    internal: new SqliteSlideFileRepository({
      directory: join(directory, "internal-store"),
    }),
    external: new SqliteSlideFileRepository({
      directory: join(directory, "external-store"),
    }),
  };
  t.after(() => Object.values(stores).forEach((store) => store.close()));
  return stores;
};
slideSyncContract("사내 저장소끼리", sqliteStores);

test("복원한 저장소는 새 게시 세대로 시작해 이전 버전 번호를 다시 쓰지 않는다", async (t) => {
  const { inside, outside, teamId } = await twoPeers(t, sqliteStores);
  const file = await inside.create("자료", slide("처음"));
  await settle(inside, outside);
  const before = (await inside.store.syncFiles(teamId))[0].shared.version;
  await inside.save(file.id, slide("복원 전 수정"));
  await settle(inside, outside);
  const used = (await inside.store.syncFiles(teamId))[0].shared.version;
  assert.notEqual(used, before);

  // The store goes back to an earlier state, as after restoring a backup.
  inside.store.syncReset();
  assert.equal((await inside.store.syncState(teamId)).head, null);
  await inside.save(file.id, slide("복원 뒤 수정"));
  await settle(inside, outside);
  const after = (await inside.store.syncFiles(teamId))[0].shared.version;
  assert.notEqual(after.split(":")[0], used.split(":")[0], "a new epoch");
  assert.equal(
    (await outside.read(file.id)).equals(slide("복원 뒤 수정")),
    true,
  );
});
