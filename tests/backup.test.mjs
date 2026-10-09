import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openDatabase,
  id,
  json,
  insertTask,
  now,
  passwordHash,
} from "../server/db.mjs";
import { DEFAULT_SETTINGS } from "../shared/domain.js";
import { backupDatabase } from "../scripts/backup.mjs";
import { restoreDatabase } from "../scripts/restore.mjs";
import { checkWorkbookArchive } from "../server/archive.mjs";
import ExcelJS from "exceljs";

test("실행 중 WAL 데이터베이스의 백업을 복구하고 기존 파일은 덮어쓰지 않는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "weekly-backup-")),
    src = join(dir, "source.sqlite"),
    backup = join(dir, "backup.sqlite"),
    target = join(dir, "restored.sqlite"),
    db = openDatabase(src),
    u = id(),
    team = id();
  try {
    db.prepare("INSERT INTO teams VALUES(?,?,?)").run(
      team,
      "복구 팀",
      json(DEFAULT_SETTINGS),
    );
    db.prepare(
      "INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      u,
      "admin",
      "관리자",
      passwordHash("backup-test-password"),
      "admin",
      now(),
    );
    db.prepare("INSERT INTO memberships VALUES(?,?)").run(u, team);
    db.prepare("UPDATE users SET avatar_initials=?,color=? WHERE id=?").run(
      "BK",
      "#888888",
      u,
    );
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      "session",
      u,
      Date.now() + 10000,
    );
    const task = insertTask(db, {
      teamId: team,
      year: 2026,
      actorId: u,
      fields: { title: "백업 검증" },
      cells: { "2026-10-05": { value: "일정", style: { color: "#ff2211" } } },
    });
    backupDatabase(src, backup);
    const original = readFileSync(backup);
    assert.throws(() => backupDatabase(src, backup), /이미/);
    assert.deepEqual(readFileSync(backup), original);
    db.prepare("UPDATE cells SET value=? WHERE task_id=? AND key=?").run(
      json("이후 변경"),
      task.id,
      "title",
    );
    restoreDatabase(backup, target);
    assert.throws(() => restoreDatabase(backup, target), /파일이/);
    const restored = new DatabaseSync(target, { readOnly: true });
    try {
      const profile = restored
        .prepare("SELECT avatar_initials,color FROM users WHERE id=?")
        .get(u);
      assert.equal(profile.avatar_initials, "BK");
      assert.equal(profile.color, "#888888");
      assert.equal(
        JSON.parse(
          restored
            .prepare("SELECT value FROM cells WHERE task_id=? AND key=?")
            .get(task.id, "title").value,
        ),
        "백업 검증",
      );
      assert.equal(
        restored.prepare("SELECT COUNT(*) AS n FROM sessions").get().n,
        0,
      );
      assert.equal(
        restored.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok",
      );
    } finally {
      restored.close();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("기존 계정과 업무를 유지하며 아바타 저장 열을 한 번만 추가한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "weekly-profile-migration-"));
  const path = join(dir, "legacy.sqlite");
  let db = openDatabase(path);
  try {
    db.exec(
      "ALTER TABLE users DROP COLUMN avatar_initials; ALTER TABLE users DROP COLUMN avatar_image; PRAGMA user_version=2;",
    );
    db.prepare(
      "INSERT INTO users(id,username,name,password,role,created_at) VALUES(?,?,?,?,?,?)",
    ).run("legacy-id", "legacy", "기존 이름", "unused", "member", now());
    db.close();
    db = openDatabase(path);
    assert.equal(
      db.prepare("SELECT name FROM users WHERE id='legacy-id'").get().name,
      "기존 이름",
    );
    assert.equal(
      db.prepare("SELECT avatar_initials FROM users WHERE id='legacy-id'").get()
        .avatar_initials,
      "",
    );
    db.prepare(
      "UPDATE users SET avatar_initials='김' WHERE id='legacy-id'",
    ).run();
    db.close();
    db = openDatabase(path);
    assert.equal(
      db.prepare("SELECT avatar_initials FROM users WHERE id='legacy-id'").get()
        .avatar_initials,
      "김",
    );
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("불완전 ZIP과 비정상 압축 해제 크기는 파싱 전에 거절한다", async () => {
  assert.throws(() => checkWorkbookArchive(Buffer.from("not an xlsx")), /XLSX/);
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("data").addRow(["작업"]);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  checkWorkbookArchive(buffer);
  const mutated = Buffer.from(buffer),
    directory = mutated.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  mutated.writeUInt32LE(0xffffffff, directory + 24);
  assert.throws(() => checkWorkbookArchive(mutated), /압축/);
});
