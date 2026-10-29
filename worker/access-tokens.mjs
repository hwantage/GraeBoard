import { controlTransaction } from "./data.mjs";
import { assert } from "./access.mjs";
import { siteTeamId } from "../shared/sync-profiles.js";
import {
  accessTokenId,
  MAX_ACCESS_TOKENS,
  prepareAccessToken,
  revealAccessToken,
} from "../server/storage/access-token-service.mjs";

const columns = 'id,name,prefix,created_at AS "createdAt"';
export async function accessTokenRoutes(ctx, path, method, body) {
  const list = path === "/access-tokens";
  const reveal = path.match(/^\/access-tokens\/([^/]+)\/reveal$/);
  const match = path.match(/^\/access-tokens\/([^/]+)$/);
  if (
    !(list && ["GET", "POST"].includes(method)) &&
    !(match && method === "DELETE") &&
    !(reveal && method === "GET")
  )
    return;
  const prepared =
    method === "POST"
      ? await prepareAccessToken(body, {
          userId: ctx.user.id,
          key: ctx.env.GRAEBOARD_ACCESS_TOKEN_KEY,
        })
      : null;
  const targetId =
    match || reveal ? accessTokenId.parse((match || reveal)[1]) : null;
  return controlTransaction(
    ctx.env,
    async (tx) => {
      assert(
        tx.schemaVersion >= (siteTeamId(ctx.env) ? 3 : 2),
        503,
        "접속 토큰 기능을 사용하려면 DB 업데이트가 필요합니다.",
      );
      assert(
        (
          await tx.query("SELECT 1 FROM users WHERE id=$1 AND active=TRUE", [
            ctx.user.id,
          ])
        ).rowCount,
        401,
        "로그인이 필요합니다.",
      );
      if (reveal) {
        const row = (
          await tx.query(
            "SELECT * FROM access_tokens WHERE id=$1 AND user_id=$2",
            [targetId, ctx.user.id],
          )
        ).rows[0];
        assert(row, 404, "접속 토큰을 찾을 수 없습니다.");
        return {
          token: await revealAccessToken(
            row,
            ctx.env.GRAEBOARD_ACCESS_TOKEN_KEY,
          ),
        };
      }
      if (method === "GET")
        return {
          tokens: (
            await tx.query(
              `SELECT ${columns} FROM access_tokens WHERE user_id=$1 ORDER BY created_at DESC,id`,
              [ctx.user.id],
            )
          ).rows,
        };
      let metadata;
      if (prepared) {
        metadata = prepared.metadata;
        assert(
          !(
            await tx.query("SELECT 1 FROM access_tokens WHERE id=$1", [
              metadata.id,
            ])
          ).rowCount,
          409,
          "이미 처리된 토큰 생성 요청입니다. 목록을 다시 불러온 뒤 눈 아이콘으로 토큰을 확인하세요.",
        );
        assert(
          Number(
            (
              await tx.query(
                "SELECT COUNT(*) n FROM access_tokens WHERE user_id=$1",
                [ctx.user.id],
              )
            ).rows[0].n,
          ) < MAX_ACCESS_TOKENS,
          400,
          `접속 토큰은 최대 ${MAX_ACCESS_TOKENS}개까지 보관할 수 있습니다. 사용하지 않는 토큰을 삭제하세요.`,
        );
        await tx.query(
          "INSERT INTO access_tokens(id,user_id,name,token_hash,prefix,created_at,token_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            metadata.id,
            ctx.user.id,
            metadata.name,
            prepared.hash,
            metadata.prefix,
            metadata.createdAt,
            prepared.ciphertext,
          ],
        );
      } else {
        metadata = (
          await tx.query(
            `SELECT ${columns} FROM access_tokens WHERE id=$1 AND user_id=$2`,
            [targetId, ctx.user.id],
          )
        ).rows[0];
        assert(metadata, 404, "접속 토큰을 찾을 수 없습니다.");
        await tx.query("DELETE FROM access_tokens WHERE id=$1 AND user_id=$2", [
          targetId,
          ctx.user.id,
        ]);
      }
      await tx.query(
        "INSERT INTO control_audit(id,actor_id,action,target,payload,created_at) VALUES($1,$2,$3,$4,$5,$6)",
        [
          crypto.randomUUID(),
          ctx.user.id,
          prepared ? "access-token-create" : "access-token-delete",
          metadata.id,
          JSON.stringify(metadata),
          new Date().toISOString(),
        ],
      );
      return prepared ? { ...metadata, token: prepared.token } : { ok: true };
    },
    { write: method !== "GET" },
  );
}
