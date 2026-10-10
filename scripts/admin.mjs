import { existsSync, readFileSync } from "node:fs";
import {
  openDatabase,
  passwordHash,
  transaction,
  audit,
} from "../server/db.mjs";

// Password enters through stdin; it is never a CLI argument or log field.
const [action, username] = process.argv.slice(2),
  path = process.env.DB_PATH || "data/weekly-plan.sqlite";
if (action !== "reset-password" || !username || !existsSync(path)) {
  console.error(
    "사용법: 비밀번호를 표준입력으로 전달하여 npm run admin -- reset-password 아이디(이메일)",
  );
  process.exit(1);
}
const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
if (password.length < 10 || password.length > 128) {
  console.error("비밀번호는 10~128자여야 합니다.");
  process.exit(1);
}
const db = openDatabase(path);
try {
  const user = db
    .prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE")
    .get(username);
  if (!user) throw new Error("아이디(이메일)를 찾을 수 없습니다.");
  transaction(db, () => {
    db.prepare("UPDATE users SET password=? WHERE id=?").run(
      passwordHash(password),
      user.id,
    );
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
    audit(db, user.id, null, "password-reset-cli", user.id, undefined, {
      changed: true,
    });
  });
  console.log("비밀번호를 재설정하고 기존 로그인을 해제했습니다.");
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  db.close();
}
