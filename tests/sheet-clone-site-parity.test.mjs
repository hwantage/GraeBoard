import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { createExternalRouteApp } from "./external-route-fixture.mjs";
import {
  sqliteBusinessFixture,
  postgresBusinessFixture,
} from "./business-storage-fixture.mjs";
import { defaultView } from "../shared/domain.js";
import { unpack } from "../shared/formatting/compact.js";
import { DUPLICATE_SHEET_CLONE_NAME } from "../shared/sheet-clones/sheet-clone-names.js";
import {
  packSheetClonePayload,
  unpackSheetClonePayload,
} from "../shared/sheet-clones/sheet-clone-sync-data.js";

// The external site answers copy names and imports into copies as the
// internal one does (server/sheet-clones.mjs, server/storage/sqlite-transfer.mjs).
async function external(t) {
  const f = sqliteBusinessFixture(t),
    pg = await postgresBusinessFixture(t, f);
  if (!pg) return null;
  const app = createExternalRouteApp({
      env: pg.env,
      defaultUserId: f.user.id,
      contextFor: (user, request) => pg.createContext(user, request),
    }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  const api = async (path, body, method = body ? "POST" : "GET") => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Cookie: "weekly_session=" + f.user.id,
        "X-Requested-With": "WeeklyPlan",
        ...(body && !(body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(body
        ? { body: body instanceof FormData ? body : JSON.stringify(body) }
        : {}),
    });
    const text = await response.text();
    let data = text;
    try {
      data = unpack(JSON.parse(text));
    } catch {}
    return { status: response.status, data };
  };
  const create = (name) =>
    api("/sheet-clones", {
      id: randomUUID(),
      teamId: f.teamId,
      year: 2026,
      name,
      referenceDate: "2026-10-01",
      view: defaultView(2026),
      taskIds: [f.taskId],
    });
  // A copy row as stored, edited the way an earlier save could have left it.
  const stored = async (id, change) => {
    const key = JSON.stringify([id]),
      { payload } = (
        await pg.pool.query(
          "SELECT payload FROM graeboard.site_entities WHERE team_id=$1 AND entity='sheetClone' AND entity_key=$2",
          [f.teamId, key],
        )
      ).rows[0],
      next = packSheetClonePayload(
        change(unpackSheetClonePayload(JSON.parse(payload))),
      );
    await pg.pool.query(
      "UPDATE graeboard.site_entities SET payload=$3 WHERE team_id=$1 AND entity='sheetClone' AND entity_key=$2",
      [f.teamId, key, JSON.stringify(next)],
    );
  };
  const copies = async () =>
    (
      await pg.pool.query(
        "SELECT entity_key,payload FROM graeboard.site_entities WHERE team_id=$1 AND entity='sheetClone' ORDER BY entity_key",
        [f.teamId],
      )
    ).rows;
  const preview = async (name, rows, sheetCloneId) => {
    const workbook = new ExcelJS.Workbook(),
      sheet = workbook.addWorksheet(name);
    sheet.addRow(["작업"]);
    for (let i = 0; i < rows; i++) sheet.addRow([`가져온 업무 ${i + 1}`]);
    const form = new FormData();
    form.set("teamId", f.teamId);
    form.set("year", "2026");
    if (sheetCloneId) form.set("sheetCloneId", sheetCloneId);
    form.set(
      "file",
      new Blob([await workbook.xlsx.writeBuffer()]),
      "import.xlsx",
    );
    const result = await api("/import/preview", form);
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.data;
  };
  return { f, pg, api, create, stored, copies, preview };
}
const duplicate = (result) => {
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.equal(result.data.error, DUPLICATE_SHEET_CLONE_NAME);
  assert.deepEqual(result.data.details, { code: "DUPLICATE_SHEET_CLONE_NAME" });
};

test("external copy names are compared normalized, stored names too, with the internal message and code", async (t) => {
  const site = await external(t);
  if (!site) return;
  const { api, create, stored, copies, preview } = site;
  const decomposed = "한글 사본".normalize("NFD");
  const first = await create("한글 사본");
  assert.ok(first.status < 300, JSON.stringify(first));
  // The stored name is decomposed Korean text; a request names it composed.
  await stored(first.data.id, (payload) => ({ ...payload, name: decomposed }));
  const before = await copies();
  duplicate(await create(" 한글 사본 "));
  const second = await create("다른 사본");
  assert.ok(second.status < 300, JSON.stringify(second));
  duplicate(
    await api(
      `/sheet-clones/${second.data.id}/name`,
      { name: "한글 사본", expectedName: "다른 사본" },
      "PATCH",
    ),
  );
  // An import that creates a copy names it after its sheet, normalized.
  const taken = await preview(decomposed, 1);
  duplicate(
    await api(`/import/${taken.id}/apply`, {
      sheet: taken.sheets[0].name,
      year: 2026,
      personMap: taken.personMap,
      mode: "create-sheet-clone",
      referenceDate: "2026-10-01",
      acceptWarnings: true,
    }),
  );
  assert.equal((await copies()).length, before.length + 1);
  const fresh = await preview("새 사본".normalize("NFD"), 1),
    applied = await api(`/import/${fresh.id}/apply`, {
      sheet: fresh.sheets[0].name,
      year: 2026,
      personMap: fresh.personMap,
      mode: "create-sheet-clone",
      referenceDate: "2026-10-01",
      acceptWarnings: true,
    });
  assert.equal(applied.status, 200, JSON.stringify(applied));
  assert.ok(
    (await copies()).some(
      (row) => JSON.parse(row.payload).name === "새 사본".normalize("NFC"),
    ),
  );
});

test("an external import into a copy keeps the 20,000-task bound before it writes", async (t) => {
  const site = await external(t);
  if (!site) return;
  const { api, create, stored, copies, preview, pg } = site;
  const copy = await create("가득 찬 사본");
  assert.ok(copy.status < 300, JSON.stringify(copy));
  // 19,999 tasks and two more rows exceed the bound.
  await stored(copy.data.id, (payload) => {
    const [task] = payload.data.tasks;
    payload.data.tasks = Array.from({ length: 19999 }, (_, i) => ({
      ...task,
      id: i ? randomUUID() : task.id,
      position: i * 100,
    }));
    return payload;
  });
  const imported = await preview("추가 시트", 2, copy.data.id),
    current = await api(`/sheet-clones/${copy.data.id}`);
  assert.equal(current.status, 200, JSON.stringify(current));
  const before = JSON.stringify([
    await copies(),
    (await pg.pool.query("SELECT COUNT(*) n FROM graeboard.sync_outbox"))
      .rows[0].n,
    (await pg.pool.query("SELECT COUNT(*) n FROM graeboard.site_operations"))
      .rows[0].n,
  ]);
  const refused = await api(`/import/${imported.id}/apply`, {
    sheet: imported.sheets[0].name,
    year: 2026,
    personMap: imported.personMap,
    mode: "append-to-sheet-clone",
    sheetCloneId: copy.data.id,
    revision: current.data.revision,
    referenceDate: "2026-10-01",
    acceptWarnings: true,
  });
  assert.equal(refused.status, 400, JSON.stringify(refused));
  assert.equal(
    refused.data.error,
    "사본에는 최대 20,000개 업무를 저장할 수 있습니다.",
  );
  assert.equal(
    JSON.stringify([
      await copies(),
      (await pg.pool.query("SELECT COUNT(*) n FROM graeboard.sync_outbox"))
        .rows[0].n,
      (await pg.pool.query("SELECT COUNT(*) n FROM graeboard.site_operations"))
        .rows[0].n,
    ]),
    before,
  );
});

test("an external copy renamed to the normalized form of its own stored name keeps it, and another copy cannot take it", async (t) => {
  const site = await external(t);
  if (!site) return;
  const { api, create, stored, copies } = site;
  const name = "자기 사본";
  const own = await create(name),
    other = await create("다른 사본");
  assert.ok(own.status < 300, JSON.stringify(own));
  assert.ok(other.status < 300, JSON.stringify(other));
  // An earlier save kept the decomposed form of the name.
  await stored(own.data.id, (payload) => ({
    ...payload,
    name: name.normalize("NFD"),
  }));
  const row = async (id) =>
    (await copies()).find((r) => r.entity_key === JSON.stringify([id]));
  const otherBefore = await row(other.data.id);
  const renamed = await api(
    `/sheet-clones/${own.data.id}/name`,
    { name, expectedName: name.normalize("NFD") },
    "PATCH",
  );
  assert.equal(renamed.status, 200, JSON.stringify(renamed));
  assert.equal(JSON.parse((await row(own.data.id)).payload).name, name);
  duplicate(
    await api(
      `/sheet-clones/${other.data.id}/name`,
      { name: ` ${name.normalize("NFD")} `, expectedName: "다른 사본" },
      "PATCH",
    ),
  );
  assert.deepEqual(await row(other.data.id), otherBefore);
});
