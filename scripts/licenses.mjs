import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")),
  packages = [],
  notices = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || entry.dev || !existsSync(join(path, "package.json"))) continue;
  const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  const files = readdirSync(path).filter((name) =>
    /^(license|licence|copying|ofl|notice)(\.[a-z]+)?$/i.test(name),
  );
  packages.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license || entry.license || "See package notice",
    noticeFiles: files,
  });
  for (const file of files) {
    try {
      const content = readFileSync(join(path, file), "utf8");
      notices.push(
        `${pkg.name} ${pkg.version} / ${file}\n${"=".repeat(72)}\n${content}\n`,
      );
    } catch {}
  }
}
packages.sort((a, b) => a.name.localeCompare(b.name));
mkdirSync("docs", { recursive: true });
writeFileSync(
  "docs/THIRD_PARTY_NOTICES.json",
  JSON.stringify({ generatedFrom: "package-lock.json", packages }, null, 2) +
    "\n",
);
writeFileSync(
  "docs/THIRD_PARTY_NOTICES.txt",
  notices
    .join("\n")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd() + "\n",
);
console.log(
  `운영 의존성 ${packages.length}개 및 제공된 고지문 ${notices.length}개를 기록했습니다.`,
);
