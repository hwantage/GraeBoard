import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  sqliteBusinessFixture,
  postgresBusinessFixture,
} from "../support/business-storage-fixture.mjs";
import { createExternalRouteApp } from "../support/external-route-fixture.mjs";
import { unpack } from "../../shared/formatting/compact.js";
import { defaultView } from "../../shared/domain.js";
import { backupDatabase } from "../../scripts/transfer/backup.mjs";
import { backupExternal } from "../../server/storage/transfer/external-backup.mjs";

const config = {
  workColors: [{ color: "#ABC", name: "Work" }],
  deadlinePropertyId: "removedDeadline",
  charts: [
    {
      id: "c123abc",
      title: "Archived reference",
      type: "table",
      dimensions: { row: { kind: "property", propertyId: "removedOption" } },
      values: [{ kind: "numberSum", propertyId: "removedNumber" }],
      filter: { propertyFilters: { removedFilter: ["old"] } },
    },
  ],
};
const normalized = {
  ...config,
  workColors: [{ color: "#aabbcc", name: "Work" }],
};
function seedUser(f, role) {
  const id = randomUUID(),
    stamp = new Date().toISOString();
  f.db
    .prepare(
      "INSERT INTO users(id,username,name,password,system_role,created_at) VALUES(?,?,?,'!','user',?)",
    )
    .run(id, `${id}@example.test`, role, stamp);
  f.db.prepare("INSERT INTO memberships VALUES(?,?,?)").run(id, f.teamId, role);
  f.db
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(
      createHash("sha256").update(id).digest("hex"),
      id,
      Date.now() + 600000,
    );
  return id;
}
async function start(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (app.close) await app.close();
  });
  return `http://127.0.0.1:${server.address().port}/api`;
}
function requestAt(base, defaultId) {
  return async (path, body, method = body ? "POST" : "GET", id = defaultId) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        Cookie: "weekly_session=" + id,
        "X-Requested-With": "WeeklyPlan",
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: unpack(await response.json()) };
  };
}
const ok = (response) => {
  assert.ok(
    response.status >= 200 && response.status < 300,
    JSON.stringify(response),
  );
  return response.data;
};
async function contract(t, f, request, ids) {
  const path = `/teams/${f.teamId}/settings`,
    read = async (id) =>
      ok(await request("/bootstrap", null, "GET", id)).teams.find(
        (team) => team.id === f.teamId,
      ).settings;
  let current = await read(ids.lead);
  await t.test(
    "lead saves through actual HTTP; members/viewers read but cannot save; invalid inputs are rejected atomically",
    async () => {
      const saved = ok(
        await request(
          path,
          { revision: current.revision || 0, insights: config },
          "PATCH",
          ids.lead,
        ),
      ).settings;
      assert.deepEqual(saved.insights, normalized);
      for (const id of [ids.member, ids.viewer]) {
        assert.deepEqual((await read(id)).insights, normalized);
        assert.equal(
          (
            await request(
              path,
              { revision: saved.revision, insights: config },
              "PATCH",
              id,
            )
          ).status,
          403,
        );
      }
      for (const invalid of [
        { ...config, unexpected: true },
        { ...config, charts: [{ ...config.charts[0], id: "cBAD" }] },
        { ...config, workColors: Array(21).fill({ color: "#ffffff" }) },
      ])
        assert.equal(
          (
            await request(
              path,
              { revision: saved.revision, insights: invalid },
              "PATCH",
              ids.lead,
            )
          ).status,
          400,
        );
      assert.deepEqual((await read()).insights, normalized);
      assert.equal((await read()).revision, saved.revision);
      assert.equal(
        (
          await request(
            path,
            {
              revision: current.revision || 0,
              insights: { ...config, charts: [] },
            },
            "PATCH",
            ids.lead,
          )
        ).status,
        409,
      );
      current = saved;
    },
  );
  await t.test(
    "omitted insights survives property/style/theme saves and system-admin edits; archived or absent references never block",
    async () => {
      current = ok(
        await request(
          path,
          {
            revision: current.revision,
            properties: current.properties.map((p) =>
              p.id === "description" ? { ...p, archived: true } : p,
            ),
          },
          "PATCH",
          ids.lead,
        ),
      ).settings;
      current = ok(
        await request(
          path,
          {
            revision: current.revision,
            defaultStyle: { backgroundColor: "#ffffff", fontSize: 10 },
          },
          "PATCH",
          ids.lead,
        ),
      ).settings;
      assert.deepEqual(current.insights, normalized);
      ok(
        await request(
          `/teams/${f.teamId}`,
          {
            name: "Insights contract",
            theme: "rose",
            settingsRevision: current.revision,
          },
          "PATCH",
          ids.lead,
        ),
      );
      current = await read();
      assert.deepEqual(current.insights, normalized);
      current = ok(
        await request(
          path,
          { revision: current.revision, defaultDensity: "dense" },
          "PATCH",
          f.user.id,
        ),
      ).settings;
      assert.deepEqual(current.insights, normalized);
    },
  );
  await t.test(
    "actual annual GET returns other-year cells; snapshots exclude insights; JSON v7 export includes insights",
    async () => {
      const before = ok(
        await request(`/tasks?teamId=${f.teamId}&year=2026`),
      ).tasks.find((task) => task.id === f.taskId);
      ok(
        await request("/cells/batch", {
          operationId: randomUUID(),
          createdAt: new Date().toISOString(),
          changes: [
            {
              taskId: f.taskId,
              key: "2027-02-01",
              value: "future",
              style: { backgroundColor: "#aabbcc" },
              expectedVersion: 0,
              expectedFormatRevision: before.formatting?.revision || 0,
            },
          ],
        }),
      );
      const tasks = ok(
        await request(`/tasks?teamId=${f.teamId}&year=2026`),
      ).tasks;
      assert.equal(
        tasks.find((task) => task.id === f.taskId).cells["2027-02-01"].value,
        "future",
      );
      const copy = ok(
        await request("/sheet-clones", {
          id: randomUUID(),
          teamId: f.teamId,
          year: 2026,
          referenceDate: "2026-11-09",
          name: "Insights snapshot",
          taskIds: [f.taskId],
          view: defaultView(2026),
        }),
      );
      assert.equal(
        ok(await request(`/sheet-clones/${copy.id}`)).settings.insights,
        undefined,
      );
      const exported = ok(
        await request("/export", {
          teamId: f.teamId,
          year: 2026,
          format: "json",
          scope: "all",
        }),
      );
      assert.equal(exported.schemaVersion, 7);
      assert.deepEqual(exported.team.settings.insights, normalized);
    },
  );
  return normalized;
}
test("insights settings contract on SQLite routes and real backup", async (t) => {
  const f = sqliteBusinessFixture(t),
    ids = {
      lead: seedUser(f, "lead"),
      member: seedUser(f, "member"),
      viewer: seedUser(f, "viewer"),
    };
  const base = await start(t, f.app);
  await contract(t, f, requestAt(base, f.user.id), ids);
  const backup = join(f.dir, "insights-backup.sqlite");
  backupDatabase(join(f.dir, "data.sqlite"), backup, {
    documentImagesDir: join(f.dir, "images"),
  });
  const restored = new DatabaseSync(backup, { readOnly: true });
  try {
    assert.deepEqual(
      unpack(
        JSON.parse(
          restored
            .prepare("SELECT settings FROM teams WHERE id=?")
            .get(f.teamId).settings,
        ),
      ).insights,
      normalized,
    );
    assert.equal(
      restored.prepare("PRAGMA user_version").get().user_version,
      34,
    );
    assert.equal(
      restored.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
  } finally {
    restored.close();
  }
});
test("insights settings contract on actual external PostgreSQL routes and backup", async (t) => {
  assert.ok(
    process.env.TEST_PG_BIN,
    "TEST_PG_BIN is required; PostgreSQL coverage must not silently skip",
  );
  const f = sqliteBusinessFixture(t),
    ids = {
      lead: seedUser(f, "lead"),
      member: seedUser(f, "member"),
      viewer: seedUser(f, "viewer"),
    },
    pg = await postgresBusinessFixture(t, f);
  assert.ok(pg, "actual PostgreSQL fixture is required");
  for (const [role, id] of Object.entries(ids)) {
    await pg.control.query(
      "INSERT INTO graeboard.users(id,username,email,name,system_role,created_at) VALUES($1,$2,$2,$3,'user',$4)",
      [id, `${id}@example.test`, role, new Date().toISOString()],
    );
    await pg.control.query(
      "INSERT INTO graeboard.memberships VALUES($1,$2,$3)",
      [id, f.teamId, role],
    );
  }
  const app = createExternalRouteApp({ env: pg.env, defaultUserId: f.user.id }),
    base = await start(t, app);
  await contract(t, f, requestAt(base, f.user.id), ids);
  const destination = join(f.dir, "pg-insights-backup");
  await backupExternal({
    control: null,
    teams: [
      {
        adapter: pg.adapter,
        teamId: f.teamId,
        images: { list: async () => [], read: async () => null },
      },
    ],
    destination,
  });
  const bundle = JSON.parse(
    readFileSync(join(destination, f.teamId, "team.json"), "utf8"),
  );
  const row = bundle.payload.tables.site_entities.find(
    (row) => row.entity === "team",
  );
  assert.deepEqual(JSON.parse(row.payload).settings.insights, normalized);
  assert.equal(f.db.prepare("PRAGMA user_version").get().user_version, 34);
});
