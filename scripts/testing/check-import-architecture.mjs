import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceImportGraph } from "./source-import-graph.mjs";

const roots = ["src", "shared", "server", "worker", "edge", "functions"];
const builtins = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "")),
);

export async function checkImportArchitecture(root) {
  const graph = await sourceImportGraph(root, roots);
  const violations = [];
  for (const [source, targets] of graph) {
    for (const target of targets) {
      if (
        source.startsWith("src/ui/") &&
        target.startsWith("src/") &&
        !target.startsWith("src/ui/")
      )
        violations.push(
          `UI must not depend on a feature or platform: ${source} -> ${target}`,
        );
      if (
        source.startsWith("src/platform/") &&
        target.startsWith("src/") &&
        !target.startsWith("src/platform/")
      )
        violations.push(
          `Platform must not depend on a screen: ${source} -> ${target}`,
        );
      if (
        source.startsWith("src/") &&
        !source.startsWith("src/app/") &&
        source !== "src/main.tsx" &&
        target.startsWith("src/app/")
      )
        violations.push(
          `Features must not import app composition: ${source} -> ${target}`,
        );
    }
  }
  const visited = new Set();
  function browser(source, chain) {
    if (visited.has(source)) return;
    visited.add(source);
    for (const target of graph.get(source) || []) {
      const path = [...chain, source, target].join(" -> ");
      if (
        /^(?:server|worker|edge|functions)\//.test(target) ||
        target.startsWith("node:") ||
        builtins.has(target)
      )
        violations.push(
          `Browser dependency crosses a runtime boundary: ${path}`,
        );
      if (graph.has(target)) browser(target, [...chain, source]);
    }
  }
  for (const source of graph.keys())
    if (source.startsWith("src/")) browser(source, []);

  // Tarjan SCCs: report all cyclic modules, including a module importing itself.
  let index = 0;
  const indices = new Map(),
    low = new Map(),
    stack = [],
    pending = new Set();
  function visit(source) {
    indices.set(source, index);
    low.set(source, index++);
    stack.push(source);
    pending.add(source);
    for (const target of graph.get(source) || []) {
      if (!graph.has(target)) continue;
      if (!indices.has(target)) {
        visit(target);
        low.set(source, Math.min(low.get(source), low.get(target)));
      } else if (pending.has(target))
        low.set(source, Math.min(low.get(source), indices.get(target)));
    }
    if (low.get(source) !== indices.get(source)) return;
    const members = [];
    let member;
    do {
      member = stack.pop();
      pending.delete(member);
      members.push(member);
    } while (member !== source);
    if (members.length > 1 || graph.get(source)?.includes(source))
      violations.push(`Runtime import cycle: ${members.sort().join(" <-> ")}`);
  }
  for (const source of graph.keys()) if (!indices.has(source)) visit(source);
  return { modules: graph.size, violations: violations.sort() };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = await checkImportArchitecture(root);
  for (const violation of result.violations) console.error(violation);
  console.log(
    `Import architecture: ${result.modules} modules, ${result.violations.length} violations`,
  );
  if (result.violations.length) process.exitCode = 1;
}
