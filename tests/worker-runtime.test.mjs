import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

test(
  "bundled Pages gateway reaches the private Worker in workerd and authenticates all paths before assets",
  { timeout: 60000 },
  async () => {
    const build = spawnSync(process.execPath, ["scripts/build-worker.mjs"], {
      encoding: "utf8",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const pagesBuild = spawnSync(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "pages",
        "functions",
        "build",
        "--outdir",
        "dist-pages",
        "--build-output-directory",
        "dist",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
    assert.equal(pagesBuild.status, 0, pagesBuild.stdout + pagesBuild.stderr);
    assert.deepEqual(JSON.parse(readFileSync("public/_routes.json", "utf8")), {
      version: 1,
      include: ["/*"],
      exclude: [],
    });
    const keys = await generateKeyPair("RS256"),
      jwk = await exportJWK(keys.publicKey);
    jwk.kid = "runtime";
    const issuer = "https://runtime.cloudflareaccess.com",
      audience = "runtime-aud",
      origin = "https://graeboard.pages.dev";
    let assets = 0,
      jwks = 0;
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            name: "pages",
            modules: true,
            scriptPath: "dist-pages/index.js",
            compatibilityDate: "2026-10-23",
            serviceBindings: { GRAEBOARD_BACKEND: "graeboard" },
          },
          {
            name: "graeboard",
            modules: true,
            scriptPath: "dist-worker/entry.js",
            compatibilityDate: "2026-10-23",
            compatibilityFlags: ["nodejs_compat"],
            bindings: {
              APP_ORIGIN: origin,
              ACCESS_ISSUER: issuer,
              ACCESS_AUDIENCE: audience,
            },
            serviceBindings: {
              ASSETS: async () => {
                assets++;
                return new Response("private app");
              },
            },
            outboundService: async (request) => {
              assert.equal(request.url, issuer + "/cdn-cgi/access/certs");
              jwks++;
              return Response.json({ keys: [jwk] });
            },
          },
        ],
      }),
    );
    try {
      assert.equal((await runtime.dispatchFetch(origin + "/")).status, 401);
      assert.equal(
        (await runtime.dispatchFetch(origin + "/assets/app.js")).status,
        401,
      );
      assert.equal(
        (await runtime.dispatchFetch(origin + "/api/bootstrap")).status,
        401,
      );
      assert.equal(assets, 0);
      const signed = await new SignJWT({
          type: "app",
          email: "person@example.com",
        })
          .setProtectedHeader({ alg: "RS256", kid: "runtime" })
          .setIssuer(issuer)
          .setAudience(audience)
          .setSubject("person")
          .setExpirationTime("1h")
          .sign(keys.privateKey),
        headers = { "Cf-Access-Jwt-Assertion": signed };
      assert.equal(
        (
          await runtime.dispatchFetch("https://preview.workers.dev/", {
            headers,
          })
        ).status,
        403,
      );
      assert.equal(assets, 0);
      const response = await runtime.dispatchFetch(origin + "/", { headers });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(await response.text(), "private app");
      assert.equal(assets, 1);
      assert.equal(jwks, 1);
      assert.equal(
        (await runtime.dispatchFetch(origin + "/api/health", { headers }))
          .status,
        503,
      );
    } finally {
      await runtime.dispose();
    }
  },
);
