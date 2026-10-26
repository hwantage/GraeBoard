import { z } from "zod";
import { dateSchema, requireThat } from "../validation.mjs";
import { isSystemAdmin, todayKey } from "../../shared/domain.js";
const auditQuerySchema = z
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

const previewSchema = z
  .object({
    scopeId: z.union([z.string().uuid(), z.literal("system")]),
    beforeDate: dateSchema,
  })
  .strict();
const cleanupSchema = z
  .object({ token: z.string().uuid(), confirmed: z.literal(true) })
  .strict();
export class AdminHistoryBusinessService {
  constructor(repository, user) {
    this.repository = repository;
    this.user = user;
  }
  admin() {
    requireThat(
      isSystemAdmin(this.user),
      403,
      "시스템 관리자 권한이 필요합니다.",
    );
  }
  audit(query) {
    this.admin();
    return this.repository.audit(
      this.user,
      auditQuerySchema.parse(
        query instanceof URLSearchParams ? Object.fromEntries(query) : query,
      ),
    );
  }
  auditEntry(id) {
    this.admin();
    return this.repository.auditEntry(this.user, z.string().uuid().parse(id));
  }
  storage() {
    this.admin();
    return this.repository.storage(this.user);
  }
  preview(query) {
    this.admin();
    const input = previewSchema.parse(
      query instanceof URLSearchParams ? Object.fromEntries(query) : query,
    );
    requireThat(
      input.beforeDate >= "2000-01-01" && input.beforeDate <= todayKey(),
      400,
      "기준 날짜는 2000년 1월 1일부터 오늘까지 선택하세요.",
    );
    return this.repository.preview(this.user, input);
  }
  cleanup(body) {
    this.admin();
    return this.repository.cleanup(this.user, cleanupSchema.parse(body));
  }
}
