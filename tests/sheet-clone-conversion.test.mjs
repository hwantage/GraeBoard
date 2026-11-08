// The offline SheetClone conversion against databases the released code wrote
// (tests/fixtures/sheet-clone-legacy, generated from f744ead). The expected
// values below come from that release's own API answers and from the fixture
// text itself, never from the conversion code.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
} from "../tools/sheet-clone-cutover/convert.mjs";
import { convertMarkdownLinks } from "../tools/sheet-clone-cutover/markdown-links.mjs";
import { runCutover } from "../tools/sheet-clone-cutover/cutover.mjs";
import { stableId } from "../shared/workbook.mjs";

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
    syncOptions: {
      profiles: [],
      schedule: false,
      installationId: manifest.installations.internal,
    },
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
  const call = async (path, body, method = body ? "POST" : "GET") => {
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
  return call;
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
    const sync = summary.sync[0];
    assert.equal(sync.fromProtocol, label === "v1" ? 1 : 2);
    assert.equal(sync.toProtocol, label === "v1" ? 3 : 4);
    assert.equal(sync.baseHead, manifest.sync[label].head);
    assert.equal(sync.baseHash, manifest.sync[label].hash);
    assert.equal(
      db.prepare("SELECT canonical_head FROM team_sync_links").get()
        .canonical_head,
      legacyLink.canonical_head,
    );
    assert.equal(
      db.prepare("SELECT canonical_hash FROM team_sync_links").get()
        .canonical_hash,
      sync.resultHash,
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

test("an import applied to several years moves every retry key; a key no import explains or one already taken still refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-sheet-clone-import-years-"));
  try {
    const convert = sqliteSheetCloneConversion({ origins: ORIGINS, now: NOW });
    // stableId(import:sheet:mode:year[:copy]) as the released import wrote it.
    const key = (audit, mode, year) =>
      stableId(
        `${audit.target}:${audit.after.sheet}:${mode}:${year}${audit.after.reportId ? `:${audit.after.reportId}` : ""}`,
      );
    const open = (name) => {
      const path = join(dir, name + ".sqlite");
      loadLegacySqlite(path, "v1");
      const db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys=ON");
      const audits = db
        .prepare("SELECT * FROM audit WHERE action='import' ORDER BY rowid")
        .all()
        .map((row) => ({ ...row, after: JSON.parse(row.after_json) }));
      assert.deepEqual(
        audits.map((audit) => audit.after.mode),
        ["report", "copy"],
      );
      return { db, audits };
    };
    const copyOperation = (db, from, to) =>
      db
        .prepare(
          "INSERT INTO operations(id,actor_id,response,created_at) SELECT ?,actor_id,response,created_at FROM operations WHERE id=?",
        )
        .run(to, from);
    {
      // The same sheet applied again to 2027 and 2100 (renamed or deleted in
      // between): one audit entry and one retry key per application.
      const { db, audits } = open("years");
      for (const audit of audits)
        for (const year of [2027, 2100]) {
          copyOperation(
            db,
            key(audit, audit.after.mode, 2026),
            key(audit, audit.after.mode, year),
          );
          db.prepare(
            "INSERT INTO audit(id,actor_id,team_id,action,target,before_json,after_json,created_at) SELECT ?,actor_id,team_id,action,target,before_json,after_json,created_at FROM audit WHERE id=?",
          ).run(randomUUID(), audit.id);
        }
      const summary = migrateSqlite(db, { convert }).conversion;
      assert.equal(summary.retries.importKeys, 6);
      const mode = {
        report: "create-sheet-clone",
        copy: "append-to-sheet-clone",
      };
      for (const audit of audits)
        for (const year of [2026, 2027, 2100]) {
          assert.equal(
            db
              .prepare("SELECT 1 FROM operations WHERE id=?")
              .get(key(audit, audit.after.mode, year)),
            undefined,
          );
          assert.equal(
            JSON.parse(
              db
                .prepare("SELECT response FROM operations WHERE id=?")
                .get(key(audit, mode[audit.after.mode], year)).response,
            ).mode,
            mode[audit.after.mode],
          );
        }
      db.close();
    }
    for (const [name, setup, pattern] of [
      [
        "unexplained",
        (db, [audit]) =>
          copyOperation(
            db,
            key(audit, "report", 2026),
            key(audit, "report", 1999),
          ),
        /cannot be reproduced/,
      ],
      [
        "taken",
        (db, [audit]) =>
          copyOperation(
            db,
            key(audit, "report", 2026),
            key(audit, "create-sheet-clone", 2026),
          ),
        /already exists/,
      ],
    ]) {
      const { db, audits } = open(name);
      setup(db, audits);
      const before = JSON.stringify(
        db.prepare("SELECT * FROM operations ORDER BY id").all(),
      );
      assert.throws(
        () => migrateSqlite(db, { convert }),
        (error) =>
          error.code === "SHEET_CLONE_PREFLIGHT" && pattern.test(error.message),
        name,
      );
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 33);
      assert.equal(
        JSON.stringify(
          db.prepare("SELECT * FROM operations ORDER BY id").all(),
        ),
        before,
        name,
      );
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cutover dry-run that fails to read or convert leaves no copy of the database behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-sheet-clone-dry-run-failure-")),
    temporary = process.env.TMPDIR;
  try {
    const scratch = join(dir, "tmp");
    mkdirSync(scratch);
    // Not a database: refused before any copy.
    const corrupt = join(dir, "corrupt.sqlite");
    writeFileSync(corrupt, randomBytes(8192));
    // A copy that converts but is refused by the preflight.
    const active = join(dir, "active.sqlite");
    loadLegacySqlite(active, "v1");
    const db = new DatabaseSync(active);
    db.exec("UPDATE team_sync_links SET mode='active'");
    db.close();
    process.env.TMPDIR = scratch;
    for (const [path, pattern] of [
      [corrupt, /not a database/],
      [active, /synchronization is active/],
    ]) {
      const bytes = sha(path);
      // Neither reaches PostgreSQL or Git.
      await assert.rejects(
        runCutover({
          teamId,
          sqlitePath: path,
          pool: null,
          transport: null,
          origins: ORIGINS,
          dryRun: true,
        }),
        pattern,
      );
      assert.deepEqual(readdirSync(scratch), [], path);
      assert.equal(sha(path), bytes, path);
    }
  } finally {
    if (temporary === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = temporary;
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

test("Markdown links: each destination changes once; comments, escaped code and other html keep their bytes", () => {
  const C = "11111111-1111-1111-1111-111111111111",
    T = "22222222-2222-2222-2222-222222222222",
    old = (kind) => `/links/report-${kind}/${C}/${T}`,
    next = (kind) => `/links/sheet-clone-${kind}/${C}/${T}`,
    convert = (markdown) =>
      convertMarkdownLinks(markdown, { origins: ORIGINS });
  const cases = [
    // A toggle title holding an `<a>` tag: one range, one edit.
    [
      `<details>\n<summary><a href="${old("task")}">제목</a></summary>\n\n본문\n</details>`,
      `<details>\n<summary><a href="${next("task")}">제목</a></summary>\n\n본문\n</details>`,
      1,
    ],
    // A title holding html is not a toggle title for the editor
    // (parseSummary): the block is html, so only its `<a>` moves.
    [
      `<details open>\n<summary><h3><a href='${old("memo")}'>h</a> [m](${old("task")})</h3></summary>\n\n</details>`,
      `<details open>\n<summary><h3><a href='${next("memo")}'>h</a> [m](${old("task")})</h3></summary>\n\n</details>`,
      1,
    ],
    // Comments and escaped code are text, not links.
    [
      `<!-- <a href="${old("task")}">x</a> [y](${old("task")}) -->\n\n<pre><code>&lt;a href="${old("task")}"&gt;</code></pre>\n\n앞 <!-- [z](${old("memo")}) --> 뒤\n`,
      null,
      0,
    ],
    // A summary that is not a toggle title stays the html it is.
    [`<summary>[x](${old("task")})</summary>\n`, null, 0],
    // Ordinary Markdown: inline, reference, autolink and an inline anchor
    // whose other attribute only mentions an address.
    [
      `[a](${old("task")}) [r][ref] <${ORIGINS[0]}${old("memo")}> <a title="href=${old("task")}" href="${old("memo")}?v=1#s">b</a> \`${old("task")}\`\n\n\`\`\`\n[c](${old("task")})\n\`\`\`\n\n[ref]: ${old("memo")} "t"\n`,
      `[a](${next("task")}) [r][ref] <${ORIGINS[0]}${next("memo")}> <a title="href=${old("task")}" href="${next("memo")}?v=1#s">b</a> \`${old("task")}\`\n\n\`\`\`\n[c](${old("task")})\n\`\`\`\n\n[ref]: ${next("memo")} "t"\n`,
      4,
    ],
  ];
  for (const [markdown, expected, changes] of cases) {
    const converted = convert(markdown);
    assert.equal(converted.markdown, expected ?? markdown, markdown);
    assert.equal(converted.changes, changes, markdown);
    assert.deepEqual(converted.unverified, [], markdown);
    assert.equal(convert(converted.markdown).changes, 0, markdown);
  }
});

test("Markdown links in toggles follow the editor's toggle grammar: any case, a body without a blank line, nesting, text after </details>, lists and quotes", () => {
  const C = "11111111-1111-1111-1111-111111111111",
    T = "22222222-2222-2222-2222-222222222222",
    task = `/links/report-task/${C}/${T}`,
    memo = `/links/report-memo/${C}/${T}`,
    convert = (markdown) => convertMarkdownLinks(markdown, { origins: [] });
  // The stored body with exactly these destinations moved, each once.
  const moved = (markdown, ...positions) => {
    let text = markdown;
    for (const at of positions.sort((a, b) => b - a))
      text =
        text.slice(0, at) +
        text.slice(at).replace(/^\/links\/report-/, "/links/sheet-clone-");
    return text;
  };
  const nth = (markdown, url, n) => {
    let at = -1;
    for (let i = 0; i <= n; i++) at = markdown.indexOf(url, at + 1);
    return at;
  };
  const upper = `<DETAILS>\n<SUMMARY>[title](${task})</SUMMARY>\n\nbody\n</DETAILS>`,
    tight = `<details>\n<summary>title</summary>\n[body link](${task})\n</details>`,
    nested = `<details open>\n<summary><h2>outer [o](${task})</h2></summary>\n\n<details>\n<summary>inner</summary>\n[i](${memo}) \`${task}\` <!-- [c](${task}) -->\n</details>\n\n</details>\n[after](${task})\n`,
    fenced =
      "<details>\n<summary>t</summary>\n```text\n[f](" +
      task +
      ")\n```\n</details>\n",
    list = `- <details>\n  <summary>[t](${task})</summary>\n  [b](${memo})\n  </details>\n`,
    quote = `> <details>\n> <summary>[t](${task})</summary>\n>\n> body [b](${memo})\n> </details>\n`,
    anchor = `<A TITLE="a > b" HREF="${task}">x</A> <a data-x='${memo}' href='${memo}'>y</a>\n`;
  for (const [markdown, expected] of [
    [upper, upper.replace(task, task.replace("report-", "sheet-clone-"))],
    [tight, tight.replace(task, task.replace("report-", "sheet-clone-"))],
    [
      nested,
      moved(
        nested,
        nth(nested, task, 0),
        nth(nested, memo, 0),
        nth(nested, task, 3),
      ),
    ],
    [fenced, fenced],
    // No toggle is open, or the editor keeps the html as html: text stays.
    [`</details>\n[x](${task})\n`, null],
    [
      `<details class="x">\n<summary>t</summary>\n[x](${task})\n</details>\n`,
      null,
    ],
    [list, moved(list, nth(list, task, 0), nth(list, memo, 0))],
    [quote, moved(quote, nth(quote, task, 0), nth(quote, memo, 0))],
    [anchor, moved(anchor, nth(anchor, task, 0), nth(anchor, memo, 1))],
  ]) {
    const converted = convert(markdown),
      changes = expected ? expected.split("/links/sheet-clone-").length - 1 : 0;
    assert.equal(converted.markdown, expected ?? markdown, markdown);
    assert.equal(converted.changes, changes, markdown);
    assert.deepEqual(converted.unverified, [], markdown);
    assert.equal(convert(converted.markdown).changes, 0, markdown);
  }
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

test("the cutover tool's export dry-run writes nothing; the real run writes the converted file once", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-sheet-clone-export-cli-"));
  try {
    const output = join(dir, "export-v7.json"),
      run = (...args) =>
        spawnSync(
          process.execPath,
          [
            "tools/sheet-clone-cutover/cli.mjs",
            "export",
            "--input",
            new URL("export-v6.json", FIXTURE).pathname,
            "--output",
            output,
            ...ORIGINS.flatMap((origin) => ["--site-origin", origin]),
            ...args,
          ],
          { encoding: "utf8" },
        );
    const dry = run("--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(existsSync(output), false);
    const preview = JSON.parse(dry.stdout);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.applied, false);
    const real = run();
    assert.equal(real.status, 0, real.stderr);
    const { dryRun, applied, ...result } = preview;
    assert.deepEqual(JSON.parse(real.stdout), result);
    const written = readFileSync(output, "utf8");
    assert.equal(
      written,
      JSON.stringify(
        convertExport(JSON.parse(read("export-v6.json")), { origins: ORIGINS })
          .export,
      ),
    );
    // An existing file is neither previewed over nor replaced.
    for (const args of [[], ["--dry-run"]]) {
      const again = run(...args);
      assert.notEqual(again.status, 0);
      assert.match(again.stderr, /Refusing to overwrite/);
      assert.equal(readFileSync(output, "utf8"), written);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.equal(result.conversion.sync[0].baseHead, manifest.sync.v2.head);
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
