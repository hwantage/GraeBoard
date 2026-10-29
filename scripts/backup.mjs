import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { unfinishedJobError } from "../shared/backup-recovery.mjs";
import {
  databaseImageUrls,
  documentImagesDirectory,
  readDocumentImage,
  writeDocumentImage,
} from "../server/document-images.mjs";

export function backupDatabase(
  source,
  destination,
  { documentImagesDir = documentImagesDirectory() } = {},
) {
  source = resolve(source);
  destination = resolve(destination);
  if (!existsSync(source)) throw new Error("백업할 데이터베이스가 없습니다.");
  if (existsSync(destination) || existsSync(destination + ".images"))
    throw new Error("백업 파일이 이미 있습니다. 다른 이름을 지정하세요.");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = destination + ".partial";
  const images = destination + ".images";
  const temporaryImages = images + ".partial";
  if (existsSync(temporary) || existsSync(temporaryImages))
    throw new Error("진행 중인 백업 파일이 있습니다.");
  const db = new DatabaseSync(source, { readOnly: true });
  let guard;
  const jobs = [];
  try {
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_maintenance_jobs'",
        )
        .get()
    ) {
      guard = new DatabaseSync(source);
      guard.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      try {
        for (const link of guard
          .prepare("SELECT team_id FROM team_sync_links")
          .all()) {
          const unfinished = guard
            .prepare(
              "SELECT job_id,team_id,kind FROM site_maintenance_jobs WHERE team_id=? AND phase NOT IN ('complete','cancelled')",
            )
            .get(link.team_id);
          if (unfinished) throw unfinishedJobError(unfinished);
          const jobId = randomUUID();
          guard
            .prepare(
              "INSERT INTO site_maintenance_jobs VALUES(?,?,'backup','running','{}','{}',?)",
            )
            .run(jobId, link.team_id, new Date().toISOString());
          jobs.push(jobId);
        }
        guard.exec("COMMIT");
      } catch (error) {
        guard.exec("ROLLBACK");
        throw error;
      }
    }
    db.exec("PRAGMA busy_timeout=10000");
    db.prepare("VACUUM INTO ?").run(temporary);
    chmodSync(temporary, 0o600);
    const verify = new DatabaseSync(temporary);
    try {
      if (
        verify.prepare("PRAGMA integrity_check").get().integrity_check !== "ok"
      )
        throw new Error("백업 무결성 검사에 실패했습니다.");
      // Copy exactly the assets referenced by this consistent SQLite snapshot.
      // Asset files are immutable and retained while the application is running.
      const urls = databaseImageUrls(verify);
      for (const url of urls) {
        let bytes;
        try {
          bytes = readDocumentImage(documentImagesDir, url);
        } catch (error) {
          // A locally excluded canonical image may live only in the verified
          // Git archive. Read the backup's fixed head, never repopulate live files.
          const teamId = url.split("/")[3];
          const link =
            jobs.length &&
            verify
              .prepare(
                "SELECT profile_id,canonical_head FROM team_sync_links WHERE team_id=?",
              )
              .get(teamId);
          if (!link?.canonical_head) throw error;
          bytes = execFileSync(
            "git",
            [
              "-C",
              resolve(
                process.env.GRAEBOARD_SYNC_DIR || "data/sync",
                link.profile_id,
              ),
              "show",
              `${link.canonical_head}:${url.replace("/api/document-images/", "images/")}`,
            ],
            {
              maxBuffer: 11 * 1024 * 1024,
              timeout: 30000,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          if (
            createHash("sha256").update(bytes).digest("hex") !==
            url.split("/").at(-1).replace(".webp", "")
          )
            throw new Error("Archived image integrity failure");
        }
        writeDocumentImage(temporaryImages, url, bytes);
      }
      for (const job of jobs)
        verify
          .prepare(
            "UPDATE site_maintenance_jobs SET phase='complete' WHERE job_id=? AND kind='backup'",
          )
          .run(job);
    } finally {
      verify.close();
    }
    if (existsSync(temporaryImages)) renameSync(temporaryImages, images);
    renameSync(temporary, destination);
    return destination;
  } catch (e) {
    if (existsSync(temporary)) unlinkSync(temporary);
    rmSync(temporaryImages, { recursive: true, force: true });
    if (!existsSync(destination))
      rmSync(images, { recursive: true, force: true });
    throw e;
  } finally {
    if (guard) {
      for (const job of jobs)
        guard
          .prepare(
            "UPDATE site_maintenance_jobs SET phase='complete' WHERE job_id=? AND kind='backup'",
          )
          .run(job);
      guard.close();
    }
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
