import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { publishDirectory } from "../server/sync/directory.mjs";
import { publishSetupJson } from "../server/sync/setup-keys.mjs";
import { SyncService } from "../server/sync/service.mjs";
import { GitCliTransport } from "../server/sync/git-cli.mjs";

function repository() {
  const heads = new Map(),
    files = new Map(),
    calls = [];
  return {
    heads,
    calls,
    async readHead(branch) {
      calls.push("head " + branch);
      return heads.get(branch) || null;
    },
    async readFile(oid, path) {
      calls.push("file " + path);
      return Buffer.from(files.get(oid)[path]);
    },
    async createCandidate(parent, value) {
      const oid = String(files.size + 1).padStart(40, "0");
      calls.push("candidate");
      files.set(oid, value);
      return oid;
    },
    async publish(oid, parent, branch) {
      calls.push("publish " + branch);
      if ((heads.get(branch) || null) !== parent) return false;
      heads.set(branch, oid);
      return true;
    },
  };
}
test("unchanged status, directory and setup branches make no remote calls during idle windows and changed data publishes immediately", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1700000000000 });
  const repo = repository();
  const identity = {
    teamId: randomUUID(),
    repoId: randomUUID(),
    installationId: randomUUID(),
  };
  const directory = {
    ...identity,
    format: "graeboard-team-directory",
    version: 1,
    members: [],
  };
  const keys = {
    ...identity,
    format: "graeboard-setup-keys",
    version: 1,
    keys: [],
  };
  const link = {
    canonical_head: "a".repeat(40),
    installation_id: identity.installationId,
    writer_epoch: "epoch",
    mode: "active",
  };
  const service = new SyncService({
    transport: repo,
    identity: { teamId: identity.teamId, repoId: identity.repoId },
    store: {},
  });
  const publish = async () => {
    await service.status(link);
    await publishDirectory(repo, directory);
    await publishSetupJson(
      repo,
      "sync-setup/" + identity.installationId,
      "keys.json",
      keys,
    );
  };
  await publish();
  const before = repo.calls.length;
  t.mock.timers.tick(15000);
  await publish();
  await publish();
  assert.equal(
    repo.calls.length,
    before,
    "three publishers previously did six or more idle remote reads",
  );
  directory.members.push({
    id: randomUUID(),
    name: "Member",
    email: "member@example.test",
    role: "member",
    active: true,
  });
  await publishDirectory(repo, directory);
  assert.equal(
    repo.calls.filter((call) => call.startsWith("publish sync-directory/"))
      .length,
    2,
  );
  t.mock.timers.tick(60000);
  const reread = repo.calls.length;
  await publish();
  assert.ok(
    repo.calls.length > reread,
    "expired cache revalidates each advisory branch",
  );
  assert.equal(
    repo.calls.filter((call) => call.startsWith("publish sync-status/")).length,
    2,
    "liveness heartbeat remains fresh",
  );
});
test("advisory CAS retries from the latest parent and a failed publication never populates the idle cache", async () => {
  const repo = repository(),
    value = { id: "fixture", keys: [] },
    publish = repo.publish.bind(repo);
  repo.publish = async () => false;
  await assert.rejects(
    publishSetupJson(repo, "sync-setup/site", "keys.json", value),
    (error) => error.status === 409,
  );
  assert.equal(repo.calls.filter((call) => call === "candidate").length, 3);
  repo.publish = publish;
  assert.equal(
    await publishSetupJson(repo, "sync-setup/site", "keys.json", value),
    "4".padStart(40, "0"),
  );
  const count = repo.calls.length;
  await publishSetupJson(repo, "sync-setup/site", "keys.json", value);
  assert.equal(repo.calls.length, count);
});
test("Git CLI ancestry only accepts full object IDs before constructing Git arguments", async () => {
  const transport = new GitCliTransport({
    directory: "/unused",
    repository: "fixture/team",
  });
  let calls = 0;
  transport.git = async () => {
    calls++;
  };
  for (const value of [
    ":/pattern",
    "--all",
    "HEAD",
    "a".repeat(39),
    "A".repeat(40),
    3,
  ])
    await assert.rejects(
      transport.verifyReachable("a".repeat(40), value),
      (error) => error.code === "SYNC_FORMAT",
    );
  assert.equal(calls, 0);
  assert.equal(
    await transport.verifyReachable("a".repeat(40), "b".repeat(40)),
    true,
  );
  assert.equal(calls, 1);
});
