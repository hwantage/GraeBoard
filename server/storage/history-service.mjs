import { z } from "zod";
const uuid = z.string().uuid();
export const historyQuerySchema = z.object({
  teamId: uuid,
  taskId: uuid.optional(),
  sheetId: z.union([z.literal("original"), uuid]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const historyRestoreSchema = z
  .object({
    revision: z.string().optional(),
    formatRevision: z.number().int().nonnegative().optional(),
    versions: z.record(z.string(), z.number().int().nonnegative()).optional(),
  })
  .strict();
export class HistoryBusinessService {
  constructor(repository, user, { clientId } = {}) {
    this.repository = repository;
    this.user = user;
    this.clientId = clientId;
  }
  query(query) {
    return this.repository.query(
      this.user,
      query instanceof URLSearchParams ? Object.fromEntries(query) : query,
    );
  }
  restore(id, body = {}) {
    return this.repository.restore(this.user, String(id), body, {
      clientId: this.clientId,
    });
  }
}
