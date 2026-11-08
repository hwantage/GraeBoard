// Generates the pre-SheetClone fixtures with the released code itself.
//
// Run it only from an export of f744ead39cead92ccdeff8e3efbf08067891ae80
// (SQLite v33, PostgreSQL team v2, sync v1/v2, JSON export v6), never from a
// newer tree: the point of these files is that the old implementation wrote
// them through its own HTTP API, so the conversion and its tests cannot share
// a mistake with them.
//
//   git archive f744ead | tar -x -C /tmp/graeboard-f744ead
//   ln -s "$PWD/node_modules" /tmp/graeboard-f744ead/node_modules
//   cd /tmp/graeboard-f744ead
//   TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin \
//     node /path/to/tests/fixtures/sheet-clone-legacy/generate-f744ead.mjs \
//     /path/to/tests/fixtures/sheet-clone-legacy
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const root = process.cwd(),
  out = resolve(process.argv[2] || ""),
  pgBin = process.env.TEST_PG_BIN;
assert.ok(process.argv[2], "output directory required");
assert.ok(pgBin && existsSync(join(pgBin, "initdb")), "TEST_PG_BIN required");
const load = (path) => import(pathToFileURL(join(root, path)).href);
const { SQLITE_VERSION } = await load("server/migrations/sqlite.mjs");
assert.equal(SQLITE_VERSION, 33, "run from the f744ead export");
assert.ok(existsSync(join(root, "server/reports.mjs")), "run from f744ead");

const { Pool } = (await import("pg")).default;
const ExcelJS = (await import("exceljs")).default;
const sharp = (await import("sharp")).default;
const { openDatabase, json } = await load("server/db.mjs");
const { createApp } = await load("server/app.mjs");
const { DEFAULT_SETTINGS, defaultView } = await load("shared/domain.js");
const { unpack } = await load("shared/compact.js");
const { GitCliTransport } = await load("server/sync/git-cli.mjs");
const { stateHash, stateSum, protocolVersion } = await load(
  "server/sync/protocol.mjs",
);
const { migratePostgres } = await load("server/migrations/postgres.mjs");
const { PostgresDatabase } = await load("worker/storage/postgres.mjs");
const { createWorker } = await load("worker/entry.mjs");
const { runTeam } = await load("worker/sync.mjs");
const { profileFor } = await load("shared/sync-profiles.js");
const { githubEmulator, bucket } = await load(
  "tests/worker-github-fixture.mjs",
);

const work = mkdtempSync(join(tmpdir(), "gb-sheet-clone-legacy-")),
  remote = join(work, "remote.git"),
  socket = join(work, "socket"),
  pgData = join(work, "pg"),
  port = 55471,
  teamId = randomUUID(),
  lead = randomUUID(),
  member = randomUUID(),
  externalInstallation = randomUUID(),
  internalInstallation = randomUUID(),
  INTERNAL_ORIGIN = "https://graeboard-internal.example.com",
  EXTERNAL_ORIGIN = "https://graeboard-external.example.com",
  nativeFetch = globalThis.fetch,
  pending = [];
mkdirSync(socket);
const log = (...args) => console.error("[fixture]", ...args);
const pg = (bin, args) => {
  const r = spawnSync(join(pgBin, bin), args, { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
};
const url = (name) =>
  `postgresql://postgres@localhost/${name}?host=${encodeURIComponent(socket)}&port=${port}`;
let pgStarted = false,
  server,
  db;
const pools = [];
try {
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const github = githubEmulator(remote);
  const readme = github.text(["hash-object", "-w", "--stdin"], {
    input: "fixture",
  });
  const tree = github.text(["mktree"], {
    input: `100644 blob ${readme}\tREADME.md\n`,
  });
  github.text([
    "update-ref",
    "refs/heads/main",
    github.text(["commit-tree", tree, "-m", "init"]),
  ]);
  globalThis.fetch = (input, init) => {
    const target = new URL(typeof input === "string" ? input : input.url);
    if (target.origin === "https://api.github.com")
      return github.fetch(target.href, init);
    assert.equal(target.hostname, "127.0.0.1", "unexpected live HTTP");
    return nativeFetch(input, init);
  };
  pg("initdb", [
    "-D",
    pgData,
    "-A",
    "trust",
    "-U",
    "postgres",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  pg("pg_ctl", [
    "-D",
    pgData,
    "-l",
    join(work, "pg.log"),
    "-o",
    `-k ${socket} -p ${port} -c listen_addresses=''`,
    "-w",
    "start",
  ]);
  pgStarted = true;
  const rootPool = new Pool({ connectionString: url("postgres") });
  pools.push(rootPool);
  await rootPool.query("CREATE DATABASE control");
  await rootPool.query("CREATE DATABASE team");
  const control = new Pool({ connectionString: url("control") }),
    team = new Pool({ connectionString: url("team") });
  pools.push(control, team);
  await migratePostgres(control, { scope: "control", initialize: true });
  await migratePostgres(team, { scope: "team", initialize: true, teamId });
  const pgStore = new PostgresDatabase(team, { teamId });

  // Internal SQLite site.
  const imagesDir = join(work, "images");
  db = openDatabase(join(work, "inside.sqlite"));
  const settings = structuredClone(DEFAULT_SETTINGS);
  db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
    teamId,
    "사본 전환 fixture",
    json(settings),
  );
  for (const [id, username, name, role] of [
    [lead, "lead@example.com", "팀장", "admin"],
    [member, "member@example.com", "팀원", "user"],
  ]) {
    db.prepare(
      "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'fixture-password-hash',?,?)",
    ).run(id, username, name, role, new Date().toISOString());
    db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(
      id,
      teamId,
      id === lead ? "lead" : "member",
    );
  }
  const token = randomUUID();
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    lead,
    Date.now() + 30 * 86400000,
  );
  const transport = new GitCliTransport({
    directory: join(work, "inside.git"),
    repository: remote,
    allowLocal: true,
  });
  const app = createApp({
    db,
    rateLimits: false,
    documentImagesDir: imagesDir,
    syncOptions: {
      installationId: internalInstallation,
      profiles: [
        {
          profileId: "inside",
          teamId,
          repository: "fixture/team",
          peerInstallationId: externalInstallation,
        },
      ],
      transports: { inside: transport },
      schedule: false,
    },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const call = async (send, path, body, method) => {
    const response = await send(path, body, method);
    const text = await response.text();
    let data;
    try {
      data = unpack(JSON.parse(text));
    } catch {
      data = text;
    }
    return { status: response.status, data, response };
  };
  const inside = (path, body, method = body ? "POST" : "GET") =>
    call(
      (p, b, m) =>
        nativeFetch(`http://127.0.0.1:${server.address().port}/api${p}`, {
          method: m,
          headers: {
            cookie: "weekly_session=" + token,
            "X-Requested-With": "WeeklyPlan",
            ...(b instanceof FormData
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(b ? { body: b instanceof FormData ? b : JSON.stringify(b) } : {}),
        }),
      path,
      body,
      method,
    );
  const ok = (result, status) => {
    assert.ok(
      status ? result.status === status : result.status < 300,
      JSON.stringify({ status: result.status, data: result.data }),
    );
    return result.data;
  };

  // External PostgreSQL site.
  const images = bucket(),
    env = {
      APP_ORIGIN: EXTERNAL_ORIGIN,
      ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
      ACCESS_AUDIENCE: "fixture",
      SETUP_TOKEN: "fixture-setup-token-with-enough-entropy",
      INSTALLATION_ID: externalInstallation,
      PEER_INSTALLATION_ID: internalInstallation,
      PG_CONTROL: { connectionString: url("control") },
      PG_TEAM: { connectionString: url("team") },
      R2_TEAM: images,
      GIT_TOKEN: "fixture-secret",
      SYNC_PROFILES: JSON.stringify([
        {
          profileId: "outside",
          teamId,
          repository: "fixture/team",
          databaseBinding: "PG_TEAM",
          bucketBinding: "R2_TEAM",
          githubSecret: "GIT_TOKEN",
        },
      ]),
    },
    worker = createWorker({
      verify: async () => ({
        issuer: env.ACCESS_ISSUER,
        subject: "external-subject",
        email: "outside@example.com",
        expiresAt: Date.now() + 3600000,
      }),
    });
  const outside = (path, body, method = body ? "POST" : "GET") =>
    call(
      (p, b, m) =>
        worker.fetch(
          new Request(env.APP_ORIGIN + "/api" + p, {
            method: m,
            headers: {
              "X-Requested-With": "WeeklyPlan",
              ...(b instanceof FormData
                ? {}
                : { "Content-Type": "application/json" }),
            },
            ...(b
              ? { body: b instanceof FormData ? b : JSON.stringify(b) }
              : {}),
          }),
          env,
          { waitUntil: (p) => pending.push(p) },
        ),
      path,
      body,
      method,
    );
  const profile = () => profileFor(env, "outside", teamId);
  const flush = async () => {
    for (let i = 0; i < pending.length; i++) await pending[i];
    pending.length = 0;
  };
  const internalRun = () => app.locals.sync.get(teamId).run();
  const externalRun = async () => {
    await flush();
    if ((await pgStore.readLink(teamId))?.mode === "active")
      await runTeam(env, profile());
  };
  const converge = async () => {
    for (let i = 0; i < 6; i++) {
      await externalRun();
      await internalRun();
    }
    await externalRun();
  };

  // Business data that the conversion must keep, created through the API.
  const year = 2026,
    view = defaultView(year);
  const task = async (title) =>
    ok(await inside("/tasks", { teamId, year, fields: { title } })).task;
  const T1 = await task("원본 업무 하나"),
    T2 = await task("원본 업무 둘"),
    T3 = await task("원본 업무 셋");
  const cells = (changes) =>
    inside("/cells/batch", {
      operationId: randomUUID(),
      createdAt: new Date().toISOString(),
      changes,
    });
  ok(
    await cells([
      { taskId: T1.id, key: "2026-10-05", expectedVersion: 0, value: "일정" },
      {
        taskId: T2.id,
        key: "2026-10-12",
        expectedVersion: 0,
        value: "주간 계획",
        style: { bold: true, backgroundColor: "#ddeeff" },
      },
    ]),
  );
  const png = await sharp({
      create: { width: 6, height: 4, channels: 4, background: "#335577" },
    })
      .png()
      .toBuffer(),
    form = new FormData();
  form.set("image", new File([png], "fixture.png"));
  const imageUrl = ok(
    await inside(`/tasks/${T1.id}/document/images`, form),
  ).url;
  const R1 = randomUUID(),
    R2 = randomUUID(),
    R3 = randomUUID(),
    M1 = randomUUID(),
    M2 = randomUUID(),
    E1 = randomUUID(),
    T4 = randomUUID();
  // Every place the old address may appear. Only real link destinations of
  // this app (relative, or an origin the operator names) change.
  const zoo = (copy, memo, other) =>
    [
      "# 링크 모음",
      "",
      `사본 업무: [사본 업무](/links/report-task/${copy}/${T1.id})`,
      `사본 메모: [사본 메모](/links/report-memo/${copy}/${memo})`,
      `전체 화면: [전체](/links/report-task/${copy}/${T1.id}?view=full)`,
      `조각: [조각](/links/report-memo/${copy}/${memo}#section)`,
      `사내 절대 주소: [절대](${INTERNAL_ORIGIN}/links/report-task/${copy}/${T1.id})`,
      `외부 자동 링크: <${EXTERNAL_ORIGIN}/links/report-memo/${copy}/${memo}>`,
      `리터럴 자동 링크: ${INTERNAL_ORIGIN}/links/report-task/${copy}/${T2.id}`,
      `무관한 사이트: [무관](https://unrelated.example.org/links/report-task/${copy}/${T1.id})`,
      `참조형: [참조 링크][ref-copy]`,
      `삭제된 사본: [삭제](/links/report-task/${other}/${T1.id})`,
      `원본 업무: [업무](/links/task/${T1.id}) 메모: [메모](/links/memo/${teamId}/${year}/${M1})`,
      `문장 속 report-task 와 /links/report-task/${copy}/${T1.id} 는 링크가 아니다.`,
      "인라인 코드 `/links/report-memo/" + copy + "/" + memo + "`",
      "",
      "```text",
      `[코드 안](/links/report-task/${copy}/${T1.id})`,
      "```",
      "",
      "<details open>",
      `<summary><h2>[토글 제목](/links/report-task/${copy}/${T1.id})</h2></summary>`,
      "",
      `토글 안 [메모](/links/report-memo/${copy}/${memo})`,
      "",
      "</details>",
      "",
      `<a href="/links/report-memo/${copy}/${memo}">HTML 링크</a>`,
      "",
      `| 표 | 링크 |`,
      `| --- | --- |`,
      `| 셀 | [표 안](/links/report-task/${copy}/${T3.id}) |`,
      "",
      `![그림](${imageUrl})`,
      "",
      `[ref-copy]: /links/report-task/${copy}/${T2.id} "참조 제목"`,
      "",
    ].join("\n");
  const save = async (send, path, markdown) => {
    const current = ok(await send(path));
    return ok(
      await send(
        path,
        {
          operationId: randomUUID(),
          expectedRevision: current.revision,
          markdown,
        },
        "PUT",
      ),
    );
  };
  await save(inside, `/tasks/${T1.id}/document`, zoo(R1, M1, R3));
  await save(
    inside,
    `/tasks/${T2.id}/document`,
    "원본 둘의 공유 문서: [사본 셋째 행](/links/report-task/" +
      R1 +
      "/" +
      T3.id +
      ")",
  );
  await save(
    inside,
    `/tasks/${T3.id}/document`,
    "셋째 업무 문서 [사본 메모](/links/report-memo/" + R1 + "/" + M1 + ")",
  );
  ok(
    await inside(`/teams/${teamId}/years/${year}/memos`, {
      id: M1,
      title: "연간 메모",
    }),
  );
  await save(
    inside,
    `/teams/${teamId}/years/${year}/memos/${M1}`,
    `연간 메모 본문 [사본 업무](/links/report-task/${R1}/${T2.id})`,
  );
  ok(
    await inside("/calendar/entries", {
      teamId,
      userId: lead,
      id: E1,
      date: "2026-10-07",
      title: "일정 문서",
    }),
  );
  await save(
    inside,
    `/calendar/entries/${E1}/document`,
    `일정 본문 [사본 메모](/links/report-memo/${R1}/${M1}) 와 [업무](/links/task/${T2.id})`,
  );
  const create = async (send, id, name, extra) =>
    ok(
      await send("/reports", {
        id,
        teamId,
        year,
        name,
        referenceDate: "2026-10-10",
        view,
        taskIds: [T1.id, T2.id, T3.id],
        ...extra,
      }),
    );
  await create(inside, R1, "첫 사본");
  const read = async (send, id) => ok(await send(`/reports/${id}`));
  const edit = async (send, id, operations) => {
    const current = await read(send, id);
    return ok(
      await send(
        `/reports/${id}`,
        { operationId: randomUUID(), revision: current.revision, operations },
        "PATCH",
      ),
    );
  };
  const at = () => new Date().toISOString();
  const cellOp = (taskId, key, value) => ({
    kind: "cells",
    at: at(),
    changes: [{ taskId, key, expectedVersion: 0, value }],
  });
  await edit(inside, R1, [cellOp(T1.id, "title", "사본에서 바꾼 제목")]);
  await edit(inside, R1, [
    {
      kind: "create",
      at: at(),
      taskId: T4,
      fields: { title: "사본에서 추가한 행" },
    },
  ]);
  await save(
    inside,
    `/reports/${R1}/tasks/${T1.id}/document`,
    `사본에서 고친 문서 [다음 사본 메모](/links/report-memo/${R2}/${M1}) [자기](/links/report-task/${R1}/${T4})`,
  );
  await save(
    inside,
    `/reports/${R1}/memos/${M1}`,
    `사본 메모 본문 [원본 메모](/links/memo/${teamId}/${year}/${M1}) [사본 업무](/links/report-task/${R1}/${T4})`,
  );
  // Deleting a row keeps its documents in the history; restoring one brings
  // them back. T3 is restored now, T2 stays deleted for the new release.
  await edit(inside, R1, [{ kind: "delete", at: at(), taskIds: [T3.id] }]);
  const history = async (send, sheetId) =>
    ok(await send(`/audit?teamId=${teamId}&sheetId=${sheetId}&limit=200`));
  let entries = (await history(inside, R1)).entries;
  const deletion = entries.find(
    (entry) =>
      entry.action === "report-edit" && entry.restorableTaskIds?.length,
  );
  assert.ok(deletion, JSON.stringify(entries.slice(0, 3)));
  ok(
    await inside(`/audit/${deletion.id}/restore`, {
      revision: (await read(inside, R1)).revision,
    }),
  );
  await edit(inside, R1, [{ kind: "delete", at: at(), taskIds: [T2.id] }]);
  ok(
    await inside(
      `/reports/${R1}/name`,
      { name: "첫 사본 이름 변경", expectedName: "첫 사본" },
      "PATCH",
    ),
  );
  await create(inside, R2, "다시 복사한 사본", { sourceId: R1, taskIds: [] });
  await create(inside, R3, "삭제할 사본", { taskIds: [T1.id] });
  ok(await inside("/reports", { teamId, ids: [R3] }, "DELETE"));
  ok(
    await inside(`/teams/${teamId}/years/${year}/memos`, {
      id: M2,
      title: "두 번째 메모",
    }),
  );
  await save(
    inside,
    `/teams/${teamId}/years/${year}/memos/${M2}`,
    `두 번째 메모 [다시 복사한 사본 메모](/links/report-memo/${R2}/${M1})`,
  );
  // XLSX imports: a new copy (mode report) and rows added to a copy (copy).
  const workbook = new ExcelJS.Workbook(),
    sheet = workbook.addWorksheet("가져온 시트");
  sheet.addRow(["작업", "2026-10-05"]);
  sheet.addRow(["엑셀 업무", "엑셀 일정"]);
  const xlsx = await workbook.xlsx.writeBuffer();
  const preview = async (send, sheetCloneId) => {
    const body = new FormData();
    body.set("teamId", teamId);
    body.set("year", String(year));
    if (sheetCloneId) body.set("reportId", sheetCloneId);
    body.set("file", new Blob([xlsx]), "fixture.xlsx");
    return ok(await send("/import/preview", body));
  };
  const asReport = await preview(inside);
  const reportImport = ok(
    await inside(`/import/${asReport.id}/apply`, {
      sheet: sheet.name,
      year,
      mode: "report",
      referenceDate: "2026-10-11",
      acceptWarnings: true,
      personMap: {},
    }),
  );
  assert.equal(reportImport.mode, "report");
  const asCopy = await preview(inside, R2);
  const copyImport = ok(
    await inside(`/import/${asCopy.id}/apply`, {
      sheet: sheet.name,
      year,
      mode: "copy",
      reportId: R2,
      revision: (await read(inside, R2)).revision,
      referenceDate: "2026-10-11",
      acceptWarnings: true,
      personMap: {},
    }),
  );
  assert.equal(copyImport.mode, "copy");
  log("internal data ready");

  // Connect: genesis v1, checkpoint, external import.
  ok(
    await inside(
      `/admin/teams/${teamId}/connection`,
      { profileId: "inside", expectedRevision: 0 },
      "PUT",
    ),
  );
  ok(await inside(`/teams/${teamId}/sync/enable`, {}));
  await internalRun();
  ok(await inside(`/teams/${teamId}/sync/checkpoint`, {}));
  ok(
    await outside("/auth/setup", {
      name: "외부 관리자",
      setupToken: env.SETUP_TOKEN,
    }),
  );
  const imported = ok(
    await outside("/admin/sync/import", { teamId, profileId: "outside" }),
  );
  assert.equal(imported.phase, "complete");
  await flush();
  await converge();
  log("external imported");

  // v1 commands from both sites, including a copy created outside.
  const R5 = randomUUID();
  await create(outside, R5, "외부에서 만든 사본", { taskIds: [T1.id] });
  await edit(outside, R1, [cellOp(T4, "2026-10-19", "외부 사본 셀")]);
  await save(
    outside,
    `/reports/${R5}/tasks/${T1.id}/document`,
    `외부 사본 문서 [첫 사본](/links/report-task/${R1}/${T1.id})`,
  );
  await converge();
  // Settles conflicts one at a time on the external site, which holds the
  // later command, re-reading the list after each resolution.
  const resolveAll = async (choice) => {
    let resolved = 0;
    for (let i = 0; i < 10; i++) {
      const listed = ok(await outside(`/teams/${teamId}/sync/conflicts`));
      const open = listed.conflicts.filter(
        (c) => !c.resolved && !c.pendingResolution,
      );
      if (!open.length) break;
      const conflict = open[0];
      ok(
        await outside(
          `/teams/${teamId}/sync/conflicts/${conflict.conflictId}/resolve`,
          {
            expectedHead: conflict.expectedHead,
            frontier: conflict.frontier,
            choice,
          },
        ),
      );
      resolved++;
      await converge();
    }
    return resolved;
  };
  // A v1 copy is one unit: both sites editing it collide and the later one
  // is kept as a conflict, which is then resolved.
  const conflictV1 = async () => {
    ok(await outside(`/teams/${teamId}/sync/pause`, {}));
    await edit(inside, R2, [cellOp(T1.id, "title", "사내에서 먼저")]);
    await internalRun();
    await edit(outside, R2, [cellOp(T1.id, "title", "외부에서 나중")]);
    ok(await outside(`/teams/${teamId}/sync/resume`, {}));
    await converge();
    assert.ok(await resolveAll("current"), "expected a v1 copy conflict");
  };
  await conflictV1();
  log("v1 commands and conflict ready");

  const pause = async () => {
    ok(await outside(`/teams/${teamId}/sync/pause`, {}));
    ok(await inside(`/teams/${teamId}/sync/pause`, {}));
    await flush();
    const a = ok(await inside(`/teams/${teamId}/sync`)),
      b = ok(await outside(`/teams/${teamId}/sync`));
    return { internal: a, external: b };
  };
  const drained = async () => {
    const status = await pause();
    for (const site of [status.internal, status.external]) {
      assert.equal(site.mode, "paused", JSON.stringify(site));
      assert.equal(site.pending, 0, JSON.stringify(site));
      assert.equal(site.conflicts, 0, JSON.stringify(site));
    }
    assert.equal(status.internal.canonicalHead, status.external.canonicalHead);
    const internalState = app.locals.sync.store(teamId).readState();
    return {
      head: status.internal.canonicalHead,
      hash: stateHash(internalState),
      sum: stateSum(internalState),
      protocol: protocolVersion(internalState),
      externalHash: status.external.canonicalHash,
      internalHash: status.internal.canonicalHash,
    };
  };
  const resume = async () => {
    ok(await inside(`/teams/${teamId}/sync/resume`, {}));
    ok(await outside(`/teams/${teamId}/sync/resume`, {}));
    await converge();
  };

  mkdirSync(out, { recursive: true });
  const dumpSqlite = (name) => {
    const copy = join(work, name + ".sqlite");
    db.exec(`VACUUM INTO '${copy}'`);
    const sql = execFileSync("sqlite3", [copy, ".dump"], {
      maxBuffer: 256 * 1024 * 1024,
    }).toString();
    const version = execFileSync("sqlite3", [copy, "PRAGMA user_version"])
      .toString()
      .trim();
    writeFileSync(
      join(out, name + ".sql"),
      `-- Generated by generate-f744ead.mjs from f744ead; PRAGMA user_version=${version}\n` +
        sql +
        `PRAGMA user_version=${version};\n`,
    );
  };
  const dumpPostgres = (database, schema, name) => {
    const text = pg("pg_dump", [
      "--host",
      socket,
      "--port",
      String(port),
      "--username",
      "postgres",
      "--no-owner",
      "--no-privileges",
      "--inserts",
      "--schema",
      schema,
      database,
    ])
      .split("\n")
      .filter((line) => !line.startsWith("\\"))
      .join("\n")
      .replace(/\n+$/, "\n");
    writeFileSync(join(out, name + ".sql"), text);
  };
  const snapshot = async (label) => {
    const state = await drained();
    dumpSqlite(`internal-${label}`);
    dumpPostgres("team", "graeboard", `external-team-${label}`);
    if (label === "v2")
      dumpPostgres("control", "graeboard", "external-control");
    return state;
  };
  const v1 = await snapshot("v1");
  assert.equal(v1.protocol, 1);
  log("v1 snapshot", v1.head);

  // Explicit v2 transition, external first, as OPERATIONS.md describes.
  const upgrade = {
    expectedHead: v1.head,
    expectedHash: v1.hash,
    peersStopped: true,
  };
  ok(await outside(`/teams/${teamId}/sync/upgrade`, upgrade));
  ok(await inside(`/teams/${teamId}/sync/upgrade`, upgrade));
  await resume();
  // v2 commands: rows and cells of copies are separate entities.
  await edit(inside, R1, [cellOp(T1.id, "2026-10-26", "v2 사내 셀")]);
  await edit(outside, R2, [
    {
      kind: "create",
      at: at(),
      taskId: randomUUID(),
      fields: { title: "v2 외부 행" },
    },
  ]);
  await save(
    outside,
    `/reports/${R2}/memos/${M1}`,
    `v2 외부 사본 메모 [첫 사본 메모](/links/report-memo/${R1}/${M1})`,
  );
  await converge();
  // One cell edited differently on both sites becomes a v2 conflict.
  ok(await outside(`/teams/${teamId}/sync/pause`, {}));
  await edit(inside, R5, [cellOp(T1.id, "title", "v2 사내 제목")]);
  await internalRun();
  await edit(outside, R5, [cellOp(T1.id, "title", "v2 외부 제목")]);
  ok(await outside(`/teams/${teamId}/sync/resume`, {}));
  await converge();
  assert.ok(await resolveAll("submitted"), "expected a v2 cell conflict");
  // A site-local exclusion (L) of a copy's memo on the internal site only;
  // the external site keeps serving it.
  const listing = ok(await inside(`/admin/teams/${teamId}/maintenance`));
  const excluded = listing.documents.find(
    (d) => d.key[0] === "reportMemo" && d.key[1] === R2,
  );
  assert.ok(excluded, JSON.stringify(listing.documents.map((d) => d.key)));
  const previewed = ok(
    await inside(`/admin/teams/${teamId}/maintenance/preview`, {
      kind: "document",
      entity: "document",
      key: excluded.key,
      generation: excluded.generation,
    }),
  );
  const job = ok(
    await inside(`/admin/teams/${teamId}/maintenance/execute`, {
      token: previewed.token,
      confirmed: true,
    }),
  );
  assert.ok(
    db.prepare("SELECT COUNT(*) n FROM site_retention").get().n > 0,
    JSON.stringify(job),
  );
  // A copy deleted after the transition.
  const R4 = (await ok(await inside(`/reports?teamId=${teamId}`))).reports.find(
    (r) => r.name === "가져온 시트",
  )?.id;
  assert.ok(R4, "imported copy");
  ok(await inside("/reports", { teamId, ids: [R4] }, "DELETE"));
  await converge();
  const v2 = await snapshot("v2");
  assert.equal(v2.protocol, 2);
  log("v2 snapshot", v2.head);

  // What the released code answers for the same data (old field names).
  const expected = { internal: {}, external: {} };
  for (const [site, send] of [
    ["internal", inside],
    ["external", outside],
  ]) {
    const result = (expected[site] = {});
    result.list = ok(await send(`/reports?teamId=${teamId}`)).reports;
    result.reports = {};
    for (const { id } of result.list) {
      const report = await read(send, id);
      const documents = {};
      for (const t of report.tasks)
        if (t.documentCount)
          documents[t.id] = ok(
            await send(`/reports/${id}/tasks/${t.id}/documents?content=1`),
          );
      result.reports[id] = {
        report,
        documents,
        memos: ok(await send(`/reports/${id}/memos?content=1`)),
      };
    }
    result.tasks = {};
    for (const t of [T1, T2, T3])
      result.tasks[t.id] = ok(await send(`/tasks/${t.id}/documents?content=1`));
    result.memos = ok(
      await send(`/teams/${teamId}/years/${year}/memos?content=1`),
    );
    result.calendar = ok(await send(`/calendar/entries/${E1}/document`));
    const paths = [
      `/links/report-task/${R1}/${T1.id}`,
      `/links/report-task/${R1}/${T4}`,
      `/links/report-memo/${R1}/${M1}`,
      `/links/report-memo/${R2}/${M1}`,
      `/links/report-task/${R3}/${T1.id}`,
      `/links/task/${T1.id}`,
    ];
    result.links = ok(
      await send(
        `/document-links?${new URLSearchParams({ links: paths.join(",") })}`,
      ),
    ).links;
    result.history = {};
    for (const sheetId of ["original", R1, R2])
      result.history[sheetId] = (await history(send, sheetId)).entries;
  }
  const exported = await inside("/export", {
    teamId,
    year,
    format: "json",
    scope: "all",
    startMonth: 1,
  });
  if (exported.status === 200)
    writeFileSync(
      join(out, "export-v6.json"),
      JSON.stringify(exported.data, null, 2) + "\n",
    );
  else log("json export skipped", exported.status, exported.data);

  execFileSync("git", [
    "-C",
    remote,
    "bundle",
    "create",
    join(out, "sync.bundle"),
    "--all",
  ]);
  const imageFile = imageUrl.replace("/api/document-images/", "");
  mkdirSync(join(out, "images", teamId), { recursive: true });
  cpSync(join(imagesDir, imageFile), join(out, "images", imageFile));
  writeFileSync(
    join(out, "manifest.json"),
    JSON.stringify(
      {
        generatedFrom: "f744ead39cead92ccdeff8e3efbf08067891ae80",
        generatedAt: new Date().toISOString(),
        versions: {
          sqlite: 33,
          postgresTeam: 2,
          postgresControl: 2,
          export: 6,
        },
        origins: { internal: INTERNAL_ORIGIN, external: EXTERNAL_ORIGIN },
        teamId,
        users: { lead, member },
        installations: {
          internal: internalInstallation,
          external: externalInstallation,
        },
        profiles: { internal: "inside", external: "outside" },
        repository: "fixture/team",
        tasks: { T1: T1.id, T2: T2.id, T3: T3.id, T4 },
        copies: { R1, R2, R3, R4, R5 },
        memos: { M1, M2 },
        calendar: { E1 },
        excludedInternally: excluded.key,
        image: imageUrl,
        imports: { report: asReport.id, copy: asCopy.id, sheet: sheet.name },
        sync: { v1, v2 },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(out, "expected-f744ead.json"),
    JSON.stringify(expected, null, 2) + "\n",
  );
  log("done", out);
} finally {
  globalThis.fetch = nativeFetch;
  server?.close();
  db?.close();
  for (const pool of pools) await pool.end().catch(() => {});
  if (pgStarted)
    spawnSync(join(pgBin, "pg_ctl"), ["-D", pgData, "-m", "immediate", "stop"]);
  rmSync(work, { recursive: true, force: true });
}
