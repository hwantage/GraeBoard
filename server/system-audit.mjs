import { z } from "zod";
import { parse } from "./db.mjs";
import { dateSchema, requireThat } from "./validation.mjs";

const PAGE_SIZE = 50;
const querySchema = z
  .object({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    actorId: z.string().uuid().optional(),
    action: z.string().trim().min(1).max(80).optional(),
    cursorAt: z.string().datetime({ precision: 3 }).optional(),
    cursorId: z.string().uuid().optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: "종료 날짜는 시작 날짜 이후여야 합니다.",
  })
  .refine((q) => !!q.cursorAt === !!q.cursorId, {
    message: "페이지 위치가 올바르지 않습니다.",
  });

export function installSystemAuditRoutes(app, { db, requireSystemAdmin }) {
  app.get("/api/admin/audit", (req, res) => {
    requireSystemAdmin(req.user);
    const query = querySchema.parse(req.query);
    const where = ["a.team_id IS NULL"];
    const params = [];
    if (query.from) {
      where.push("a.created_at >= ?");
      params.push(new Date(`${query.from}T00:00:00+09:00`).toISOString());
    }
    if (query.to) {
      where.push("a.created_at < ?");
      params.push(
        new Date(
          Date.parse(`${query.to}T00:00:00+09:00`) + 86400000,
        ).toISOString(),
      );
    }
    for (const [field, value] of [
      ["actor_id", query.actorId],
      ["action", query.action],
    ]) {
      if (value) {
        where.push(`a.${field} = ?`);
        params.push(value);
      }
    }
    if (query.cursorAt) {
      where.push("(a.created_at,a.id) < (?,?)");
      params.push(query.cursorAt, query.cursorId);
    }
    // Read only metadata here. Large before/after values are fetched on demand.
    const entries = db
      .prepare(
        `SELECT a.id,a.actor_id AS actorId,a.action,a.target,a.created_at AS createdAt,
          u.name AS actor,u.username AS actorUsername,
          target_user.name AS targetName,target_user.username AS targetUsername
        FROM audit a JOIN users u ON u.id=a.actor_id
        LEFT JOIN users target_user ON target_user.id=a.target
          AND a.action IN ('login','logout','profile','password','user-create','user-update')
        WHERE ${where.join(" AND ")}
        ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,
      )
      .all(...params, PAGE_SIZE + 1);
    const hasMore = entries.length > PAGE_SIZE;
    if (hasMore) entries.pop();
    const last = entries.at(-1);
    res.json({
      entries,
      nextCursor: hasMore ? { createdAt: last.createdAt, id: last.id } : null,
    });
  });

  app.get("/api/admin/audit/:id", (req, res) => {
    requireSystemAdmin(req.user);
    const id = z.string().uuid().parse(req.params.id);
    const entry = db
      .prepare(
        "SELECT before_json,after_json FROM audit WHERE id=? AND team_id IS NULL",
      )
      .get(id);
    requireThat(entry, 404, "로그가 없거나 이력 정리로 삭제되었습니다.");
    res.json({
      before: parse(entry.before_json),
      after: parse(entry.after_json),
    });
  });
}
