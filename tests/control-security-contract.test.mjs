import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { ControlBusinessService } from "../server/storage/control-service.mjs";
import { PostgresControlRepository } from "../server/storage/postgres-control.mjs";
import {
  sqliteBusinessFixture,
  postgresBusinessFixture,
} from "./business-storage-fixture.mjs";

test("actual PG control validates account types before writes and exposes only public member-picker profiles", async (t) => {
  const f = sqliteBusinessFixture(t),
    pg = await postgresBusinessFixture(t, f);
  if (!pg) return;
  const context = pg.createContext(),
    service = new ControlBusinessService(
      new PostgresControlRepository({ context }),
      f.user,
    );
  const revision = async () =>
    (
      await pg.control.query(
        "SELECT revision FROM graeboard.control_meta WHERE singleton=1",
      )
    ).rows[0].revision;
  const before = await revision();
  for (const invalid of [
    { active: "false" },
    { active: 0 },
    { active: null },
    { systemRole: 0 },
    { name: 123 },
    { name: "x".repeat(51) },
    { username: "not-an-email" },
    { memberships: [{ teamId: "not-a-uuid", role: "lead" }] },
  ]) {
    await assert.rejects(
      Promise.resolve().then(() =>
        service.execute("updateUser", invalid, f.user.id),
      ),
      (e) => e instanceof ZodError,
      JSON.stringify(invalid),
    );
  }
  await assert.rejects(
    service.execute("updateUser", { active: false }, f.user.id),
    (e) => e.status === 400,
    "valid false still invokes the sole-admin protection",
  );
  assert.equal(
    Number(
      (
        await pg.control.query(
          "SELECT count(*) n FROM graeboard.users WHERE active=TRUE AND system_role='admin'",
        )
      ).rows[0].n,
    ),
    1,
  );
  assert.equal(
    await revision(),
    before,
    "all rejected updates roll back revision and admin state",
  );
  const outsideTeam = randomUUID();
  await pg.control.query(
    "INSERT INTO graeboard.teams(id,name) VALUES($1,'Unrelated private team')",
    [outsideTeam],
  );
  const invited = await service.execute("createUser", {
    username: "outside-lead@example.test",
    name: "Outside lead",
    memberships: [{ teamId: outsideTeam, role: "lead" }],
  });
  assert.ok(invited.user.id, "Access accounts do not require local passwords");
  const lead = { ...f.user, systemRole: "user" },
    leadContext = pg.createContext(lead),
    leadService = new ControlBusinessService(
      new PostgresControlRepository({ context: leadContext }),
      lead,
    );
  const publicFields = [
    "id",
    "username",
    "name",
    "active",
    "color",
    "avatarInitials",
    "avatarImage",
  ].sort();
  let picker = await leadService.execute("members", {}, f.teamId),
    visible = picker.users.find((user) => user.id === invited.user.id);
  assert.deepEqual(Object.keys(visible).sort(), publicFields);
  assert.equal(JSON.stringify(visible).includes(outsideTeam), false);
  await pg.control.query(
    "UPDATE graeboard.users SET active=FALSE WHERE id=$1",
    [invited.user.id],
  );
  picker = await leadService.execute("members", {}, f.teamId);
  visible = picker.users.find((user) => user.id === invited.user.id);
  assert.equal(
    visible.active,
    false,
    "inactive accounts remain identifiable just as in the SQLite picker",
  );
  assert.deepEqual(Object.keys(visible).sort(), publicFields);
});
