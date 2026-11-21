import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  describeBuildDirectory,
  expectedBuild,
  graeboardRoot,
  readPin,
  sha256,
  verifyBuildDirectory,
} from "../../scripts/canvaslide/canvaslide-build-identity.mjs";
import {
  packBundle,
  unpackBundle,
} from "../../scripts/canvaslide/canvaslide-bundle.mjs";
import { prepareCanvaslideDist } from "../../scripts/canvaslide/prepare-canvaslide-dist.mjs";
import { SLIDE_FRAME_CHANNEL } from "../../shared/slides/slide-frame-protocol.js";

// A checkout with the real adapter sources, a built app (dist/) and a small
// editor build made the way the assembly records one.
function checkout(t) {
  const root = mkdtempSync(join(tmpdir(), "canvaslide-pipeline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["scripts/canvaslide", "shared/slides"])
    cpSync(join(graeboardRoot, path), join(root, path), { recursive: true });
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/index.html"), "<!doctype html>app");
  const pin = readPin(
    join(root, "scripts/canvaslide/canvaslide-upstream.json"),
  );
  const expected = expectedBuild(root, pin);
  const made = join(root, "made", expected.buildId);
  mkdirSync(join(made, "assets"), { recursive: true });
  mkdirSync(join(made, "examples"));
  writeFileSync(
    join(made, "index.html"),
    `<!doctype html><script type="module" src="/tools/canvaslide/${expected.buildId}/assets/index-abc.js"></script>`,
  );
  writeFileSync(
    join(made, "assets/index-abc.js"),
    `const channel=${JSON.stringify(SLIDE_FRAME_CHANNEL)};`,
  );
  writeFileSync(join(made, "examples/a.canvaslide"), '{"version":1}');
  const manifest = () =>
    writeFileSync(
      join(made, "graeboard-build.json"),
      JSON.stringify({
        buildId: expected.buildId,
        upstream: { commit: expected.commit },
        adapter: { digest: expected.digest },
        files: describeBuildDirectory(made),
      }),
    );
  manifest();
  const bundle = () => {
    const bytes = packBundle(made);
    return {
      bytes,
      pin: {
        ...pin,
        bundle: {
          buildId: expected.buildId,
          url: "https://bundles.example/editor.tar.gz",
          bytes: bytes.length,
          sha256: sha256(bytes),
        },
      },
    };
  };
  const logs = [];
  const prepare = (options) =>
    prepareCanvaslideDist({
      root,
      builds: join(root, "dist-canvaslide"),
      target: join(root, "dist/tools/canvaslide"),
      bundleFile: undefined,
      log: (line) => logs.push(line),
      ...options,
    });
  const serve = (bytes, status = 200) => {
    const calls = [];
    const fetcher = async (url) => {
      calls.push(url);
      return new Response(status === 200 ? bytes : "missing", { status });
    };
    return { fetcher, calls };
  };
  return { root, pin, expected, made, manifest, bundle, prepare, serve, logs };
}
const installed = (root) =>
  existsSync(join(root, "dist/tools/canvaslide"))
    ? readdirSync(join(root, "dist/tools/canvaslide"), {
        recursive: true,
      }).sort()
    : null;

test("깨끗한 checkout의 빌드는 보관한 배포본을 받아 검증한 뒤 dist/tools/canvaslide에 설치한다", async (t) => {
  const site = checkout(t);
  const { bytes, pin } = site.bundle();
  const { fetcher, calls } = site.serve(bytes);
  // No dist-canvaslide, no pnpm, no upstream source in this checkout.
  assert.equal(existsSync(join(site.root, "dist-canvaslide")), false);
  const result = await site.prepare({ pin, fetcher });
  assert.deepEqual(
    [result.buildId, result.source],
    [site.expected.buildId, "bundle"],
  );
  assert.deepEqual(calls, ["https://bundles.example/editor.tar.gz"]);
  const target = join(site.root, "dist/tools/canvaslide");
  assert.deepEqual(
    JSON.parse(readFileSync(join(target, "current.json"), "utf8")).buildId,
    site.expected.buildId,
  );
  // The served directory is exactly the verified build.
  verifyBuildDirectory(join(target, site.expected.buildId), site.expected);
  assert.match(
    readFileSync(
      join(target, site.expected.buildId, "assets/index-abc.js"),
      "utf8",
    ),
    /graeboard\.slides\.frame\.v1/,
  );
  assert.equal(
    readFileSync(join(site.root, "dist/index.html"), "utf8"),
    "<!doctype html>app",
  );

  // The next build uses the unpacked build and downloads nothing.
  const again = await site.prepare({
    pin,
    fetcher: async () => assert.fail("no download expected"),
  });
  assert.equal(again.source, "dist-canvaslide");
});

test("배포본이 없거나 손상됐으면 빌드를 실패시키고 편집기 없는 앱을 만들지 않는다", async (t) => {
  for (const [name, change, pattern] of [
    ["missing", (b) => ({ ...b, status: 404 }), /HTTP 404/],
    ["network", (b) => ({ ...b, fail: true }), /connection refused/],
    [
      "truncated",
      (b) => ({ ...b, bytes: b.bytes.subarray(0, b.bytes.length - 20) }),
      /크기·SHA-256/,
    ],
    [
      "tampered",
      (b) => {
        const bytes = Buffer.from(b.bytes);
        bytes[bytes.length - 12] ^= 1;
        return { ...b, bytes };
      },
      /크기·SHA-256/,
    ],
  ]) {
    const site = checkout(t);
    const bundle = change({ ...site.bundle(), status: 200 });
    const fetcher = bundle.fail
      ? async () => {
          throw new Error("connection refused");
        }
      : site.serve(bundle.bytes, bundle.status).fetcher;
    await assert.rejects(
      site.prepare({ pin: bundle.pin, fetcher }),
      pattern,
      name,
    );
    assert.equal(installed(site.root), null, name);
    assert.equal(
      existsSync(join(site.root, "dist-canvaslide", site.expected.buildId)),
      false,
    );
  }
});

test("명세의 해시와 맞더라도 내용이 빌드 명세와 다른 배포본은 설치하지 않는다", async (t) => {
  for (const damage of ["changed", "extra", "channel", "page"]) {
    const site = checkout(t);
    if (damage === "changed")
      writeFileSync(join(site.made, "examples/a.canvaslide"), '{"version":2}');
    if (damage === "extra")
      writeFileSync(join(site.made, "assets/extra.js"), "x");
    if (damage === "channel") {
      // A build of the plain upstream editor, without GraeBoard's adapter.
      writeFileSync(
        join(site.made, "assets/index-abc.js"),
        "const upstream=1;",
      );
      site.manifest();
    }
    if (damage === "page") {
      writeFileSync(
        join(site.made, "index.html"),
        '<!doctype html><script type="module" src="/assets/index-abc.js"></script>',
      );
      site.manifest();
    }
    const { bytes, pin } = site.bundle();
    await assert.rejects(
      site.prepare({ pin, fetcher: site.serve(bytes).fetcher }),
      /명세와 다릅니다|연결 모듈|경로를 가리키지/,
      damage,
    );
    assert.equal(installed(site.root), null, damage);
    assert.deepEqual(
      existsSync(join(site.root, "dist-canvaslide"))
        ? readdirSync(join(site.root, "dist-canvaslide"))
        : [],
      [],
      "nothing half-unpacked is left",
    );
  }
});

test("이미 조립해 둔 빌드도 같은 검증을 거치고, 어댑터가 바뀌면 보관본을 쓰지 않는다", async (t) => {
  const site = checkout(t);
  const builds = join(site.root, "dist-canvaslide");
  cpSync(site.made, join(builds, site.expected.buildId), { recursive: true });
  const local = await site.prepare({
    fetcher: async () => assert.fail("no download expected"),
  });
  assert.equal(local.source, "dist-canvaslide");
  // A file changed after assembly.
  writeFileSync(
    join(builds, site.expected.buildId, "assets/index-abc.js"),
    "changed",
  );
  rmSync(join(site.root, "dist/tools"), { recursive: true });
  await assert.rejects(site.prepare({}), /명세와 다릅니다/);
  assert.equal(installed(site.root), null);

  // GraeBoard's adapter changed: the kept bundle is another build.
  const { bytes, pin } = site.bundle();
  writeFileSync(
    join(site.root, "scripts/canvaslide/frame/slide-frame-binding.ts"),
    "export {}\n",
  );
  rmSync(builds, { recursive: true });
  await assert.rejects(
    site.prepare({ pin, fetcher: site.serve(bytes).fetcher }),
    /보관 배포본이 없습니다/,
  );
  assert.equal(installed(site.root), null);
});

test("배포본 묶음은 같은 빌드에서 항상 같은 바이트이고 경로를 벗어나는 항목을 거절한다", (t) => {
  const site = checkout(t);
  const first = packBundle(site.made);
  assert.equal(sha256(packBundle(site.made)), sha256(first));
  const out = join(site.root, "unpacked");
  assert.equal(unpackBundle(first, out), 4);
  assert.deepEqual(
    describeBuildDirectory(out),
    describeBuildDirectory(site.made),
  );

  // An archive that names a path outside its directory.
  const header = Buffer.alloc(512);
  header.write("../escape.txt", 0);
  header.write("00000000001\0", 124);
  header.write("0", 156);
  const evil = gzipSync(
    Buffer.concat([header, Buffer.from("x"), Buffer.alloc(511 + 1024)]),
  );
  assert.throws(
    () => unpackBundle(evil, join(site.root, "evil")),
    /Unsupported/,
  );
  assert.equal(existsSync(join(site.root, "escape.txt")), false);
});

test("이 저장소의 고정 명세는 현재 어댑터 소스의 빌드를 가리킨다", () => {
  const pin = readPin();
  const expected = expectedBuild();
  assert.equal(
    pin.bundle?.buildId,
    expected.buildId,
    "어댑터나 고정 커밋을 바꿨으면 npm run build:canvaslide && npm run build:canvaslide:pack 으로 배포본과 명세를 갱신하세요.",
  );
  assert.match(pin.bundle.sha256, /^[a-f0-9]{64}$/);
  assert.ok(pin.bundle.bytes > 0);
  assert.match(pin.bundle.url, new RegExp(`/${expected.buildId}\\.tar\\.gz$`));
});
