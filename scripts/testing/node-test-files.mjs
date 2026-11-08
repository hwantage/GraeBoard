import { readdirSync } from "node:fs";
import { join } from "node:path";

// Do not follow links or treat helper/fixture trees as executable suites.
export function listNodeTestFiles(root) {
  const files = new Set();
  function visit(directory) {
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink()) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (
          entry.name !== "fixtures" &&
          path !== "tests/browser" &&
          path !== "tests/support"
        )
          visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
        files.add(path);
      }
    }
  }
  visit("tests");
  return [...files].sort();
}
