import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  encodeSnapshot,
  decodeSnapshot,
  encodeStoredSnapshot,
  decodeStoredSnapshot,
} from "../../../server/sync/core/snapshot.mjs";
import { decodeBoundedSnapshot } from "../../../worker/storage/capacity.mjs";
import {
  SYNC_SNAPSHOT_MAX_BYTES,
  SYNC_NODE_SNAPSHOT_MAX_DECODED_BYTES,
} from "../../../shared/sync/sync-limits.js";

test("Node/operator snapshots above 64 MiB round-trip without raising the hosted budget", () => {
  const value = { text: "a".repeat(SYNC_SNAPSHOT_MAX_BYTES) },
    options = { maxDecodedBytes: SYNC_NODE_SNAPSHOT_MAX_DECODED_BYTES };
  assert.throws(() => encodeSnapshot(value), /uncompressed byte budget/);
  const bytes = encodeSnapshot(value, options);
  assert.ok(bytes.byteLength < SYNC_SNAPSHOT_MAX_BYTES);
  assert.throws(() => decodeSnapshot(bytes));
  assert.throws(
    () => decodeBoundedSnapshot(bytes),
    (e) => e.code === "EXTERNAL_SYNC_CAPACITY",
  );
  assert.equal(decodeSnapshot(bytes, options).text, value.text);
  assert.equal(
    decodeBoundedSnapshot(bytes, undefined, options.maxDecodedBytes).text,
    value.text,
  );
  assert.equal(
    decodeStoredSnapshot(encodeStoredSnapshot(value, options), options).text,
    value.text,
  );
});

test("decoded and Git object budgets remain enforced for opted-in readers", () => {
  const bytes = gzipSync(JSON.stringify({ text: "a".repeat(4096) })),
    options = { maxDecodedBytes: 1024 };
  assert.throws(() => decodeSnapshot(bytes, options));
  assert.throws(
    () => decodeBoundedSnapshot(bytes, undefined, 1024),
    (e) => e.code === "EXTERNAL_SYNC_CAPACITY",
  );
  const oversized = { byteLength: SYNC_SNAPSHOT_MAX_BYTES + 1 };
  assert.throws(
    () =>
      decodeSnapshot(oversized, {
        maxDecodedBytes: SYNC_NODE_SNAPSHOT_MAX_DECODED_BYTES,
      }),
    /byte budget/,
  );
  assert.throws(
    () =>
      decodeBoundedSnapshot(
        oversized,
        undefined,
        SYNC_NODE_SNAPSHOT_MAX_DECODED_BYTES,
      ),
    (e) => e.code === "EXTERNAL_SYNC_CAPACITY",
  );
});
