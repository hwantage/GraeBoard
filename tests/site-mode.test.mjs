import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createWorker } from "../worker/entry.mjs";

test("Node refuses external or invalid deployment mode before opening a database", () => {
  const dir = mkdtempSync(join(tmpdir(), "gb-site-mode-"));
  try {
    for (const mode of ["external", "invalid", ""]) {
      const path = join(dir, "app.sqlite");
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import assert from 'node:assert/strict';
        import { createApp } from './server/app.mjs';
        assert.throws(() => createApp(), /GRAEBOARD_SITE.*internal/);
      `,
        ],
        {
          env: {
            ...process.env,
            GRAEBOARD_SITE: mode,
            NODE_ENV: "production",
            DB_PATH: path,
            DOCUMENT_IMAGES_DIR: join(dir, "images"),
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(path), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Worker enforces external mode for HTTP and cron; browser input cannot change the deployment role", async () => {
  let verified = 0,
    assets = 0,
    scheduled = 0;
  const worker = createWorker({
    verify: async () => {
      verified++;
      return {};
    },
    scheduled: async () => {
      scheduled++;
    },
    onError() {},
  });
  const env = {
    APP_ORIGIN: "https://board.example.com",
    ASSETS: {
      fetch: async () => {
        assets++;
        return new Response("app");
      },
    },
  };
  for (const GRAEBOARD_SITE of ["internal", "invalid", ""]) {
    assert.equal(
      (
        await worker.fetch(new Request(env.APP_ORIGIN), {
          ...env,
          GRAEBOARD_SITE,
        })
      ).status,
      503,
    );
    await assert.rejects(
      worker.scheduled({}, { ...env, GRAEBOARD_SITE }, { waitUntil() {} }),
      /GRAEBOARD_SITE.*external/,
    );
  }
  assert.deepEqual([verified, assets, scheduled], [0, 0, 0]);
  for (const vars of [
    {},
    { GRAEBOARD_SITE: "external", NODE_ENV: "development" },
  ]) {
    const response = await worker.fetch(
      new Request(env.APP_ORIGIN + "?site=internal", {
        headers: { GRAEBOARD_SITE: "internal" },
      }),
      { ...env, ...vars },
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "app");
  }
  assert.deepEqual([verified, assets], [2, 2]);
});
