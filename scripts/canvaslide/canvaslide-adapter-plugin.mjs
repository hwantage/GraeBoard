// Vite plugin GraeBoard adds to the unmodified CanvaSlide web build. It loads
// the frame module with the editor entry, routes the editor's file and share
// modules through GraeBoard's adapters, and scopes browser recovery storage.
// Every hook names the upstream source it depends on and fails the build when
// that source is gone, so an incompatible upstream never ships silently.
import { resolve } from "node:path";

const UPSTREAM = "graeboard-upstream:";
const SHARED = "@graeboard/";

export function graeboardCanvaslideAdapter({ graeboardRoot, upstreamRoot }) {
  const frame = resolve(graeboardRoot, "scripts/canvaslide/frame");
  const platform = resolve(upstreamRoot, "src/renderer/src/platform");
  const replaced = {
    "document-file-access": {
      upstream: resolve(platform, "document-file-access.ts"),
      adapter: resolve(frame, "slide-frame-file-access.ts"),
    },
    "cloud-share": {
      upstream: resolve(platform, "cloud-share.ts"),
      adapter: resolve(frame, "slide-frame-cloud-share.ts"),
    },
  };
  const host = JSON.stringify(resolve(frame, "slide-frame-host.ts"));
  const scoped = (replace) => (code) => {
    const replaced = replace(code);
    return replaced === null
      ? null
      : `import { recoveryScopeSuffix as graeboardRecoveryScope } from ${host};\n${replaced}`;
  };
  const once = (code, from, to) => {
    if (code.split(from).length !== 2) return null;
    return code.replace(from, to);
  };
  // Patch only these upstream UI entry points. A renamed/missing target must
  // stop the build instead of exposing local file commands in a team editor.
  const hostedControls =
    (edits, imports = "hosted") =>
    (code) => {
      for (const [from, to] of edits) {
        const next = once(code, from, to);
        if (next === null) return null;
        code = next;
      }
      return `import { ${imports} } from ${host};\n${code}`;
    };
  const renderer = resolve(upstreamRoot, "src/renderer/src");
  const transforms = [
    {
      file: resolve(upstreamRoot, "src/renderer/src/main.tsx"),
      apply: (code) =>
        `import ${JSON.stringify(resolve(frame, "slide-frame-main.ts"))};\n${code}`,
    },
    {
      file: resolve(renderer, "components/toolbar/top-bar.tsx"),
      apply: hostedControls([
        [
          "{compact ? (\n        <ActionMenu\n          label={t('menu.file')}",
          "{hosted ? null : compact ? (\n        <ActionMenu\n          label={t('menu.file')}",
        ],
        [
          '{!compact && <div className="mx-1 h-5 w-px bg-border" />}\n      <div className="flex items-center gap-1">',
          '{!hosted && !compact && <div className="mx-1 h-5 w-px bg-border" />}\n      <div className="flex items-center gap-1">',
        ],
        [
          "<input\n          aria-label={t('file.documentName')}",
          "{!hosted && <input\n          aria-label={t('file.documentName')}",
        ],
        [
          "/>\n        {dirty && !compact && (",
          "/>}\n        {!hosted && dirty && !compact && (",
        ],
      ]),
    },
    {
      file: resolve(renderer, "hooks/use-document-commands.ts"),
      apply: hostedControls(
        [
          [
            "() => ({\n      saveDocument: () =>",
            "() => hosted ? teamFileCommands : ({\n      saveDocument: () =>",
          ],
        ],
        "hosted, teamFileCommands",
      ),
    },
    {
      file: resolve(renderer, "components/panels/cloud-share-dialog.tsx"),
      apply: hostedControls([
        [
          "{ name: `.${DOCUMENT_FILE_EXTENSION}`, run: () => void commands.saveDocumentAs() },",
          "...(hosted ? [] : [{ name: `.${DOCUMENT_FILE_EXTENSION}`, run: () => void commands.saveDocumentAs() }]),",
        ],
      ]),
    },
    {
      file: resolve(platform, "recovery-database.ts"),
      apply: scoped((code) =>
        once(
          code,
          "const DATABASE_NAME = 'canvaslide-recovery'",
          "const DATABASE_NAME = 'canvaslide-recovery' + graeboardRecoveryScope",
        ),
      ),
    },
    {
      file: resolve(platform, "recovery-session.ts"),
      apply: scoped((code) =>
        once(
          code,
          "const LOCK_PREFIX = 'canvaslide.recovery.session.'",
          "const LOCK_PREFIX = 'canvaslide.recovery.session' + graeboardRecoveryScope + '.'",
        ),
      ),
    },
  ];
  const used = new Set();
  const plain = (id) => id.split("?")[0];
  return {
    name: "graeboard:canvaslide-adapter",
    enforce: "pre",
    buildStart() {
      this.emitFile({
        type: "chunk",
        id: resolve(frame, "slide-card-render.ts"),
        fileName: "thumbnail.js",
        preserveSignature: "strict",
      });
    },
    async resolveId(source, importer, options) {
      if (source.startsWith(UPSTREAM)) {
        const target = replaced[source.slice(UPSTREAM.length)];
        if (!target) this.error(`Unknown upstream module: ${source}`);
        return target.upstream;
      }
      if (source.startsWith(SHARED))
        return resolve(graeboardRoot, source.slice(SHARED.length));
      if (!importer) return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      if (!resolved) return null;
      for (const [name, target] of Object.entries(replaced))
        if (plain(resolved.id) === target.upstream) {
          used.add(`replace:${name}`);
          return target.adapter;
        }
      return resolved;
    },
    transform(code, id) {
      const transform = transforms.find((entry) => entry.file === plain(id));
      if (!transform) return null;
      const result = transform.apply(code);
      if (result === null)
        this.error(
          `CanvaSlide source changed: ${transform.file} no longer has the text GraeBoard adapts`,
        );
      used.add(`transform:${transform.file}`);
      return { code: result, map: null };
    },
    buildEnd(error) {
      if (error) return;
      const expected = [
        ...Object.keys(replaced).map((name) => `replace:${name}`),
        ...transforms.map((entry) => `transform:${entry.file}`),
      ];
      const missing = expected.filter((key) => !used.has(key));
      if (missing.length)
        this.error(
          `CanvaSlide source changed: GraeBoard adapter hooks did not run: ${missing.join(", ")}`,
        );
    },
  };
}
