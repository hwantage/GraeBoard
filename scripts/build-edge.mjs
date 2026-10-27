import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { generateTransferCore } from "./build-worker.mjs";

await generateTransferCore();
await mkdir("supabase/functions/graeboard", { recursive: true });
const pkg = JSON.parse(await readFile("package-lock.json", "utf8"));
const packages = ["pg", "jose", "zod", "diff", "exceljs"];
await build({
  entryPoints: ["edge/main.mjs"],
  outfile: "supabase/functions/graeboard/index.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  inject: ["edge/globals.mjs"],
  external: ["node:*"],
  loader: { ".md": "text" },
  plugins: [
    {
      name: "deno-npm",
      setup(builder) {
        builder.onResolve(
          { filter: /^(pg|jose|zod|diff|exceljs)(\/.*)?$/ },
          ({ path }) => {
            const name = packages.find(
              (p) => path === p || path.startsWith(p + "/"),
            );
            return {
              path: `npm:${name}@${pkg.packages["node_modules/" + name].version}${path.slice(name.length)}`,
              external: true,
            };
          },
        );
      },
    },
  ],
});
console.log("Built Supabase Edge Function from shared API modules.");
