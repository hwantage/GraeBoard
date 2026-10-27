import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { build } from "esbuild";

test("GitHub transport uses the native workerd fetch to read team data", async () => {
  const head = "a".repeat(40),
    tree = "b".repeat(40),
    blob = "c".repeat(40);
  const manifest = { teamId: "fixture-team", repoId: "fixture-repo" };
  const bundled = await build({
    stdin: {
      contents: `import { GitHubApiTransport } from './server/sync/github-api.mjs';
        export default { async fetch() {
          try {
            const git = new GitHubApiTransport({ repository: 'fixture/team', token: 'fixture-token' });
            const head = await git.readHead();
            const bytes = await git.readFile(head, 'manifest.json');
            return Response.json({ head, manifest: JSON.parse(new TextDecoder().decode(bytes)) });
          } catch (error) { return Response.json({ error: error.message }, { status: 500 }); }
        } };`,
      resolveDir: process.cwd(),
      sourcefile: "github-runtime-test.mjs",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["node:*"],
  });
  let requests = 0,
    redirect = false;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-10-23",
      compatibilityFlags: ["nodejs_compat"],
      outboundService: async (request) => {
        requests++;
        assert.equal(
          request.headers.get("authorization"),
          "Bearer fixture-token",
        );
        const url = new URL(request.url);
        assert.equal(url.origin, "https://api.github.com");
        if (redirect)
          return new Response(null, {
            status: 302,
            headers: { Location: "https://untrusted.example.com/" },
          });
        if (url.pathname.endsWith("/git/ref/heads/sync-v1"))
          return Response.json({ object: { sha: head } });
        if (url.pathname.endsWith("/git/commits/" + head))
          return Response.json({ tree: { sha: tree }, parents: [] });
        if (url.pathname.endsWith("/git/trees/" + tree))
          return Response.json({
            tree: [
              {
                path: "manifest.json",
                sha: blob,
                mode: "100644",
                type: "blob",
              },
            ],
          });
        if (url.pathname.endsWith("/git/blobs/" + blob))
          return new Response(JSON.stringify(manifest));
        throw new Error("Unexpected request " + url.pathname);
      },
    }),
  );
  try {
    const response = await runtime.dispatchFetch(
      "https://runtime.example.com/",
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { head, manifest });
    assert.equal(requests, 4);
    redirect = true;
    const rejected = await runtime.dispatchFetch(
      "https://runtime.example.com/",
    );
    assert.equal(rejected.status, 500);
    assert.match((await rejected.json()).error, /redirects are not allowed/);
    assert.equal(requests, 5, "the redirect must not forward the GitHub token");
  } finally {
    await runtime.dispose();
  }
});

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
