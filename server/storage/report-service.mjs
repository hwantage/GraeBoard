import { requireThat } from "../../shared/validation.js";
import { z } from "zod";
import {
  yearSchema,
  reportNameSchema,
  dateSchema,
  viewSchema,
} from "../../shared/validation.js";
import { editSchema } from "./report-command-schema.mjs";
const reportCreateSchema = z.object({
  id: z.string().uuid().optional(),
  teamId: z.string().uuid(),
  year: yearSchema,
  name: reportNameSchema,
  sourceId: z.string().uuid().optional(),
  referenceDate: dateSchema,
  view: viewSchema,
  taskIds: z.array(z.string().uuid()).max(20000),
});
const renameSchema = z
  .object({ name: reportNameSchema, expectedName: z.string().max(120) })
  .strict();
const removeSchema = z
  .object({
    teamId: z.string().uuid(),
    ids: z.array(z.string().uuid()).min(1).max(20000),
  })
  .strict();
export class ReportBusinessService {
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
      for (const reportId of changes?.reportIds || [])
        this.documentEvents?.invalidate("report:" + reportId, this.clientId);
      return value;
    };
    return result && typeof result.then === "function"
      ? result.then(done)
      : done(result);
  }
  watch(reportId) {
    return this.repository.watchRevision(this.user, reportId);
  }
  list(query) {
    return this.repository.list(this.user, {
      teamId: String(query.teamId || ""),
    });
  }
  create(input) {
    const request = reportCreateSchema.parse(input);
    this.repository.authorizeCreate?.(this.user, request);
    requireThat(
      request.year === request.view.year,
      400,
      "보고 연도와 보기의 연도가 일치해야 합니다.",
    );
    return this.mutate("create", [request]);
  }
  read(reportId) {
    return this.repository.read(this.user, reportId);
  }
  rename(reportId, input) {
    return this.mutate("rename", [reportId, renameSchema.parse(input)]);
  }
  edit(reportId, input) {
    return this.mutate("edit", [reportId, editSchema.parse(input)]);
  }
  remove(input) {
    return this.mutate("remove", [removeSchema.parse(input)]);
  }
}
