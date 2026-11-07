// The offline SheetClone conversion against databases the released code wrote
// (tests/fixtures/sheet-clone-legacy, generated from f744ead). The expected
// values below come from that release's own API answers and from the fixture
// text itself, never from the conversion code.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { openDatabase } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { unpack } from "../shared/compact.js";
import {
  migrateSqlite,
  assertSqliteHistory,
  assertSqliteIntegrity,
  SQLITE_VERSION,
} from "../server/migrations/sqlite.mjs";
import {
  sqliteSheetCloneConversion,
  convertExport,
} from "../server/migrations/sheet-clone/convert.mjs";
import { convertMarkdownLinks } from "../server/migrations/sheet-clone/markdown-links.mjs";

const FIXTURE = new URL("./fixtures/sheet-clone-legacy/", import.meta.url),
  read = (name) => readFileSync(new URL(name, FIXTURE), "utf8"),
  manifest = JSON.parse(read("manifest.json")),
  expected = JSON.parse(read("expected-f744ead.json")),
  ORIGINS = [manifest.origins.internal, manifest.origins.external],
  NOW = "2026-11-08T00:00:00.000Z";
const { teamId } = manifest,
  { R1, R2, R3, R4, R5 } = manifest.copies,
  { T1, T2, T3, T4 } = manifest.tasks,
  { M1 } = manifest.memos;

// What a converted body must be, from the fixture's own structure: every
// link destination moves; fenced code, inline code, the plain sentence and
// the unrelated site's address keep their text.
export function convertedText(markdown) {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) {
        fenced = !fenced;
        return line;
      }
      if (
        fenced ||
        line.startsWith("문장 속 ") ||
        line.startsWith("인라인 코드 ") ||
        line.startsWith("무관한 사이트: ")
      )
        return line;
      return line.replaceAll("/links/report-", "/links/sheet-clone-");
    })
    .join("\n");
}
const legacyPath = (path) =>
  path
    .replace("/links/sheet-clone-task/", "/links/report-task/")
    .replace("/links/sheet-clone-memo/", "/links/report-memo/");
const newPath = (path) =>
  path
    .replace("/links/report-task/", "/links/sheet-clone-task/")
    .replace("/links/report-memo/", "/links/sheet-clone-memo/");
// History as the released API answered it, under the new names.
const renamedHistory = (entry) => {
  const value = JSON.parse(
    JSON.stringify(entry).replaceAll('"reportId":', '"sheetCloneId":'),
  );
  value.action = value.action.replace(/^report(?=$|-)/, "sheet-clone");
  if (value.action === "import" && value.after?.mode)
    value.after.mode =
      { report: "create-sheet-clone", copy: "append-to-sheet-clone" }[
        value.after.mode
      ] || value.after.mode;
  const walk = (item) => {
    if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === "object")
      for (const [key, child] of Object.entries(item))
        if (key === "markdown" && typeof child === "string")
          item[key] = convertedText(child);
        else walk(child);
  };
  walk(value.before);
  walk(value.after);
  return value;
};

export function loadLegacySqlite(path, label) {
  const db = new DatabaseSync(path);
  db.exec(read(`internal-${label}.sql`));
  db.close();
}
const tables = (db) =>
  db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all()
    .map((row) => ({ ...row, sql: row.sql?.replace(/\s+/g, " ") }));
const sha = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

async function serve(t, db) {
  const app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: join(tmpdir(), "gb-sheet-clone-images-" + randomUUID()),
    syncOptions: { profiles: [], schedule: false },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const token = randomUUID();
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    manifest.users.lead,
    Date.now() + 3600000,
  );
  return async (path, body, method = body ? "POST" : "GET") => {
    const response = await fetch(
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
    const text = await response.text();
    let data = text;
    try {
      data = unpack(JSON.parse(text));
    } catch {}
    return { status: response.status, data };
  };
}
const ok = (result) => {
  assert.ok(result.status < 300, JSON.stringify(result));
  return result.data;
};
// A document list compared with the released answer: the body is the
// converted text and its revision moves exactly when the body changed.
function sameDocuments(actual, legacy, label) {
  assert.equal(actual.documents.length, legacy.documents.length, label);
  legacy.documents.forEach((before, index) => {
    const after = actual.documents[index],
      changed = convertedText(before.markdown) !== before.markdown;
    assert.equal(after.markdown, convertedText(before.markdown), label);
    for (const field of Object.keys(before))
      if (!["markdown", "revision", "updatedAt", "sync"].includes(field))
        assert.deepEqual(after[field], before[field], `${label} ${field}`);
    if (before.revision !== undefined) {
      if (typeof before.revision === "number")
        assert.equal(after.revision, before.revision + (changed ? 1 : 0));
      else assert.equal(after.revision !== before.revision, changed, label);
    }
  });
}

for (const label of ["v1", "v2"])
  test(`SQLite v33 from f744ead (sync ${label}) converts to v34: schema of a new install, names, links, history and retries, rerun is a no-op`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "gb-sheet-clone-sqlite-")),
      path = join(dir, "legacy.sqlite");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    loadLegacySqlite(path, label);
    const convert = sqliteSheetCloneConversion({ origins: ORIGINS, now: NOW });
    let db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=ON");
    const legacyCells = db
        .prepare("SELECT * FROM cells ORDER BY task_id,key")
        .all(),
      legacyClones = db
        .prepare(
          "SELECT id,team_id,year,name,reference_date,created_by,created_at FROM reports ORDER BY id",
        )
        .all(),
      legacyUsers = db.prepare("SELECT * FROM users ORDER BY id").all(),
      legacyLink = db.prepare("SELECT * FROM team_sync_links").get();
    const result = migrateSqlite(db, { convert });
    assert.equal(result.to, SQLITE_VERSION);
    const summary = result.conversion;
    assertSqliteHistory(db);
    assertSqliteIntegrity(db);
    // The same objects as a database created by this release.
    const fresh = new DatabaseSync(":memory:");
    migrateSqlite(fresh, { initialize: true });
    assert.deepEqual(tables(db), tables(fresh));
    fresh.close();
    // Identities and unrelated rows are untouched.
    assert.deepEqual(
      db.prepare("SELECT * FROM cells ORDER BY task_id,key").all(),
      legacyCells,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM users ORDER BY id").all(),
      legacyUsers,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT id,team_id,year,name,reference_date,created_by,created_at FROM sheet_clones ORDER BY id",
        )
        .all(),
      legacyClones,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT action,COUNT(*) n FROM audit WHERE action LIKE 'report%' GROUP BY action",
        )
        .all(),
      [],
    );
    // C: renamed records, the protocol of the same structure, history kept.
    const sync = summary.sync[0],
      conversion = db.prepare("SELECT * FROM sync_conversions").get();
    assert.equal(sync.fromProtocol, label === "v1" ? 1 : 2);
    assert.equal(sync.toProtocol, label === "v1" ? 3 : 4);
    assert.equal(conversion.base_head, manifest.sync[label].head);
    assert.equal(conversion.base_hash, manifest.sync[label].hash);
    assert.equal(conversion.completed_head, null);
    assert.equal(
      db.prepare("SELECT canonical_head FROM team_sync_links").get()
        .canonical_head,
      legacyLink.canonical_head,
    );
    assert.equal(
      db.prepare("SELECT canonical_hash FROM team_sync_links").get()
        .canonical_hash,
      conversion.result_hash,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT DISTINCT entity FROM sync_entities WHERE entity LIKE 'report%' OR entity_key LIKE '[\"report%'",
        )
        .all(),
      [],
    );
    assert.equal(
      JSON.parse(
        db
          .prepare("SELECT payload FROM sync_entities WHERE entity='protocol'")
          .get().payload,
      ).version,
      sync.toProtocol,
    );
    assert.equal(
      sync.receiptsKept,
      db.prepare("SELECT COUNT(*) n FROM sync_receipts").get().n,
    );
    assert.ok(sync.conflictsKept >= 1, "settled conflicts are history");
    // Local exclusions of this site follow the renamed memo.
    assert.deepEqual(
      db
        .prepare("SELECT kind,entity_key FROM site_retention")
        .all()
        .map((r) => [r.kind, JSON.parse(r.entity_key)]),
      label === "v2"
        ? [
            [
              "document",
              ["sheetCloneMemo", ...manifest.excludedInternally.slice(1)],
            ],
          ]
        : [],
    );
    // Import retries are found again under the new mode name.
    const modes = db
      .prepare(
        "SELECT json_extract(response,'$.mode') mode FROM operations WHERE json_extract(response,'$.kind') IS NULL ORDER BY 1",
      )
      .all()
      .map((r) => r.mode);
    assert.deepEqual(modes, ["append-to-sheet-clone", "create-sheet-clone"]);
    assert.equal(summary.retries.importKeys, 2);
    db.close();
    // The release answers as the old one did, under the new names.
    db = openDatabase(path);
    t.after(() => db.close());
    const api = await serve(t, db);
    const legacy = expected.internal;
    if (label === "v2") {
      assert.deepEqual(
        ok(await api(`/sheet-clones?teamId=${teamId}`)).sheetClones,
        legacy.list,
      );
      for (const [id, saved] of Object.entries(legacy.reports)) {
        assert.deepEqual(
          ok(await api(`/sheet-clones/${id}`)),
          saved.report,
          id,
        );
        for (const [taskId, documents] of Object.entries(saved.documents))
          sameDocuments(
            ok(
              await api(
                `/sheet-clones/${id}/tasks/${taskId}/documents?content=1`,
              ),
            ),
            documents,
            `${id}/${taskId}`,
          );
        sameDocuments(
          ok(await api(`/sheet-clones/${id}/memos?content=1`)),
          saved.memos,
          `${id} memos`,
        );
      }
      for (const [taskId, documents] of Object.entries(legacy.tasks))
        sameDocuments(
          ok(await api(`/tasks/${taskId}/documents?content=1`)),
          documents,
          taskId,
        );
      sameDocuments(
        ok(await api(`/teams/${teamId}/years/2026/memos?content=1`)),
        legacy.memos,
        "memos",
      );
      const calendar = ok(
        await api(`/calendar/entries/${manifest.calendar.E1}/document`),
      );
      assert.equal(calendar.markdown, convertedText(legacy.calendar.markdown));
      assert.equal(calendar.revision, legacy.calendar.revision + 1);
      // Link titles answer for the new addresses only.
      const links = legacy.links.map((link) => ({
        ...link,
        path: newPath(link.path),
      }));
      assert.deepEqual(
        ok(
          await api(
            `/document-links?${new URLSearchParams({ links: links.map((l) => l.path).join(",") })}`,
          ),
        ).links,
        links,
      );
      assert.equal(
        (
          await api(
            `/document-links?${new URLSearchParams({ links: legacyPath(links[0].path) })}`,
          )
        ).status,
        400,
      );
      for (const [sheetId, entries] of Object.entries(legacy.history))
        assert.deepEqual(
          ok(
            await api(`/audit?teamId=${teamId}&sheetId=${sheetId}&limit=200`),
          ).entries.map(({ createdAt, ...e }) => e),
          entries.map(renamedHistory).map(({ createdAt, ...e }) => e),
          sheetId,
        );
    }
    // No route answers the earlier names.
    for (const path of [
      `/reports?teamId=${teamId}`,
      `/reports/${R1}`,
      `/reports/${R1}/memos`,
    ])
      assert.equal((await api(path)).status, 404, path);
    assert.equal(
      (await api("/reports", { teamId, ids: [R1] }, "DELETE")).status,
      404,
    );
    // Rerunning the migration changes nothing.
    db.close();
    const before = sha(path);
    const again = new DatabaseSync(path);
    assert.equal(migrateSqlite(again, { convert }).applied, false);
    again.close();
    assert.equal(sha(path), before);
    db = openDatabase(path);
  });

test("SQLite conversion refuses pending, held, unresolved, active and unreproducible state and changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-sheet-clone-preflight-"));
  try {
    const convert = sqliteSheetCloneConversion({ origins: ORIGINS, now: NOW });
    for (const [name, setup, pattern] of [
      [
        "pending",
        (db) =>
          db
            .prepare(
              "INSERT INTO sync_outbox(op_id,team_id,payload,payload_hash,status,created_at) VALUES('pending-op',?,'{}',NULL,'pending',?)",
            )
            .run(teamId, NOW),
        /1 pending or held commands/,
      ],
      [
        "held",
        (db) =>
          db
            .prepare(
              "INSERT INTO sync_outbox(op_id,team_id,payload,payload_hash,status,created_at) VALUES('held-op',?,'{}',NULL,'held',?)",
            )
            .run(teamId, NOW),
        /1 pending or held commands/,
      ],
      [
        "conflict",
        (db) =>
          db.exec(
            "UPDATE sync_conflicts SET resolution=NULL WHERE rowid=(SELECT MIN(rowid) FROM sync_conflicts)",
          ),
        /unresolved conflicts/,
      ],
      [
        "active",
        (db) => db.exec("UPDATE team_sync_links SET mode='active'"),
        /synchronization is active/,
      ],
      [
        "import",
        (db) =>
          db.exec(
            "UPDATE audit SET after_json=json_set(after_json,'$.sheet','다른 시트') WHERE action='import'",
          ),
        /cannot be reproduced/,
      ],
      [
        "hash",
        (db) =>
          db.exec(
            "UPDATE sync_entities SET version=version||'x' WHERE entity='team'",
          ),
        /stored canonical hash does not match/,
      ],
    ]) {
      const path = join(dir, name + ".sqlite");
      loadLegacySqlite(path, "v2");
      const db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys=ON");
      setup(db);
      const shape = tables(db),
        dump = JSON.stringify(
          [
            "audit",
            "operations",
            "sync_entities",
            "document_versions",
            "team_sync_links",
          ].map((table) =>
            db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          ),
        );
      assert.throws(
        () => migrateSqlite(db, { convert }),
        (error) =>
          error.code === "SHEET_CLONE_PREFLIGHT" && pattern.test(error.message),
        name,
      );
      assert.equal(
        db.prepare("PRAGMA user_version").get().user_version,
        33,
        name,
      );
      assert.deepEqual(tables(db), shape, name);
      assert.equal(
        JSON.stringify(
          [
            "audit",
            "operations",
            "sync_entities",
            "document_versions",
            "team_sync_links",
          ].map((table) =>
            db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          ),
        ),
        dump,
        name,
      );
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI dry-run converts a copy only, refuses without the conversion and prints the same result as the real run", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-sheet-clone-cli-"));
  try {
    const path = join(dir, "legacy.sqlite");
    loadLegacySqlite(path, "v2");
    const bytes = sha(path),
      run = (...args) =>
        spawnSync(
          process.execPath,
          [
            "scripts/migrate.mjs",
            "--engine",
            "sqlite",
            "--database",
            path,
            ...args,
          ],
          { encoding: "utf8" },
        ),
      origins = ORIGINS.flatMap((origin) => ["--site-origin", origin]);
    const dry = run(...origins, "--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(sha(path), bytes);
    const preview = JSON.parse(dry.stdout);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.applied, false);
    const real = run(...origins);
    assert.equal(real.status, 0, real.stderr);
    const applied = JSON.parse(real.stdout);
    assert.equal(applied.applied, true);
    const { convertedAt: a, ...dryConversion } = preview.conversion,
      { convertedAt: b, ...realConversion } = applied.conversion;
    assert.deepEqual(realConversion, dryConversion);
    assert.equal(JSON.parse(run(...origins).stdout).applied, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Markdown links: only destinations move, byte for byte, and the conversion is idempotent", () => {
  const body = expected.internal.tasks[T1].documents[0].markdown,
    converted = convertMarkdownLinks(body, { origins: ORIGINS });
  assert.equal(converted.markdown, convertedText(body));
  assert.deepEqual(converted.unverified, []);
  assert.deepEqual(converted.kept, [
    `https://unrelated.example.org/links/report-task/${R1}/${T1}`,
  ]);
  assert.equal(
    convertMarkdownLinks(converted.markdown, { origins: ORIGINS }).changes,
    0,
  );
  // Without the operator's origins an absolute address stays as written.
  const relativeOnly = convertMarkdownLinks(body).markdown;
  assert.match(
    relativeOnly,
    new RegExp(`\\]\\(${manifest.origins.internal}/links/report-task/`),
  );
  assert.match(relativeOnly, /\]\(\/links\/sheet-clone-task\//);
});

test("a JSON export v6 converts to v7 with sheetClones and converted links", () => {
  const legacy = JSON.parse(read("export-v6.json")),
    { export: converted, links } = convertExport(legacy, { origins: ORIGINS });
  assert.equal(converted.schemaVersion, 7);
  assert.equal(converted.reports, undefined);
  assert.equal(converted.sheetClones.length, legacy.reports.length);
  assert.ok(links > 0);
  assert.deepEqual(
    converted.sheetClones.map((s) =>
      s.data.tasks.map((t) => t.documents?.map((d) => d.markdown)),
    ),
    legacy.reports.map((s) =>
      s.data.tasks.map((t) =>
        t.documents?.map((d) => convertedText(d.markdown)),
      ),
    ),
  );
  assert.throws(() => convertExport(converted, {}), /schemaVersion 6/);
});

test("a final v33 backup restores as v33, converts to v34 and keeps its recovery state and images", async (t) => {
  const { restoreDatabase } = await import("../scripts/restore.mjs");
  const dir = mkdtempSync(join(tmpdir(), "gb-sheet-clone-restore-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backup = join(dir, "final.sqlite"),
    restored = join(dir, "restored.sqlite"),
    images = join(dir, "images");
  loadLegacySqlite(backup, "v2");
  cpSync(new URL("images", FIXTURE), backup + ".images", { recursive: true });
  restoreDatabase(backup, restored, { documentImagesDir: images });
  let db = new DatabaseSync(restored);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 33);
  assert.equal(
    db.prepare("SELECT mode FROM team_sync_links").get().mode,
    "recovery",
  );
  assert.ok(
    existsSync(
      join(images, manifest.image.replace("/api/document-images/", "")),
    ),
  );
  const result = migrateSqlite(db, {
    convert: sqliteSheetCloneConversion({ origins: ORIGINS, now: NOW }),
  });
  assert.equal(result.to, SQLITE_VERSION);
  assert.equal(result.conversion.sync[0].mode, "recovery");
  assert.equal(
    db.prepare("SELECT base_head FROM sync_conversions").get().base_head,
    manifest.sync.v2.head,
  );
  db.close();
  db = openDatabase(restored);
  t.after(() => db.close());
  const api = await serve(t, db);
  assert.deepEqual(
    ok(await api(`/sheet-clones?teamId=${teamId}`)).sheetClones,
    expected.internal.list,
  );
  sameDocuments(
    ok(await api(`/tasks/${T1}/documents?content=1`)),
    expected.internal.tasks[T1],
    "restored T1",
  );
});
