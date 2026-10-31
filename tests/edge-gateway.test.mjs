import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { createEdgeHandler } from "../edge/handler.mjs";
import { verifyAccess } from "../worker/access.mjs";
import { resourceBindings } from "../edge/resources.mjs";
import { createGateway } from "../worker/gateway.mjs";

test("gateway restores HTML only for an authorized setup guide", async () => {
  const env = {
    APP_ORIGIN: "https://board.pages.dev",
    GRAEBOARD_EDGE_URL: "https://fixture.supabase.co/functions/v1/graeboard",
    GRAEBOARD_GATEWAY_SECRET: "g".repeat(64),
  };
  for (const [path, status, expected] of [
    ["/api/admin/service-connections/guide", 200, "text/html"],
    ["/api/admin/service-connections/guide", 403, "text/plain"],
    ["/api/bootstrap", 200, "text/plain"],
  ]) {
    const gateway = createGateway({
      fetcher: async () =>
        new Response("guide", {
          status,
          headers: { "Content-Type": "text/plain" },
        }),
    });
    const response = await gateway.fetch(
      new Request(env.APP_ORIGIN + path),
      env,
    );
    assert.equal(response.status, status);
    assert.ok(response.headers.get("content-type").startsWith(expected));
  }
});

for (const viaLegacy of [false, true])
  test(`workerd ${viaLegacy ? "legacy forwarder, " : ""}gateway and Edge enforce Access on assets, origin, secrets, cookies and streaming`, async () => {
    const env = {
      APP_ORIGIN: "https://board.pages.dev",
      GRAEBOARD_GATEWAY_SECRET: "g".repeat(64),
      GRAEBOARD_RESOURCE_SECRET: "r".repeat(64),
      GRAEBOARD_EDGE_URL: "https://fixture.supabase.co/functions/v1/graeboard",
      ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
      ACCESS_AUDIENCE: "board",
      SITE_TEAM_ID: "11111111-1111-4111-8111-111111111111",
    };
    const keys = await generateKeyPair("RS256"),
      jwk = await exportJWK(keys.publicKey);
    const verify = (r, e) =>
      verifyAccess(r, e, { jwks: createLocalJWKSet({ keys: [jwk] }) });
    const token = await new SignJWT({ type: "app", email: "lead@example.com" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(env.ACCESS_ISSUER)
      .setAudience(env.ACCESS_AUDIENCE)
      .setSubject("lead")
      .setExpirationTime("1h")
      .sign(keys.privateKey);
    let assets = 0,
      api = 0,
      edgeAccess = 0,
      keyRequests = 0;
    const edge = createEdgeHandler({
      env,
      verify,
      execution: { waitUntil() {} },
      app: {
        async fetch(request) {
          await verify(request, env);
          api++;
          assert.equal(
            request.headers.get("cookie"),
            "__Host-graeboard_account=fixture",
          );
          assert.equal(new URL(request.url).origin, env.APP_ORIGIN);
          assert.equal(await request.text(), "payload");
          return new Response("event: ready\ndata: {}\n\n", {
            headers: {
              "Content-Type": "text/event-stream",
              "Set-Cookie":
                "__Host-graeboard_account=renewed; Path=/; Secure; HttpOnly; SameSite=Strict",
            },
          });
        },
      },
    });
    const code = await build({
      entryPoints: ["worker/gateway.mjs"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["node:*"],
    });
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          ...(viaLegacy
            ? [
                {
                  name: "legacy",
                  modules: true,
                  script: (
                    await build({
                      entryPoints: ["worker/forwarder.mjs"],
                      bundle: true,
                      write: false,
                      format: "esm",
                      platform: "browser",
                    })
                  ).outputFiles[0].text,
                  compatibilityDate: "2026-10-23",
                  serviceBindings: { GRAEBOARD_BACKEND: "gateway" },
                },
              ]
            : []),
          {
            name: "gateway",
            modules: true,
            script: code.outputFiles[0].text,
            compatibilityDate: "2026-10-23",
            compatibilityFlags: ["nodejs_compat"],
            bindings: env,
            r2Buckets: ["R2_TEAM"],
            serviceBindings: {
              ASSETS: async () => {
                assets++;
                return new Response("private app");
              },
            },
            outboundService: async (request) => {
              if (request.url === env.ACCESS_ISSUER + "/cdn-cgi/access/certs") {
                keyRequests++;
                return Response.json({ keys: [jwk] });
              }
              if (new URL(request.url).pathname.endsWith("/_gateway/access"))
                edgeAccess++;
              return edge(request);
            },
          },
        ],
      }),
    );
    try {
      const direct = env.GRAEBOARD_EDGE_URL + "/_gateway/access";
      assert.equal((await edge(new Request(direct))).status, 401);
      // Hosted Supabase strips /functions/v1 before invoking the handler.
      assert.equal(
        (
          await edge(
            new Request(
              "https://fixture.supabase.co/graeboard/_gateway/access",
              {
                headers: {
                  "x-graeboard-gateway": env.GRAEBOARD_GATEWAY_SECRET,
                  "x-graeboard-origin": env.APP_ORIGIN,
                  "cf-access-jwt-assertion": token,
                },
              },
            ),
          )
        ).status,
        204,
      );
      assert.equal(
        (
          await edge(
            new Request(direct, {
              headers: {
                "x-graeboard-gateway": env.GRAEBOARD_GATEWAY_SECRET,
                "x-graeboard-origin": "https://evil.example",
              },
            }),
          )
        ).status,
        403,
      );
      assert.equal(
        (await runtime.dispatchFetch(env.APP_ORIGIN + "/assets/app.js")).status,
        401,
      );
      assert.equal(assets, 0);
      assert.equal(
        (
          await runtime.dispatchFetch("https://gateway.workers.dev/", {
            headers: { "cf-access-jwt-assertion": token },
          })
        ).status,
        403,
      );
      const page = await runtime.dispatchFetch(env.APP_ORIGIN, {
        headers: { "cf-access-jwt-assertion": token },
      });
      assert.equal(page.status, 200);
      assert.equal(await page.text(), "private app");
      assert.equal(assets, 1);
      const files = await Promise.all(
        Array.from({ length: 43 }, (_, i) =>
          runtime.dispatchFetch(env.APP_ORIGIN + `/assets/font-${i}.woff2`, {
            headers: { "cf-access-jwt-assertion": token },
          }),
        ),
      );
      for (const file of files) {
        assert.equal(file.status, 200);
        await file.text();
      }
      assert.equal(
        edgeAccess,
        0,
        "page and asset authentication must not invoke Edge",
      );
      assert.equal(
        keyRequests,
        1,
        "concurrent assets share the cached Access public keys",
      );
      for (const [issuer, audience, expiry] of [
        [env.ACCESS_ISSUER, "other-app", "1h"],
        [env.ACCESS_ISSUER, env.ACCESS_AUDIENCE, "-1s"],
        ["https://other.cloudflareaccess.com", env.ACCESS_AUDIENCE, "1h"],
      ]) {
        const invalid = await new SignJWT({
          type: "app",
          email: "lead@example.com",
        })
          .setProtectedHeader({ alg: "RS256" })
          .setIssuer(issuer)
          .setAudience(audience)
          .setSubject("lead")
          .setExpirationTime(expiry)
          .sign(keys.privateKey);
        assert.equal(
          (
            await runtime.dispatchFetch(env.APP_ORIGIN + "/assets/app.js", {
              headers: { "cf-access-jwt-assertion": invalid },
            })
          ).status,
          401,
        );
      }
      assert.equal(assets, 44, "invalid tokens never reach static assets");
      const response = await runtime.dispatchFetch(
        env.APP_ORIGIN + "/api/events",
        {
          method: "POST",
          headers: {
            "cf-access-jwt-assertion": token,
            Cookie: "__Host-graeboard_account=fixture",
            "x-graeboard-origin": "https://evil.example",
            "x-graeboard-gateway": "forged",
          },
          body: "payload",
        },
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get("set-cookie"), /HttpOnly/);
      assert.match(await response.text(), /event: ready/);
      assert.equal(api, 1);
      assert.equal(
        (await runtime.dispatchFetch(env.APP_ORIGIN + "/_resources/list"))
          .status,
        401,
      );
      const resources = resourceBindings(
        {
          RESOURCE_ORIGIN: "https://gateway.workers.dev",
          GRAEBOARD_RESOURCE_SECRET: env.GRAEBOARD_RESOURCE_SECRET,
        },
        (input, init) => runtime.dispatchFetch(input, init),
      );
      const key = `images/${env.SITE_TEAM_ID}/${"a".repeat(64)}.webp`,
        bytes = new Uint8Array([1, 2, 3]);
      await resources.bucket.put(key, bytes);
      assert.equal((await resources.bucket.head(key)).size, 3);
      assert.deepEqual(
        new Uint8Array(await (await resources.bucket.get(key)).arrayBuffer()),
        bytes,
      );
      assert.equal(
        (await resources.bucket.list({ prefix: `images/${env.SITE_TEAM_ID}/` }))
          .objects.length,
        1,
      );
      await assert.rejects(
        resources.bucket.get(
          `images/22222222-2222-4222-8222-222222222222/${"a".repeat(64)}.webp`,
        ),
      );
      await resources.bucket.delete(key);
      assert.equal(await resources.bucket.get(key), null);
    } finally {
      await runtime.dispose();
    }
  });

test("legacy gateway settings keep Edge verification; partial local settings fail closed", async () => {
  let forwarded = 0;
  const env = {
    APP_ORIGIN: "https://board.pages.dev",
    GRAEBOARD_EDGE_URL: "https://fixture.supabase.co/functions/v1/graeboard",
    GRAEBOARD_GATEWAY_SECRET: "g".repeat(64),
    ASSETS: { fetch: async () => new Response("app") },
  };
  const gateway = createGateway({
    fetcher: async () => {
      forwarded++;
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(
    (await gateway.fetch(new Request(env.APP_ORIGIN), env)).status,
    200,
  );
  assert.equal(forwarded, 1);
  assert.equal(
    (
      await gateway.fetch(new Request(env.APP_ORIGIN), {
        ...env,
        ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
      })
    ).status,
    503,
  );
  assert.equal(forwarded, 1);
  const local = createGateway({ verify: async () => ({}) });
  assert.equal(
    (
      await local.fetch(new Request("http://board.pages.dev"), {
        ...env,
        APP_ORIGIN: "http://board.pages.dev",
        ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
        ACCESS_AUDIENCE: "board",
      })
    ).status,
    503,
    "local verification retains the HTTPS origin requirement",
  );
});

test("hashed build files are cached by the browser; the app page and fallbacks are not", async () => {
  const env = {
    APP_ORIGIN: "https://board.pages.dev",
    ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
    ACCESS_AUDIENCE: "board",
    ASSETS: {
      fetch: async (request) =>
        new URL(request.url).pathname === "/assets/index-BWhnghAv.js"
          ? new Response("app()", {
              headers: {
                "Content-Type": "text/javascript",
                "Cache-Control": "public, max-age=0, must-revalidate",
              },
            })
          : // Single-page fallback for a missing file or a route.
            new Response("<!doctype html>", {
              headers: { "Content-Type": "text/html" },
            }),
    },
  };
  const gateway = createGateway({ verify: async () => ({}) });
  const cache = async (path) =>
    (await gateway.fetch(new Request(env.APP_ORIGIN + path), env)).headers.get(
      "Cache-Control",
    );
  assert.equal(
    await cache("/assets/index-BWhnghAv.js"),
    "private, max-age=31536000, immutable",
  );
  assert.equal(await cache("/"), null);
  assert.equal(await cache("/assets/index-Missing1.js"), null);
  assert.equal(await cache("/assets/plain.js"), null);
});
