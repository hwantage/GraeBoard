import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

export function backupDatabase(source, destination) {
  source = resolve(source);
  destination = resolve(destination);
  if (!existsSync(source)) throw new Error("백업할 데이터베이스가 없습니다.");
  if (existsSync(destination))
    throw new Error("백업 파일이 이미 있습니다. 다른 이름을 지정하세요.");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = destination + ".partial";
  if (existsSync(temporary)) throw new Error("진행 중인 백업 파일이 있습니다.");
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=10000");
    db.prepare("VACUUM INTO ?").run(temporary);
    chmodSync(temporary, 0o600);
    const verify = new DatabaseSync(temporary, { readOnly: true });
    try {
      if (
        verify.prepare("PRAGMA integrity_check").get().integrity_check !== "ok"
      )
        throw new Error("백업 무결성 검사에 실패했습니다.");
    } finally {
      verify.close();
    }
    renameSync(temporary, destination);
    return destination;
  } catch (e) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw e;
  } finally {
    db.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const path = backupDatabase(
      process.env.DB_PATH || "data/weekly-plan.sqlite",
      process.argv[2] ||
        `backups/graeboard-${new Date().toISOString().replaceAll(":", "-")}.sqlite`,
    );
    console.log(`백업 검증 완료: ${path}`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
