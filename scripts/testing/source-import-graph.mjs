import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { build } from "esbuild";

export async function sourceImportGraph(root, directories) {
  function files(directory) {
    if (!existsSync(resolve(root, directory))) return [];
    return readdirSync(resolve(root, directory), {
      withFileTypes: true,
    }).flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return files(path);
      return entry.isFile() &&
        /\.(?:mjs|[jt]sx?)$/.test(path) &&
        !path.endsWith(".d.ts")
        ? [path]
        : [];
    });
  }
  const entries = directories.flatMap(files);
  if (!entries.length) throw new Error("No source files to check");
  const { metafile } = await build({
    absWorkingDir: root,
    entryPoints: entries,
    bundle: true,
    write: false,
    treeShaking: false,
    format: "esm",
    outdir: resolve(root, ".import-graph-unused"),
    metafile: true,
    logLevel: "silent",
    plugins: [
      {
        name: "imports-only",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) =>
            args.kind === "entry-point"
              ? undefined
              : { path: args.path, external: true },
          );
        },
      },
    ],
  });
  const graph = new Map();
  for (const [path, input] of Object.entries(metafile.inputs)) {
    const targets = input.imports.map(({ path: value }) => {
      if (!value.startsWith(".")) return value;
      // Vite's CSS-as-text import is still a dependency on that exact asset.
      // Keep all other queries unresolved; in particular, queries must never
      // hide a JS runtime edge from the layer/cycle checks.
      const asset = value.replace(/\.css\?inline$/, ".css");
      const target = resolve(root, dirname(path), asset);
      // Bundler resolution supports extensionless TS/JS and .js specifiers for TS.
      const candidates = [target];
      if (!extname(target))
        candidates.push(
          ...[
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".mjs",
            "/index.ts",
            "/index.tsx",
            "/index.js",
          ].map((extension) => target + extension),
        );
      if (/\.jsx?$/.test(target))
        candidates.push(
          target.replace(/\.js$/, ".ts").replace(/\.jsx$/, ".tsx"),
        );
      const found = candidates.find(
        (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
      );
      if (!found)
        throw new Error(`Unresolved local import: ${path} -> ${value}`);
      return relative(root, found).replaceAll("\\", "/");
    });
    graph.set(path.replaceAll("\\", "/"), targets);
  }
  return graph;
}
