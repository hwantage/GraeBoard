import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performanceFixture } from "../scripts/sync-performance.mjs";
import { postgresFixture } from "./business-storage-fixture.mjs";
import { githubEmulator, bucket } from "./worker-github-fixture.mjs";
import { createExternalRouteApp } from "./external-route-fixture.mjs";
import {
  transaction,
  upsertCellStatement,
  writeFormatting,
  getTask,
} from "../server/db.mjs";
import { encodeSheetClone } from "../server/sheet-clones.mjs";
import { storeDocumentVersion } from "../server/document-storage.mjs";
import {
  defaultView,
  DEFAULT_SETTINGS,
  weeksForYear,
} from "../shared/domain.js";
import { canonical, entityId, stateHash } from "../server/sync/protocol.mjs";
import { serviceFor } from "../worker/sync.mjs";
import { GitHubApiTransport } from "../worker/git.mjs";
import { unpack } from "../shared/compact.js";
import { unpackSheetCloneData } from "../shared/sheet-clone-sync-data.js";

// Entirely synthetic, including the retained copies that make C exceed 20 MiB.
// Reuses the SQLite/Git performance fixture and the real external API/PG store.
export async function sheetCloneSyncFixture(t, { rows = 480 } = {}) {
  const f = await performanceFixture({
    rows,
    clients: 1,
    users: 1,
    documents: 11,
    scheduleColumns: 0,
  });
  t.after(() => f.close());
  const github = githubEmulator(f.remote),
    nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.origin === "https://api.github.com")
      return github.fetch(url.href, init);
    assert.equal(
      url.hostname,
      "127.0.0.1",
      "no live HTTP permitted in clone fixture",
    );
    return nativeFetch(input, init);
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
  });
  const user = f.db.prepare("SELECT * FROM users LIMIT 1").get();
  transaction(f.db, () => {
    const cell = upsertCellStatement(f.db),
      weeks = weeksForYear(2026);
    for (const taskId of f.taskIds)
      for (const week of weeks.slice(0, 34))
        cell.run(
          taskId,
          week.key,
          "합성 일정 검토 · " + "w".repeat(28),
          { backgroundColor: "#d1eee6", bold: true },
          1,
        );
    writeFormatting(f.db, f.teamId, {
      revision: 8,
      rules: Array.from({ length: 8 }, (_, i) => ({
        id: `clone-rule-${i}`,
        rows: f.taskIds.slice(0, i < 5 ? 430 : 19),
        keys: [
          i < 6
            ? [
                "title",
                "description",
                "owner",
                "supporters",
                "status",
                "category",
              ][i]
            : weeks[i].key,
        ],
        excludeKeys: [],
        style: { backgroundColor: "#d1eee6" },
        orders: { backgroundColor: i + 1 },
      })),
    });
    // Same body size as the incident's three ~33 KB document autosaves.
    const documents = f.db
      .prepare("SELECT task_id,id FROM task_documents")
      .all();
    for (const doc of documents) {
      const version = storeDocumentVersion(f.db, {
        teamId: f.teamId,
        documentId: doc.id,
        markdown: "synthetic body\n" + "d".repeat(16000),
        actorId: user.id,
      });
      f.db
        .prepare(
          "UPDATE task_documents SET version_id=? WHERE task_id=? AND id=?",
        )
        .run(version, doc.task_id, doc.id);
    }
    const retained = getTask(f.db, f.taskIds[0]);
    retained.cells.description.value =
      "retained synthetic sheet\n" + "r".repeat(7 * 1024 * 1024);
    for (let i = 0; i < 2; i++)
      f.db.prepare("INSERT INTO sheet_clones VALUES(?,?,?,?,?,?,?,?)").run(
        randomUUID(),
        f.teamId,
        2026,
        `Retained ${i}`,
        "2026-10-01",
        user.id,
        new Date().toISOString(),
        encodeSheetClone({
          tasks: [retained],
          users: [{ id: user.id, name: user.name }],
          view: defaultView(2026),
          settings: DEFAULT_SETTINGS,
        }),
      );
  });
  f.setLink("initializing");
  const inside = f.app.locals.sync.store(f.teamId);
  await f.app.locals.sync.get(f.teamId).run({ initialize: true });
  const internalLink = inside.readLink(),
    initialState = inside.readState();
  const link = {
    ...internalLink,
    profile_id: "contract",
    installation_id: randomUUID(),
    writer_epoch: randomUUID(),
    remote_status: canonical({ capabilities: ["sum-1"] }),
    mode: "active",
  };
  const pg = await postgresFixture(t, {
    ...f,
    user,
    link,
    state: initialState,
  });
  const profile = {
    ...JSON.parse(pg.env.SYNC_PROFILES)[0],
    repository: "fixture/team",
  };
  Object.assign(pg.env, {
    INSTALLATION_ID: link.installation_id,
    BUCKET: bucket(),
    TOKEN: "fixture-secret",
    SYNC_PROFILES: JSON.stringify([profile]),
  });
  const app = createExternalRouteApp({ env: pg.env, defaultUserId: user.id });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await app.close();
  });
  const call = async (path, body, method = body ? "POST" : "GET") => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "WeeklyPlan",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    const value = unpack(await response.json());
    assert.ok(
      response.ok,
      JSON.stringify({ path, status: response.status, value }),
    );
    return value;
  };
  const clone = await call("/sheet-clones", {
    teamId: f.teamId,
    year: 2026,
    name: "External large clone",
    referenceDate: "2026-11-08",
    taskIds: f.taskIds,
    view: defaultView(2026),
  });
  const editedDocs = f.db
    .prepare(
      "SELECT task_id,id FROM task_documents ORDER BY task_id,id LIMIT 3",
    )
    .all();
  for (let i = 0; i < 3; i++) {
    const editPath = `/sheet-clones/${clone.id}/tasks/${editedDocs[i].task_id}/documents/${editedDocs[i].id}`;
    const before = await call(editPath);
    await call(
      editPath,
      {
        operationId: randomUUID(),
        expectedRevision: before.revision,
        markdown: `external edit ${i}\n` + "d".repeat(16000),
      },
      "PUT",
    );
  }
  const pending = await pg.adapter.readPending(f.teamId);
  assert.equal(pending.length, 4);
  assert.equal(
    pending[0].changes.filter((c) => c.entity === "document").length,
    11,
  );
  const phases = [];
  const transport = new GitHubApiTransport({
    repository: "fixture/team",
    token: "fixture-secret",
    fetch: github.fetch,
  });
  async function run({ serviceFactory = serviceFor, ...options } = {}) {
    const log = console.log,
      parse = JSON.parse;
    const cloneText = canonical(pending[0]);
    let cloneParses = 0;
    JSON.parse = (text, ...args) => {
      if (text === cloneText) cloneParses++;
      return parse(text, ...args);
    };
    console.log = (...args) =>
      args[0] === "GraeBoard sync phase"
        ? phases.push(JSON.parse(args[1]))
        : log(...args);
    const started = performance.now(),
      cpu = process.cpuUsage(),
      firstPhase = phases.length;
    try {
      await serviceFactory(
        { ...pg.env, SYNC_PHASE_LOG: "1" },
        profile,
        await pg.adapter.readLink(f.teamId),
        { transport, incrementalMaterialize: true, ...options },
      ).run({ updateStatus: false });
    } finally {
      console.log = log;
      JSON.parse = parse;
    }
    const used = process.cpuUsage(cpu);
    return {
      wallMs: performance.now() - started,
      cpuMs: (used.user + used.system) / 1000,
      cloneParses,
      phases: phases.slice(firstPhase),
      pending: (await pg.adapter.readPending(f.teamId)).length,
    };
  }
  async function remoteEdit(i) {
    await f.api("/cells/batch", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes: [
        {
          taskId: f.taskIds[0],
          key: "title",
          value: `remote ${i}`,
          expectedVersion: f.db
            .prepare(
              "SELECT version FROM cells WHERE task_id=? AND key='title'",
            )
            .get(f.taskIds[0]).version,
        },
      ],
    });
    await f.app.locals.sync.get(f.teamId).run();
  }
  async function verify() {
    await f.app.locals.sync.get(f.teamId).run();
    const external = await pg.adapter.readState(f.teamId),
      internal = inside.readState();
    assert.equal(stateHash(external), stateHash(internal));
    assert.equal(
      (await pg.adapter.readLink(f.teamId)).canonical_head,
      inside.readLink().canonical_head,
    );
    const created = internal.entities[entityId("sheetClone", [clone.id])];
    assert.equal(
      canonical(created.payload),
      canonical(
        pending[0].changes.find((c) => c.entity === "sheetClone").desired,
      ),
    );
    for (let i = 0; i < 3; i++) {
      const doc =
        internal.entities[
          entityId("document", [
            "sheetClone",
            clone.id,
            editedDocs[i].task_id,
            editedDocs[i].id,
          ])
        ];
      assert.equal(
        doc.payload.markdown,
        `external edit ${i}\n` + "d".repeat(16000),
      );
    }
    for (const op of pending)
      assert.equal(internal.receipts[op.opId].result, "applied");
    assert.equal(Object.keys(external.conflicts).length, 0);
    assert.equal((await pg.adapter.readPending(f.teamId)).length, 0);
    const site = await call(`/sheet-clones/${clone.id}`);
    assert.equal(site.tasks.length, rows);
    const expected = unpackSheetCloneData(created.payload.data);
    const sheetFields = (task) => ({
      id: task.id,
      cells: task.cells,
      defaultStyle: task.defaultStyle,
      rowStyle: task.rowStyle,
      formatting: task.formatting,
    });
    assert.deepEqual(
      site.tasks.map(sheetFields),
      expected.tasks.map(sheetFields),
    );
    const insideView = await f.api(`/sheet-clones/${clone.id}`);
    assert.deepEqual(
      insideView.tasks.map(sheetFields),
      expected.tasks.map(sheetFields),
    );
    return {
      hash: stateHash(external),
      head: inside.readLink().canonical_head,
    };
  }
  return {
    ...f,
    pg,
    profile,
    pending,
    phases,
    transport,
    github,
    clone,
    call,
    run,
    remoteEdit,
    verify,
    metrics: {
      rows,
      initialBytes: Buffer.byteLength(canonical(initialState)),
      entities: Object.keys(initialState.entities).length,
      operationBytes: pending.map((op) => Buffer.byteLength(canonical(op))),
      pending: pending.length,
    },
  };
}
