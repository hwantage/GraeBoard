import { z } from "zod";
import { savedFilter, propertiesFor, teamRole } from "../../shared/domain.js";
import { requireThat, savedFilterSchema } from "../validation.mjs";
const uuid = z.string().uuid(),
  name = z.string().trim().min(1).max(60);
export const filterQuerySchema = z.object({ teamId: uuid }).strict();
const current = z
  .object({
    teamId: uuid,
    selectedId: z.union([z.literal(""), uuid]),
    data: savedFilterSchema,
  })
  .strict();
const save = z
  .object({
    teamId: uuid,
    scope: z.enum(["team", "personal"]),
    name,
    data: savedFilterSchema,
  })
  .strict();
const update = z
  .object({ name: name.optional(), data: savedFilterSchema.optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.data !== undefined);
export function normalizeFilterInput(data, settings) {
  const keys = new Set(propertiesFor(settings).map((p) => p.id));
  requireThat(
    [
      ...Object.keys(data.propertyFilters || {}),
      ...Object.keys(data.propertyFilterModes || {}),
    ].every((key) => keys.has(key)),
    400,
    "이 팀의 속성 필터를 선택하세요.",
  );
  return savedFilter(data, settings);
}
export function canEditSavedFilter(user, teamId, scope) {
  return scope === "personal" || teamRole(user, teamId) === "lead";
}
export function requireFilterEditor(user, teamId, scope) {
  requireThat(
    canEditSavedFilter(user, teamId, scope),
    403,
    "팀 공용 필터는 팀장만 수정할 수 있습니다.",
  );
}
export function currentFilterSelection(filters, selectedId, data, settings) {
  const selected = filters.find((f) => f.id === selectedId);
  return {
    selectedId: selected?.id || "",
    data: selected?.data || savedFilter(data || {}, settings),
  };
}
export class FilterBusinessService {
  constructor(repository, user) {
    this.repository = repository;
    this.user = user;
  }
  list(query) {
    return this.repository.list(
      this.user,
      filterQuerySchema.parse(
        query instanceof URLSearchParams ? Object.fromEntries(query) : query,
      ),
    );
  }
  current(input) {
    return this.repository.current(this.user, current.parse(input));
  }
  save(input) {
    return this.repository.save(this.user, save.parse(input));
  }
  update(id, input) {
    return this.repository.update(
      this.user,
      uuid.parse(id),
      update.parse(input),
    );
  }
  remove(id) {
    return this.repository.remove(this.user, uuid.parse(id));
  }
}
