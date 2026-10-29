import { audit, transaction } from "./db.mjs";
import { requireThat } from "../shared/validation.js";
import {
  accessTokenId,
  MAX_ACCESS_TOKENS,
  prepareAccessToken,
  revealAccessToken,
} from "./storage/access-token-service.mjs";

import { accessTokenKey } from "./access-token-key.mjs";

const columns = "id,name,prefix,created_at AS createdAt";
export function installAccessTokenRoutes(app, { db }) {
  app.get("/api/access-tokens", (req, res) => {
    res.json({
      tokens: db
        .prepare(
          `SELECT ${columns} FROM access_tokens WHERE user_id=? ORDER BY created_at DESC,id`,
        )
        .all(req.user.id),
    });
  });
  app.post("/api/access-tokens", async (req, res) => {
    const prepared = await prepareAccessToken(req.body, {
      userId: req.user.id,
      key: accessTokenKey(db),
    });
    const token = transaction(db, () => {
      requireThat(
        db
          .prepare("SELECT 1 FROM users WHERE id=? AND active=1")
          .get(req.user.id),
        401,
        "로그인이 필요합니다.",
      );
      requireThat(
        !db
          .prepare("SELECT 1 FROM access_tokens WHERE id=?")
          .get(prepared.metadata.id),
        409,
        "이미 처리된 토큰 생성 요청입니다. 목록을 다시 불러온 뒤 눈 아이콘으로 토큰을 확인하세요.",
      );
      requireThat(
        db
          .prepare("SELECT COUNT(*) n FROM access_tokens WHERE user_id=?")
          .get(req.user.id).n < MAX_ACCESS_TOKENS,
        400,
        `접속 토큰은 최대 ${MAX_ACCESS_TOKENS}개까지 보관할 수 있습니다. 사용하지 않는 토큰을 삭제하세요.`,
      );
      const { id, name, prefix, createdAt } = prepared.metadata;
      db.prepare(
        "INSERT INTO access_tokens(id,user_id,name,token_hash,prefix,created_at,token_ciphertext) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        req.user.id,
        name,
        prepared.hash,
        prefix,
        createdAt,
        prepared.ciphertext,
      );
      audit(
        db,
        req.user.id,
        null,
        "access-token-create",
        id,
        undefined,
        prepared.metadata,
      );
      return prepared.metadata;
    });
    res.status(201).json({ ...token, token: prepared.token });
  });
  app.get("/api/access-tokens/:id/reveal", async (req, res) => {
    const id = accessTokenId.parse(req.params.id);
    const row = db
      .prepare("SELECT * FROM access_tokens WHERE id=? AND user_id=?")
      .get(id, req.user.id);
    requireThat(row, 404, "접속 토큰을 찾을 수 없습니다.");
    const token = await revealAccessToken(row, accessTokenKey(db));
    requireThat(
      db
        .prepare(
          "SELECT 1 FROM access_tokens t JOIN users u ON u.id=t.user_id WHERE t.id=? AND t.user_id=? AND u.active=1",
        )
        .get(id, req.user.id),
      404,
      "접속 토큰을 찾을 수 없습니다.",
    );
    res.json({ token });
  });
  app.delete("/api/access-tokens/:id", (req, res) => {
    const id = accessTokenId.parse(req.params.id);
    transaction(db, () => {
      const token = db
        .prepare(
          `SELECT ${columns} FROM access_tokens WHERE id=? AND user_id=?`,
        )
        .get(id, req.user.id);
      requireThat(token, 404, "접속 토큰을 찾을 수 없습니다.");
      db.prepare("DELETE FROM access_tokens WHERE id=? AND user_id=?").run(
        id,
        req.user.id,
      );
      audit(db, req.user.id, null, "access-token-delete", id, token);
    });
    res.json({ ok: true });
  });
}
