import { z } from "zod";
import {
  yearSchema,
  periodScopeSchema,
  dateSchema,
  requireThat,
  styleSchema,
  validateCellValue,
} from "../../shared/validation.js";
import {
  propertiesFor,
  sampleProperties,
  splitNames,
} from "../../shared/domain.js";
const uuid = z.string().uuid();
const exportSchema = z.object({
  teamId: uuid,
  reportId: uuid.optional(),
  revision: z.string().optional(),
  year: yearSchema,
  startMonth: z.number().int().min(1).max(12).default(1),
  format: z.enum(["xlsx", "csv", "json"]),
  scope: z.enum(["view", "all"]),
  taskIds: z.array(uuid).max(20000).default([]),
  keys: z.array(z.string()).max(150).optional(),
});
const applyImportSchema = z.object({
  sheet: z.string().min(1).max(120),
  year: yearSchema,
  personMap: z.record(z.string(), uuid),
  mode: z.enum(["tasks", "report", "copy"]),
  reportId: uuid.optional(),
  revision: z.string().optional(),
  referenceDate: dateSchema,
  acceptWarnings: z.literal(true),
});
const previewSchema = z.object({
  teamId: uuid,
  year: yearSchema,
  reportId: uuid.optional(),
  sheetOptions: z.record(z.string(), z.unknown()).default({}),
  file: z.object({ name: z.string().min(1), bytes: z.instanceof(Uint8Array) }),
});
export class TransferBusinessService {
  constructor(repository, user, { clientId } = {}) {
    this.repository = repository;
    this.user = user;
    this.clientId = clientId;
  }
  export(input) {
    const request = exportSchema.parse(input);
    periodScopeSchema.parse(request);
    return this.repository.export(this.user, request);
  }
  preview(input) {
    const teamId = uuid.parse(input.teamId),
      year = yearSchema.parse(input.year);
    this.repository.authorizePreview?.(this.user, { ...input, teamId, year });
    requireThat(input.file, 400, "가져올 XLSX 파일을 선택하세요.");
    requireThat(
      typeof input.file.name === "string" &&
        input.file.name.toLowerCase().endsWith(".xlsx"),
      400,
      "XLSX 파일을 선택하세요.",
    );
    let options = input.sheetOptions || {};
    if (typeof options === "string") {
      try {
        options = JSON.parse(options);
      } catch {
        requireThat(false, 400, "시트 설정 형식을 확인하세요.");
      }
    }
    const request = previewSchema.parse({ ...input, sheetOptions: options });
    requireThat(
      request.file.name.toLowerCase().endsWith(".xlsx") &&
        request.file.bytes.byteLength > 0 &&
        request.file.bytes.byteLength <= 25 * 1024 * 1024,
      400,
      "25MiB 이하 XLSX 파일을 선택하세요.",
    );
    return this.repository.preview(this.user, request);
  }
  exceptions(importId) {
    return this.repository.exceptions(this.user, String(importId));
  }
  apply(importId, body) {
    return this.repository.apply(
      this.user,
      String(importId),
      applyImportSchema.parse(body),
      { clientId: this.clientId },
    );
  }
}
export const transferDownload = (body, contentType, filename) => ({
  body,
  contentType,
  filename,
});
export function extendImportProperties(settings, rows) {
  for (const key of new Set(rows.flatMap((row) => Object.keys(row.fields))))
    if (!settings.properties.some((p) => p.id === key)) {
      const definition = sampleProperties().find((p) => p.id === key);
      if (definition)
        settings.properties.push({ ...definition, visible: true });
    }
}
export function prepareImportCells(
  row,
  { settings, personMap, allowed, teamId, optionId },
) {
  const fields = { ...row.fields, owner: personMap[row.ownerName] || "" };
  if (propertiesFor(settings).some((p) => p.id === "supporters"))
    fields.supporters = row.supporterNames.map((n) => personMap[n]);
  else delete fields.supporters;
  for (const property of propertiesFor(settings)) {
    if (property.kind === "option") {
      const text = String(fields[property.id] ?? "");
      if (!text) continue;
      let option = property.values.find(
        (v) => !v.archived && (v.label === text || v.id === text),
      );
      if (!option) {
        option = {
          id: optionId(property.id, text),
          label: text,
          backgroundColor: "#edf6f4",
          dotColor: "#177b70",
          emoji: "📌",
        };
        property.values.push(option);
      }
      fields[property.id] = option.id;
    }
    if (
      property.kind === "member" &&
      !["owner", "supporters"].includes(property.id) &&
      fields[property.id] !== undefined
    ) {
      const names = splitNames(fields[property.id]);
      requireThat(
        property.multiple || names.length <= 1,
        400,
        `${property.name}: 한 명의 팀원을 선택하세요.`,
      );
      fields[property.id] = property.multiple
        ? [...new Set(names.map((n) => personMap[n]))]
        : personMap[names[0]] || "";
    }
  }
  const cells = { ...row.cells };
  for (const [key, value] of Object.entries(fields))
    cells[key] = { value, style: cells[key]?.style || {} };
  for (const [key, c] of Object.entries(cells)) {
    styleSchema.parse(c.style);
    validateCellValue(null, teamId, key, c.value, settings, undefined, allowed);
    requireThat(
      String(c.value).length <= 10000,
      400,
      "10,000자를 넘는 셀이 있습니다. 원본을 나누어 가져오세요.",
    );
  }
  return cells;
}
