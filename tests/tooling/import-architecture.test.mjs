import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkImportArchitecture } from "../../scripts/testing/check-import-architecture.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "graeboard-imports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    put(path, source) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    },
    check: () => checkImportArchitecture(root),
  };
}

test("current runtime modules have no cycles, reversed frontend layers or browser host dependencies", async () => {
  const result = await checkImportArchitecture(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  assert.ok(
    result.modules > 300,
    "the real application source must be collected",
  );
  assert.deepEqual(result.violations, []);
});

test("real UI reexports, platform dynamic imports and feature imports cannot point back at composition", async (t) => {
  const f = fixture(t);
  f.put("src/app/App.tsx", "export default function App() { return null; }");
  f.put("src/ui/BoundaryProbe.tsx", 'export { default } from "../app/App";');
  f.put(
    "src/platform/load-screen.ts",
    'export const screen = () => import("../app/App");',
  );
  f.put(
    "src/sheet/SheetProbe.tsx",
    'import App from "../app/App"; export const sheet = () => App();',
  );
  const { violations } = await f.check();
  assert.ok(
    violations.some(
      (message) =>
        message.startsWith("UI must not") &&
        message.includes("BoundaryProbe.tsx"),
    ),
  );
  assert.ok(
    violations.some(
      (message) =>
        message.startsWith("Platform must not") &&
        message.includes("load-screen.ts"),
    ),
  );
  assert.ok(
    violations.some(
      (message) =>
        message.startsWith("Features must not") &&
        message.includes("SheetProbe.tsx"),
    ),
  );
});

test("browser dependency checks follow shared modules to both Node builtins and backend hosts", async (t) => {
  const f = fixture(t);
  f.put(
    "src/calendar/CalendarProbe.ts",
    'export * from "../../shared/calendar-probe.js";',
  );
  f.put(
    "shared/calendar-probe.js",
    'export * from "../server/host-probe.mjs"; export { readFile } from "node:fs/promises";',
  );
  f.put("server/host-probe.mjs", "export const host = true;");
  const { violations } = await f.check();
  assert.ok(
    violations.some(
      (message) =>
        message.includes("Browser dependency") &&
        message.includes("node:fs/promises"),
    ),
  );
  assert.ok(
    violations.some(
      (message) =>
        message.includes("Browser dependency") &&
        message.includes("server/host-probe.mjs"),
    ),
  );
});

test("a repository-to-host runtime cycle and a self import are rejected", async (t) => {
  const f = fixture(t);
  f.put(
    "worker/control/control.mjs",
    'export { record } from "../storage/control/postgres-control.mjs"; export const host = 1;',
  );
  f.put(
    "worker/storage/control/postgres-control.mjs",
    'import { host } from "../../control/control.mjs"; export const record = () => host;',
  );
  f.put(
    "shared/self.js",
    'export { own as again } from "./self.js"; export const own = 1;',
  );
  const { violations } = await f.check();
  assert.equal(
    violations.filter((message) => message.startsWith("Runtime import cycle:"))
      .length,
    2,
  );
  assert.ok(
    violations.some(
      (message) =>
        message.includes("control/control.mjs") &&
        message.includes("postgres-control.mjs"),
    ),
  );
});

test("type-only cycles do not become runtime cycles and .js specifiers resolve to TypeScript", async (t) => {
  const f = fixture(t);
  f.put(
    "src/sheet/first.ts",
    'import type { Second } from "./second.js"; export type First = { second?: Second }; export const first = 1;',
  );
  f.put(
    "src/sheet/second.ts",
    'import type { First } from "./first"; export type Second = { first?: First }; export { first } from "./first.js";',
  );
  assert.deepEqual((await f.check()).violations, []);
});

test("an unresolved local runtime import fails instead of silently losing a graph edge", async (t) => {
  const f = fixture(t);
  f.put("src/sheet/missing.ts", 'export * from "./absent";');
  await assert.rejects(
    f.check(),
    /Unresolved local import: src\/sheet\/missing.ts -> .\/absent/,
  );
});
