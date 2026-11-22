import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../server/app.mjs";
import { openDatabase } from "../../server/db.mjs";
import { createGateway } from "../../worker/gateway.mjs";
import {
  SLIDE_EDITOR_POLICY,
  slideEditorRequest,
} from "../../shared/slides/slide-editor-policy.js";
import { MAX_SLIDE_FILE_BYTES } from "../../shared/slides/slide-file-rules.js";

const buildId = "0de6fc3b40a8-1d25ad0d063a";
const appPage = "<!doctype html><title>GraeBoard</title>";

test("사내 서버는 편집기 빌드를 동일 출처 프레임용 정책으로 제공하고 없는 자산은 404로 답한다", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slide-editor-"));
  const editor = join(directory, "editor");
  const dist = join(directory, "dist");
  mkdirSync(join(editor, buildId, "assets"), { recursive: true });
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), appPage);
  writeFileSync(join(editor, "current.json"), JSON.stringify({ buildId }));
  writeFileSync(join(editor, buildId, "index.html"), "<!doctype html>editor");
  writeFileSync(join(editor, buildId, "assets", "index-abc.js"), "export {}");
  const db = openDatabase(join(directory, "team.sqlite"));
  const app = createApp({
    db,
    staticDir: dist,
    rateLimits: false,
    documentImagesDir: join(directory, "images"),
    slideFilesDir: join(directory, "slides"),
    slideEditorDir: editor,
    syncOptions: { setupConfigPath: join(directory, ".env") },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    app.locals.cellEvents.close();
    app.locals.documentEvents.close();
    await new Promise((resolve) => server.close(resolve));
    await app.locals.sync.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const get = (path) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      redirect: "manual",
    });

  const page = await get(`/tools/canvaslide/${buildId}/`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<!doctype html>editor");
  assert.equal(
    page.headers.get("content-security-policy"),
    SLIDE_EDITOR_POLICY,
  );
  assert.match(SLIDE_EDITOR_POLICY, /frame-ancestors 'self'/);
  assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(page.headers.get("cache-control"), "no-cache");
  const asset = await get(`/tools/canvaslide/${buildId}/assets/index-abc.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control"), /immutable/);
  assert.deepEqual(await (await get("/tools/canvaslide/current.json")).json(), {
    buildId,
  });

  for (const path of [
    `/tools/canvaslide/${buildId}/assets/missing.js`,
    `/tools/canvaslide/${buildId}/examples/none.canvaslide`,
    `/tools/canvaslide/${buildId}`,
    "/tools/canvaslide/",
    "/tools/canvaslide/other.json",
    "/tools/canvaslide/ffffffffffff-ffffffffffff/",
    `/tools/canvaslide/${buildId}/../current.json`,
    "/tools/canvaslide/..%2f..%2fteam.sqlite",
  ]) {
    const response = await get(path);
    const body = await response.text();
    assert.notEqual(body, appPage, path);
    if (path.includes("..")) continue;
    assert.equal(response.status, 404, path);
    assert.equal(body, "Not found", path);
  }

  // GraeBoard's own pages may frame the editor and its blob downloads, and
  // still refuse to be framed themselves.
  const app_ = await get("/slides");
  assert.equal(await app_.text(), appPage);
  const policy = app_.headers.get("content-security-policy");
  assert.match(policy, /frame-src 'self' blob:/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /script-src 'self'(;|$)/);
});

test("편집기 경로 판정", () => {
  assert.equal(slideEditorRequest("/slides"), null);
  assert.equal(slideEditorRequest("/tools/canvaslidex"), null);
  assert.deepEqual(slideEditorRequest(`/tools/canvaslide/${buildId}/`), {
    buildId,
    document: true,
    immutable: false,
  });
  assert.equal(
    slideEditorRequest(`/tools/canvaslide/${buildId}/assets/a.js`).immutable,
    true,
  );
  for (const path of [
    "/tools/canvaslide",
    "/tools/canvaslide/",
    `/tools/canvaslide/${buildId}`,
    "/tools/canvaslide/latest/",
  ])
    assert.equal(slideEditorRequest(path).invalid, true, path);
});

test("외부 gateway도 같은 정책으로 편집기를 제공하고 앱 화면으로 대체하지 않는다", async () => {
  const env = {
    APP_ORIGIN: "https://board.pages.dev",
    GRAEBOARD_EDGE_URL: "https://fixture.supabase.co/functions/v1/graeboard",
    GRAEBOARD_GATEWAY_SECRET: "g".repeat(64),
    ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
    ASSETS: {
      // Cloudflare Pages answers an unknown path with the application page.
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        const known = {
          [`/tools/canvaslide/${buildId}/`]: [
            "editor",
            "text/html; charset=utf-8",
          ],
          [`/tools/canvaslide/${buildId}/assets/index-abc.js`]: [
            "export {}",
            "text/javascript",
          ],
          "/tools/canvaslide/current.json": [
            JSON.stringify({ buildId }),
            "application/json",
          ],
        }[path] || [appPage, "text/html; charset=utf-8"];
        return new Response(known[0], {
          headers: { "Content-Type": known[1] },
        });
      },
    },
  };
  const gateway = createGateway({ verify: async () => ({}) });
  const get = (path) => gateway.fetch(new Request(env.APP_ORIGIN + path), env);

  const page = await get(`/tools/canvaslide/${buildId}/`);
  assert.equal(await page.text(), "editor");
  assert.equal(
    page.headers.get("content-security-policy"),
    SLIDE_EDITOR_POLICY,
  );
  assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");
  const asset = await get(`/tools/canvaslide/${buildId}/assets/index-abc.js`);
  assert.equal(
    asset.headers.get("cache-control"),
    "private, max-age=31536000, immutable",
  );
  assert.equal((await get("/tools/canvaslide/current.json")).status, 200);
  for (const path of [
    `/tools/canvaslide/${buildId}/assets/missing.js`,
    `/tools/canvaslide/${buildId}/pdfjs/pdf.worker.min.mjs`,
    "/tools/canvaslide/ffffffffffff/",
    "/tools/canvaslide/",
  ]) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), "Not found");
  }
  const app = await get("/slides");
  assert.equal(await app.text(), appPage);
  assert.match(
    app.headers.get("content-security-policy"),
    /frame-src 'self' blob:; frame-ancestors 'none'$/,
  );
  assert.equal(app.headers.get("x-frame-options"), "DENY");
});

test("gateway 자원 경로는 이 팀의 슬라이드 객체만 25MiB까지 받는다", async () => {
  const teamId = "11111111-1111-4111-8111-111111111111";
  const objects = new Map();
  const env = {
    SITE_TEAM_ID: teamId,
    GRAEBOARD_RESOURCE_SECRET: "r".repeat(64),
    R2_TEAM: {
      put: async (key, body, options) => {
        objects.set(key, {
          bytes: new Uint8Array(await new Response(body).arrayBuffer()),
          options,
        });
      },
      get: async (key) => {
        const object = objects.get(key);
        return (
          object && {
            body: new Response(object.bytes).body,
            size: object.bytes.byteLength,
            httpMetadata: object.options.httpMetadata,
          }
        );
      },
      list: async ({ prefix }) => ({
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
      }),
    },
  };
  const gateway = createGateway();
  const call = (path, options = {}) =>
    gateway.fetch(
      new Request("https://gateway.example" + path, {
        ...options,
        headers: {
          "x-graeboard-resource": env.GRAEBOARD_RESOURCE_SECRET,
          ...(options.body
            ? { "content-length": String(options.body.byteLength) }
            : {}),
          ...options.headers,
        },
        duplex: options.body ? "half" : undefined,
      }),
      env,
    );
  const hash = "a".repeat(64);
  const key = `slides/${teamId}/${hash}.canvaslide`;
  const object = (name) => "/_resources/object?key=" + encodeURIComponent(name);
  const bytes = new TextEncoder().encode('{"version":1}');
  assert.equal(
    (await call(object(key), { method: "PUT", body: bytes })).status,
    204,
  );
  assert.equal(objects.get(key).options.customMetadata.teamId, teamId);
  const read = await call(object(key));
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), bytes);
  assert.deepEqual(
    (
      await (
        await call(
          `/_resources/list?prefix=${encodeURIComponent(`slides/${teamId}/`)}`,
        )
      ).json()
    ).objects,
    [{ key }],
  );
  for (const refused of [
    `slides/22222222-2222-4222-8222-222222222222/${hash}.canvaslide`,
    `slides/${teamId}/${hash}.webp`,
    `slides/${teamId}/../images/${hash}.canvaslide`,
    `slides/${teamId}/name.canvaslide`,
  ])
    assert.equal(
      (await call(object(refused), { method: "PUT", body: bytes })).status,
      403,
    );
  assert.equal(
    (
      await call(
        `/_resources/list?prefix=${encodeURIComponent("slides/22222222-2222-4222-8222-222222222222/")}`,
      )
    ).status,
    403,
  );
  const over = await call(object(key), {
    method: "PUT",
    body: bytes,
    headers: { "content-length": String(MAX_SLIDE_FILE_BYTES + 1) },
  });
  assert.equal(over.status, 413);
  assert.equal(
    (await call(object(key), { headers: { "x-graeboard-resource": "wrong" } }))
      .status,
    401,
  );
});
