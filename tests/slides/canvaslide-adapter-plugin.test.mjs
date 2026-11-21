import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { graeboardCanvaslideAdapter } from "../../scripts/canvaslide/canvaslide-adapter-plugin.mjs";

const graeboardRoot = fileURLToPath(new URL("../../", import.meta.url));
const upstreamRoot = "/work/canvaslide";
const platform = `${upstreamRoot}/src/renderer/src/platform`;
const frame = resolve(graeboardRoot, "scripts/canvaslide/frame");

// The plugin's hooks with the part of the bundler context they use.
function plugin(resolved = {}) {
  const errors = [];
  const instance = graeboardCanvaslideAdapter({ graeboardRoot, upstreamRoot });
  const context = {
    resolve: async (source) =>
      source in resolved ? { id: resolved[source] } : null,
    error(message) {
      errors.push(message);
      throw new Error(message);
    },
  };
  return {
    errors,
    resolveId: (source, importer) =>
      instance.resolveId.call(context, source, importer, {}),
    transform: (code, id) => instance.transform.call(context, code, id),
    buildEnd: (error) => instance.buildEnd.call(context, error),
  };
}
const sources = {
  [`${upstreamRoot}/src/renderer/src/main.tsx`]: "import './App'\n",
  [`${platform}/recovery-database.ts`]:
    "const DATABASE_NAME = 'canvaslide-recovery'\nconst STORE_NAME = 'snapshots'\n",
  [`${platform}/recovery-session.ts`]:
    "const LOCK_PREFIX = 'canvaslide.recovery.session.'\n",
  [`${upstreamRoot}/src/renderer/src/components/toolbar/top-bar.tsx`]: [
    "{compact ? (\n        <ActionMenu\n          label={t('menu.file')}",
    '{!compact && <div className="mx-1 h-5 w-px bg-border" />}\n      <div className="flex items-center gap-1">',
    "<input\n          aria-label={t('file.documentName')}",
    "/>\n        {dirty && !compact && (",
  ].join("\n"),
  [`${upstreamRoot}/src/renderer/src/hooks/use-document-commands.ts`]:
    "() => ({\n      saveDocument: () =>",
  [`${upstreamRoot}/src/renderer/src/components/panels/cloud-share-dialog.tsx`]:
    "{ name: `.${DOCUMENT_FILE_EXTENSION}`, run: () => void commands.saveDocumentAs() },",
};
const imports = {
  "@/platform/document-file-access": `${platform}/document-file-access.ts`,
  "./document-file-access": `${platform}/document-file-access.ts?v=1`,
  "@/platform/cloud-share": `${platform}/cloud-share.ts`,
  "@/store/document-store": `${upstreamRoot}/src/renderer/src/store/document-store.ts`,
};

test("편집기의 파일·공유 모듈은 그래보드 어댑터로 연결하고 어댑터는 원본을 그대로 참조한다", async () => {
  const build = plugin(imports);
  const importer = `${upstreamRoot}/src/renderer/src/lib/document/save-document.ts`;
  assert.equal(
    await build.resolveId("@/platform/document-file-access", importer),
    resolve(frame, "slide-frame-file-access.ts"),
  );
  assert.equal(
    await build.resolveId(
      "./document-file-access",
      `${platform}/launch-document.ts`,
    ),
    resolve(frame, "slide-frame-file-access.ts"),
  );
  assert.equal(
    await build.resolveId("@/platform/cloud-share", importer),
    resolve(frame, "slide-frame-cloud-share.ts"),
  );
  // The adapter reaches the original implementation under its own name, so
  // editor and adapter share one module instance.
  assert.equal(
    await build.resolveId(
      "graeboard-upstream:document-file-access",
      resolve(frame, "slide-frame-file-access.ts"),
    ),
    `${platform}/document-file-access.ts`,
  );
  assert.equal(
    await build.resolveId("graeboard-upstream:cloud-share", importer),
    `${platform}/cloud-share.ts`,
  );
  assert.deepEqual(await build.resolveId("@/store/document-store", importer), {
    id: imports["@/store/document-store"],
  });
  assert.equal(
    await build.resolveId(
      "@graeboard/shared/slides/slide-frame-protocol.js",
      resolve(frame, "slide-frame-host.ts"),
    ),
    resolve(graeboardRoot, "shared/slides/slide-frame-protocol.js"),
  );
  await assert.rejects(
    build.resolveId("graeboard-upstream:unknown", importer),
    /Unknown upstream module/,
  );
});

test("진입점과 복구 저장 이름을 바꾸고, 원본 문구가 사라지면 빌드를 실패시킨다", async () => {
  const build = plugin(imports);
  const [main, database, session] = Object.entries(sources).map(
    ([id, code]) => build.transform(code, id).code,
  );
  assert.ok(
    main.startsWith(
      `import ${JSON.stringify(resolve(frame, "slide-frame-main.ts"))};`,
    ),
  );
  assert.match(main, /import '\.\/App'/);
  assert.match(
    database,
    /const DATABASE_NAME = 'canvaslide-recovery' \+ graeboardRecoveryScope\n/,
  );
  assert.match(
    session,
    /const LOCK_PREFIX = 'canvaslide\.recovery\.session' \+ graeboardRecoveryScope \+ '\.'/,
  );
  assert.equal(build.transform("export {}", `${platform}/file-path.ts`), null);

  // Upstream renamed or restructured the text GraeBoard adapts.
  for (const id of Object.keys(sources).slice(1)) {
    const changed = plugin(imports);
    assert.throws(
      () => changed.transform("const RECOVERY_DATABASE = 'canvaslide'\n", id),
      /CanvaSlide source changed/,
    );
    const twice = plugin(imports);
    assert.throws(
      () => twice.transform(sources[id] + sources[id], id),
      /CanvaSlide source changed/,
    );
  }
});

test("연결 지점 하나라도 실행되지 않은 빌드는 완료되지 않는다", async () => {
  const complete = plugin(imports);
  const importer = `${upstreamRoot}/src/renderer/src/App.tsx`;
  await complete.resolveId("@/platform/document-file-access", importer);
  await complete.resolveId("@/platform/cloud-share", importer);
  for (const [id, code] of Object.entries(sources))
    complete.transform(code, id);
  complete.buildEnd();
  assert.deepEqual(complete.errors, []);

  // The editor no longer imports its share module: nothing would be replaced.
  const partial = plugin(imports);
  await partial.resolveId("@/platform/document-file-access", importer);
  for (const [id, code] of Object.entries(sources)) partial.transform(code, id);
  assert.throws(
    () => partial.buildEnd(),
    /adapter hooks did not run: replace:cloud-share/,
  );
  // A build that already failed keeps its own error.
  plugin(imports).buildEnd(new Error("earlier"));
});

test("고정한 원본은 전체 SHA와 빌드 도구 버전으로 기록한다", () => {
  const pin = JSON.parse(
    readFileSync(
      resolve(graeboardRoot, "scripts/canvaslide/canvaslide-upstream.json"),
      "utf8",
    ),
  );
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  assert.match(pin.pnpm, /^\d+\.\d+\.\d+$/);
  assert.match(
    pin.repository,
    /^https:\/\/github\.com\/[^/]+\/CanvaSlide\.git$/,
  );
});
