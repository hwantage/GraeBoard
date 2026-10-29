import test from "node:test";
import assert from "node:assert/strict";
import { upgradeArguments, runUpgrade } from "../scripts/sync-upgrade.mjs";
const team = "11111111-1111-4111-8111-111111111111";
const base = ["--url", "http://127.0.0.1:4311", "--team", team];
test("protocol upgrade preview cannot issue a write, and execution requires exact state and peer-stop confirmation", async () => {
  for (const args of [
    ["--execute"],
    ["--execute", "--peers-stopped"],
    ["--execut"],
  ])
    assert.throws(() => upgradeArguments([...base, ...args]));
  const calls = [],
    fetchImpl = async (url, request) => {
      calls.push({ url, ...request });
      return Response.json({
        mode: "paused",
        protocol: 1,
        canonicalHead: "a".repeat(40),
        canonicalHash: "b".repeat(64),
        pending: 0,
        conflicts: 0,
      });
    };
  await runUpgrade(upgradeArguments(base), {
    fetchImpl,
    cookie: "test-cookie",
  });
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);
  await runUpgrade(
    upgradeArguments([
      ...base,
      "--execute",
      "--peers-stopped",
      "--expected-head",
      "a".repeat(40),
      "--expected-hash",
      "b".repeat(64),
    ]),
    { fetchImpl, cookie: "test-cookie" },
  );
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1].body), {
    expectedHead: "a".repeat(40),
    expectedHash: "b".repeat(64),
    peersStopped: true,
  });
});
