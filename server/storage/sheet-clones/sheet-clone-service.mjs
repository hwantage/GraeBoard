import { requireThat } from "../../../shared/validation.js";
import { z } from "zod";
import {
  yearSchema,
  sheetCloneNameSchema,
  dateSchema,
  viewSchema,
} from "../../../shared/validation.js";
import { editSchema } from "./sheet-clone-command-schema.mjs";
const sheetCloneCreateSchema = z.object({
  id: z.string().uuid().optional(),
  teamId: z.string().uuid(),
  year: yearSchema,
  name: sheetCloneNameSchema,
  sourceId: z.string().uuid().optional(),
  referenceDate: dateSchema,
  view: viewSchema,
  taskIds: z.array(z.string().uuid()).max(20000),
});
const renameSchema = z
  .object({ name: sheetCloneNameSchema, expectedName: z.string().max(120) })
  .strict();
const removeSchema = z
  .object({
    teamId: z.string().uuid(),
    ids: z.array(z.string().uuid()).min(1).max(20000),
  })
  .strict();
export class SheetCloneBusinessService {
  constructor(repository, user, { documentEvents, clientId } = {}) {
    this.repository = repository;
    this.user = user;
    this.documentEvents = documentEvents;
    this.clientId = clientId;
  }
  mutate(command, args) {
    const result = this.repository[command](this.user, ...args);
    const done = (value) => {
      this.repository.afterCommit?.(this.user, command, args, value, {
        clientId: this.clientId,
      });
      const changes = this.repository.resourceChanges?.();
      for (const teamId of changes?.teamIds || [])
        this.documentEvents?.invalidate("team:" + teamId, this.clientId);
      for (const sheetCloneId of changes?.sheetCloneIds || [])
        this.documentEvents?.invalidate(
          "sheet-clone:" + sheetCloneId,
          this.clientId,
        );
      return value;
    };
    return result && typeof result.then === "function"
      ? result.then(done)
      : done(result);
  }
  watch(sheetCloneId) {
    return this.repository.watchRevision(this.user, sheetCloneId);
  }
  list(query) {
    return this.repository.list(this.user, {
      teamId: String(query.teamId || ""),
    });
  }
  create(input) {
    const request = sheetCloneCreateSchema.parse(input);
    this.repository.authorizeCreate?.(this.user, request);
    requireThat(
      request.year === request.view.year,
      400,
      "보고 연도와 보기의 연도가 일치해야 합니다.",
    );
    return this.mutate("create", [request]);
  }
  read(sheetCloneId) {
    return this.repository.read(this.user, sheetCloneId);
  }
  rename(sheetCloneId, input) {
    return this.mutate("rename", [sheetCloneId, renameSchema.parse(input)]);
  }
  // `changes=1` answers the rows the edit changed instead of the whole copy:
  // the editor already holds the copy it edited.
  edit(sheetCloneId, input, query) {
    return this.mutate("edit", [
      sheetCloneId,
      editSchema.parse(input),
      { changes: query?.changes === "1" },
    ]);
  }
  remove(input) {
    return this.mutate("remove", [removeSchema.parse(input)]);
  }
}
