import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { requireThat } from "../shared/validation.js";

const keys = new WeakMap();
export function accessTokenKey(db) {
  if (process.env.GRAEBOARD_ACCESS_TOKEN_KEY)
    return process.env.GRAEBOARD_ACCESS_TOKEN_KEY;
  if (keys.has(db)) return keys.get(db);
  const file = db
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main")?.file;
  let key;
  if (file) {
    const path = join(dirname(file), "access-token.key");
    try {
      key = readFileSync(path, "utf8").trim();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      requireThat(
        !db
          .prepare(
            "SELECT 1 FROM access_tokens WHERE token_ciphertext IS NOT NULL LIMIT 1",
          )
          .get(),
        503,
        "접속 토큰 암호화 키 파일이 없습니다. 기존 서버의 키 파일을 복원하세요.",
      );
      key = randomBytes(32).toString("base64");
      try {
        writeFileSync(path, key + "\n", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        key = readFileSync(path, "utf8").trim();
      }
    }
  } else key = randomBytes(32).toString("base64");
  keys.set(db, key);
  return key;
}
