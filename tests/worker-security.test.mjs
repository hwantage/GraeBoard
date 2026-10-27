import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { verifyAccess, assertOrigin } from "../worker/access.mjs";
import { profiles } from "../worker/config.mjs";
import { createWorker } from "../worker/entry.mjs";
import { GitHubApiTransport } from "../worker/git.mjs";
import {
  stillImage,
  convertImage,
  R2ImageStore,
  imageReferences,
} from "../worker/images.mjs";
import { digest } from "../server/sync/protocol.mjs";
import sharp from "sharp";

test("unexpected Worker failures are logged without exposing their details in the response", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (...values) => logged.push(values));
  const worker = createWorker({
    verify: async () => {
      throw Object.assign(new Error("private database failure"), {
        code: "08006",
      });
    },
  });
  const response = await worker.fetch(
    new Request("https://board.example.com/api/setup"),
    {
      APP_ORIGIN: "https://board.example.com",
    },
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "서비스 연결을 확인한 뒤 다시 시도하세요.",
  });
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1].code, "08006");
  assert.equal(logged[0][1].message, "private database failure");
});

test("Access verifies signature, issuer, audience, expiry and invited-human identity before assets", async () => {
  const env = {
    APP_ORIGIN: "https://board.example.com",
    ACCESS_ISSUER: "https://organization.cloudflareaccess.com",
    ACCESS_AUDIENCE: "graeboard-audience",
  };
  const keys = await generateKeyPair("RS256"),
    jwk = await exportJWK(keys.publicKey);
  jwk.kid = "one";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const token = async (claims) =>
    new SignJWT({ type: "app", email: "user@example.com", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "one" })
      .setIssuer(claims?.iss || env.ACCESS_ISSUER)
      .setAudience(claims?.aud || env.ACCESS_AUDIENCE)
      .setSubject(claims?.sub ?? "human")
      .setExpirationTime(claims?.exp ?? "1h")
      .sign(keys.privateKey);
  const req = (value) =>
    new Request(env.APP_ORIGIN + "/api/bootstrap", {
      headers: { "Cf-Access-Jwt-Assertion": value },
    });
  assert.equal(
    (await verifyAccess(req(await token()), env, { jwks })).subject,
    "human",
  );
  for (const claims of [
    { aud: "other-service" },
    { iss: "https://other.cloudflareaccess.com" },
    { exp: Math.floor(Date.now() / 1000) - 1 },
    { sub: "" },
    { type: "service" },
  ])
    await assert.rejects(
      verifyAccess(req(await token(claims)), env, { jwks }),
      (e) => e.status === 401,
    );
  const signed = await token(),
    parts = signed.split(".");
  parts[1] = Buffer.from(
    JSON.stringify({
      type: "app",
      email: "admin@example.com",
      sub: "admin",
      iss: env.ACCESS_ISSUER,
      aud: env.ACCESS_AUDIENCE,
      exp: 9999999999,
    }),
  ).toString("base64url");
  await assert.rejects(
    verifyAccess(req(parts.join(".")), env, { jwks }),
    (e) => e.status === 401,
  );
  await assert.rejects(
    verifyAccess(
      new Request(env.APP_ORIGIN, {
        headers: { "Cf-Access-Authenticated-User-Email": "admin@example.com" },
      }),
      env,
      { jwks },
    ),
    (e) => e.status === 401,
  );
  let assetReads = 0;
  env.ASSETS = {
    fetch: async () => {
      assetReads++;
      return new Response("private application assets");
    },
  };
  const worker = createWorker({
    verify: (r, e) => verifyAccess(r, e, { jwks }),
  });
  assert.equal(
    (await worker.fetch(new Request(env.APP_ORIGIN), env)).status,
    401,
  );
  assert.equal(assetReads, 0);
  assert.equal(
    (
      await worker.fetch(
        new Request("https://preview.workers.dev/", {
          headers: { "Cf-Access-Jwt-Assertion": signed },
        }),
        env,
      )
    ).status,
    403,
  );
  assert.equal(assetReads, 0);
  assert.equal(
    (
      await worker.fetch(
        new Request(env.APP_ORIGIN, {
          headers: { "Cf-Access-Jwt-Assertion": signed },
        }),
        env,
      )
    ).status,
    200,
  );
  assert.equal(assetReads, 1);
  assert.throws(
    () =>
      assertOrigin(
        new Request(env.APP_ORIGIN + "/api/tasks", {
          method: "POST",
          headers: {
            Origin: "https://attacker.invalid",
            "X-Requested-With": "WeeklyPlan",
          },
        }),
        env,
      ),
    (e) => e.status === 403,
  );
});

test("deployment profiles reject shared team resources and do not accept client connection URLs", () => {
  const p = {
    profileId: "one",
    teamId: randomUUID(),
    repository: "owner/team-one",
    databaseBinding: "PG_TEAM_A",
    bucketBinding: "R2_TEAM_A",
    githubSecret: "GIT_TEAM_A",
  };
  assert.equal(
    profiles({ SYNC_PROFILES: JSON.stringify([p]) })[0].repository,
    "owner/team-one",
  );
  for (const change of [
    { teamId: p.teamId },
    { databaseBinding: p.databaseBinding },
    { bucketBinding: p.bucketBinding },
    { repository: p.repository },
  ])
    assert.throws(() =>
      profiles({
        SYNC_PROFILES: JSON.stringify([
          p,
          {
            ...p,
            profileId: "two",
            teamId: randomUUID(),
            repository: "owner/two",
            databaseBinding: "PG_TEAM_B",
            bucketBinding: "R2_TEAM_B",
            githubSecret: "GIT_TEAM_B",
            ...change,
          },
        ]),
      }),
    );
  assert.throws(() =>
    profiles({
      SYNC_PROFILES: JSON.stringify([
        { ...p, repository: "https://attacker.invalid/data" },
      ]),
    }),
  );
  assert.throws(() =>
    profiles({
      SYNC_PROFILES: JSON.stringify([{ ...p, databaseBinding: "PG_CONTROL" }]),
    }),
  );
});

test("GitHub transport uses one parent, non-force refs and verifies ambiguous races without exposing token", async () => {
  const calls = [],
    parent = "a".repeat(40),
    candidate = "b".repeat(40),
    other = "c".repeat(40);
  let head = parent;
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname,
      body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, init, body });
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer test-secret");
    if (path.endsWith("/git/commits/" + parent))
      return Response.json({ parents: [], tree: { sha: "d".repeat(40) } });
    if (path.includes("/git/trees/"))
      return Response.json({ tree: [], truncated: false });
    if (path.endsWith("/git/blobs")) {
      assert.equal(body.encoding, "base64");
      return Response.json({ sha: "e".repeat(40) });
    }
    if (path.endsWith("/git/trees"))
      return Response.json({ sha: "f".repeat(40) });
    if (path.endsWith("/git/commits")) {
      assert.deepEqual(body.parents, [parent]);
      return Response.json({ sha: candidate });
    }
    if (path.endsWith("/git/refs/heads/sync-v1")) {
      assert.equal(body.force, false);
      return Response.json({ message: "non fast forward" }, { status: 422 });
    }
    if (path.endsWith("/git/ref/heads/sync-v1"))
      return Response.json({ object: { sha: head } });
    throw new Error("unexpected " + path);
  };
  const transport = new GitHubApiTransport({
    repository: "owner/private-data",
    token: "test-secret",
    fetch: fetcher,
  });
  assert.equal(
    await transport.createCandidate(parent, { "events/test.json": "{}" }),
    candidate,
  );
  head = other;
  assert.equal(await transport.publish(candidate, parent), false);
  head = candidate;
  assert.equal(await transport.publish(candidate, parent), true);
  head = parent;
  await assert.rejects(
    transport.publish(candidate, parent),
    (e) => e.status === 422,
  );
  assert.equal(
    calls.some((c) => c.init.body?.includes("test-secret")),
    false,
  );
});

test("Worker image normalization uses private streams, static WebP bytes and team content hashes", async () => {
  const png = await sharp({
      create: { width: 20, height: 10, channels: 4, background: "#336699" },
    })
      .png()
      .toBuffer(),
    webp = await sharp(png).webp({ quality: 90 }).toBuffer();
  let transformation, output;
  const images = {
    info: async () => ({
      format: "image/png",
      width: 20,
      height: 10,
      fileSize: png.length,
    }),
    input: (stream) => {
      assert(stream instanceof ReadableStream);
      return {
        transform(options) {
          transformation = options;
          return {
            async output(options) {
              output = options;
              return { response: () => new Response(webp) };
            },
          };
        },
      };
    },
  };
  const converted = await convertImage(new File([png], "image.png"), images);
  assert.deepEqual(transformation, {
    width: 4096,
    height: 4096,
    fit: "scale-down",
  });
  assert.deepEqual(output, { format: "image/webp", quality: 90, anim: false });
  assert.equal(converted.hash, digest(webp));
  const inserted = Buffer.concat([
    png.subarray(0, png.length - 12),
    Buffer.from([0, 0, 0, 0, 97, 99, 84, 76, 0, 0, 0, 0]),
    png.subarray(png.length - 12),
  ]);
  assert.throws(() => stillImage(inserted), /정지 이미지/);
  const objects = new Map(),
    bucket = {
      put: async (key, bytes) => objects.set(key, bytes),
      head: async (key) => (objects.has(key) ? {} : null),
      get: async (key) =>
        objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null,
      delete: async (key) => objects.delete(key),
    },
    teamId = randomUUID(),
    store = new R2ImageStore(bucket, teamId),
    url = `/api/document-images/${teamId}/${converted.hash}.webp`;
  await store.install(url, converted.bytes);
  assert.deepEqual(await store.read(url), new Uint8Array(webp));
  await assert.rejects(store.install(url, png), /무결성/);
  assert.throws(
    () => store.key(url.replace(teamId, randomUUID())),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      imageReferences(`![image](${url.replace(teamId, randomUUID())})`, teamId),
    (e) => e.status === 400,
  );
});
