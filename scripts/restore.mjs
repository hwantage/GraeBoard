import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  chmodSync,
  copyFileSync,
  constants,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SCHEMA_VERSION } from "../server/db.mjs";
import {
  databaseImageUrls,
  documentImagesDirectory,
  readDocumentImage,
  writeDocumentImage,
} from "../server/document-images.mjs";

// Restore into a NEW destination. Switching DB_PATH is a separate operator action.
export function restoreDatabase(
  backup,
  destination,
  { documentImagesDir = documentImagesDirectory() } = {},
) {
  backup = resolve(backup);
  destination = resolve(destination);
  if (existsSync(destination))
    throw new Error("복구 경로에 파일이 있습니다. 새로운 경로를 사용하세요.");
  const source = new DatabaseSync(backup, { readOnly: true });
  try {
    if (
      source.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
      source.prepare("PRAGMA user_version").get().user_version !==
        SCHEMA_VERSION
    )
      throw new Error("지원하는 정상 백업 파일이 아닙니다.");
    source.prepare("SELECT id FROM tasks LIMIT 1").all();
    const urls = databaseImageUrls(source);
    // Validate the entire bundle before publishing a database or any assets.
    for (const url of urls) readDocumentImage(backup + ".images", url);
    for (const url of urls)
      writeDocumentImage(
        documentImagesDir,
        url,
        readDocumentImage(backup + ".images", url),
      );
  } finally {
    source.close();
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = destination + ".partial";
  copyFileSync(backup, temporary, constants.COPYFILE_EXCL);
  chmodSync(temporary, 0o600);
  try {
    const restored = new DatabaseSync(temporary);
    try {
      restored.exec("DELETE FROM sessions");
    } finally {
      restored.close();
    }
    renameSync(temporary, destination);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  return destination;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 4)
      throw new Error("사용법: npm run restore -- 백업.sqlite 새경로.sqlite");
    console.log(
      `복구 검증 완료: ${restoreDatabase(process.argv[2], process.argv[3])}\n서버 중지 후 DB_PATH를 이 파일로 지정하여 재시작하세요. 기존 로그인은 해제됩니다.`,
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
