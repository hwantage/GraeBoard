import { z } from "zod";
const uuid = z.string().uuid();
const querySchema = z.object({
  teamId: uuid,
  taskId: uuid.optional(),
  sheetId: z.union([z.literal("original"), uuid]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const restoreSchema = z
  .object({
    revision: z.string().optional(),
    formatRevision: z.number().int().nonnegative().optional(),
    versions: z.record(z.string(), z.number().int().nonnegative()).optional(),
  })
  .strict();
export class HistoryBusinessService {
  constructor(repository, user) {
    this.repository = repository;
    this.user = user;
  }
  query(query) {
    return this.repository.query(
      this.user,
      querySchema.parse(
        query instanceof URLSearchParams ? Object.fromEntries(query) : query,
      ),
    );
  }
  restore(id, body = {}) {
    return this.repository.restore(
      this.user,
      uuid.parse(id),
      restoreSchema.parse(body),
    );
  }
}
