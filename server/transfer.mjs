import { exportDocumentImages } from "./document-images.mjs";
import { memoContents } from "./memo-storage.mjs";
import { reportDocumentContents, readReport } from "./document-storage.mjs";
import { reportRevision } from "./report-editing.mjs";
import { withTaskDocuments } from "./task-documents.mjs";
import { filtersFor, currentFiltersFor } from "./filters.mjs";
import ExcelJS from "exceljs";
import { explicitStyle } from "../shared/formatting.js";
import {
  BORDER_SIDES,
  weekBoundaryStyles,
  withWeekBoundaries,
} from "../shared/borders.js";
import { checkWorkbookArchive } from "./archive.mjs";
import { profileSnapshot } from "./profiles.mjs";
import {
  encodeReport,
  decodeReport,
  requireUniqueReportName,
} from "./reports.mjs";
import multer from "multer";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  FONTS,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  normalizeFont,
  weeksForYear,
  weeksForPeriod,
  periodYears,
  mondayOf,
  todayKey,
  dateKey,
  displayValue,
  cell,
  safeSpreadsheetText,
  defaultView,
  savedFilter,
  viewLayout,
  fieldsFor,
  orderColumns,
  propertiesFor,
  propertyOption,
  sampleProperties,
  textMode,
  splitNames,
  canManageTeam,
  shortId,
} from "../shared/domain.js";
import {
  id,
  initialCells,
  now,
  json,
  parse,
  getTasks,
  insertTask,
  transaction,
  audit,
} from "./db.mjs";
import {
  requireThat,
  yearSchema,
  periodScopeSchema,
  styleSchema,
  dateSchema,
  viewSchema,
  validateCellValue,
} from "./validation.mjs";

const aliases = {
  category: ["분류", "category"],
  type: ["유형", "작업 유형", "type"],
  title: ["작업", "업무", "업무명", "작업명", "title"],
  description: ["설명", "내용", "description"],
  owner: ["팀원", "책임자", "담당자", "owner"],
  supporters: ["지원자", "supporters"],
  status: ["상태", "status"],
  progress: ["진척률", "진척도", "progress"],
  deadline: ["목표일", "기한", "deadline"],
  score: ["score"],
  current: ["current"],
  id: ["업무 ID", "id"],
};
// 예시 양식의 속성은 팀에 없어도 가져오기 열을 연결할 수 있다. 적용 시 정의를 추가한다.
const SAMPLE_PROPERTIES = sampleProperties();
export const stableId = (s) => {
  const h = createHash("sha256").update(s).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
function rawValue(c, warnings, label) {
  const v = c.value;
  if (v == null) return "";
  if (v instanceof Date) return dateKey(v);
  if (typeof v === "object") {
    if ("formula" in v || "sharedFormula" in v) {
      // ExcelJS's value getter omits falsy results; the result getter retains
      // cached zero and false values from the workbook.
      const result = c.result;
      if (result === undefined)
        warnings.push(`${label}: 수식 표시값이 없어 빈 값으로 가져옵니다.`);
      else warnings.push(`${label}: 수식은 표시값으로 변환합니다.`);
      return result instanceof Date ? dateKey(result) : (result ?? "");
    }
    if (v.richText) {
      warnings.push(`${label}: 부분 서식은 셀 기본 서식으로 변환합니다.`);
      return v.richText.map((r) => r.text).join("");
    }
    if (v.hyperlink) {
      const text = v.text?.richText
        ? v.text.richText.map((r) => r.text).join("")
        : String(v.text || "");
      return text === v.hyperlink || !text
        ? v.hyperlink
        : `${text} ${v.hyperlink}`;
    }
    if (v.error) {
      warnings.push(`${label}: 오류값 ${v.error}`);
      return v.error;
    }
  }
  return v;
}
function color(c) {
  if (c?.argb) return "#" + c.argb.slice(-6);
  return undefined;
}
function cellStyle(c, warnings, label) {
  const s = {};
  const f = c.font || {},
    a = c.alignment || {};
  if (f.color && !color(f.color))
    warnings.push(
      `${label}: 테마·인덱스 글자색은 기본색으로 변환합니다. 원본 색상을 확인하세요.`,
    );
  if (c.fill?.fgColor && !color(c.fill.fgColor))
    warnings.push(
      `${label}: 테마·인덱스 배경색은 직접 지정 RGB로 변환되지 않았습니다.`,
    );
  if (a.textRotation) warnings.push(`${label}: 글자 회전은 지원하지 않습니다.`);
  for (const side of BORDER_SIDES) {
    const b = c.border?.[side.toLowerCase()];
    if (!b?.style) continue;
    const styles = {
      thin: "solid",
      hair: "solid",
      medium: "medium",
      thick: "thick",
      dashed: "dashed",
      double: "double",
      dashDot: "dashed",
      dashDotDot: "dashed",
      mediumDashed: "dashed",
      mediumDashDot: "dashed",
      mediumDashDotDot: "dashed",
      slantDashDot: "dashed",
    };
    s[`border${side}`] = {
      style: styles[b.style] || "solid",
      color: color(b.color) || "#607984",
    };
    if (b.color && !color(b.color))
      warnings.push(`${label}: 테마·인덱스 테두리 색은 기본색으로 변환합니다.`);
  }
  if (c.border?.diagonal?.style)
    warnings.push(`${label}: 대각선 테두리는 지원하지 않습니다.`);
  if (color(f.color)) s.color = color(f.color);
  if (c.fill?.type === "pattern" && color(c.fill.fgColor))
    s.backgroundColor = color(c.fill.fgColor);
  if (f.bold) s.bold = true;
  if (f.italic) s.italic = true;
  if (f.strike) s.strike = true;
  if (f.underline) s.underline = true;
  if (f.size)
    s.fontSize = Math.max(
      MIN_FONT_SIZE,
      Math.min(MAX_FONT_SIZE, Math.round(f.size)),
    );
  if (f.name) {
    s.fontFamily = normalizeFont(f.name) || FONTS[0];
    if (!normalizeFont(f.name))
      warnings.push(`${label}: 글꼴 ${f.name} → ${FONTS[0]}`);
  }
  if (["left", "center", "right"].includes(a.horizontal))
    s.textAlign = a.horizontal;
  if (["top", "middle", "bottom"].includes(a.vertical))
    s.verticalAlign = a.vertical;
  if (a.wrapText) s.textMode = "wrap";
  return s;
}
function dateFromHeader(value, year) {
  if (value && typeof value === "object" && !(value instanceof Date))
    value = value.result ?? value.richText?.map((r) => r.text).join("") ?? "";
  if (value instanceof Date) return { date: dateKey(value), explicit: true };
  if (typeof value === "number" && value > 40000 && value < 60000)
    return {
      date: dateKey(new Date(Date.UTC(1899, 11, 30) + value * 86400000)),
      explicit: true,
    };
  const s = String(value ?? "");
  const full = s.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  const short = s.match(/(?:^|\s)(\d{1,2})\/(\d{1,2})(?:$|\s)/);
  if (full || short) {
    const date = full
      ? `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`
      : `${year}-${short[1].padStart(2, "0")}-${short[2].padStart(2, "0")}`;
    if (dateSchema.safeParse(date).success) return { date, explicit: !!full };
  }
  return null;
}
export const importSheetOptionsSchema = z
  .record(
    z.string().min(1).max(120),
    z
      .object({
        headerRow: z.number().int().min(1).max(20).optional(),
        startRow: z.number().int().min(1).max(20000).optional(),
        endRow: z.number().int().min(1).max(20000).optional(),
        columns: z
          .record(z.string().min(1).max(80), z.number().int().min(1).max(500))
          .optional(),
      })
      .strict(),
  )
  .refine(
    (options) => Object.keys(options).length <= 150,
    "시트 설정은 최대 150개입니다.",
  );

export async function inspectWorkbook(
  buffer,
  year,
  settings,
  sheetOptions = {},
) {
  sheetOptions = importSheetOptionsSchema.parse(sheetOptions);
  checkWorkbookArchive(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    requireThat(
      false,
      400,
      "XLSX 파일을 읽을 수 없습니다. 암호 없이 저장한 파일을 선택하세요.",
    );
  }
  requireThat(
    workbook.worksheets.length <= 150,
    400,
    "최대 150개 시트를 가져올 수 있습니다.",
  );
  const sheets = [];
  for (const sheet of workbook.worksheets) {
    if (sheet.name.startsWith("_weekly")) continue;
    requireThat(
      sheet.rowCount <= 20000 && sheet.columnCount <= 500,
      400,
      "시트가 너무 큽니다. 20,000행·500열 이내로 나누어 가져오세요.",
    );
    let headerRow = 1,
      best = 0,
      mapping = {};
    const options = sheetOptions[sheet.name] || {};
    for (let r = 1; r <= Math.min(20, sheet.rowCount); r++) {
      if (options.headerRow && options.headerRow !== r) continue;
      const m = {};
      sheet.getRow(r).eachCell((c, col) => {
        const text = String(c.text || "")
          .trim()
          .toLowerCase();
        for (const [key, names] of Object.entries(aliases))
          if (names.some((n) => n.toLowerCase() === text)) m[key] = col;
        for (const p of propertiesFor(settings))
          if (p.name.toLowerCase() === text) m[p.id] = col;
      });
      const score = Object.keys(m).length + (m.title ? 10 : 0);
      if (score > best) {
        best = score;
        headerRow = r;
        mapping = m;
      }
    }
    const headerRows = Array.from({ length: headerRow }, (_, i) => i + 1);
    if (
      mapping.title &&
      !sheet.getCell(headerRow + 1, mapping.title).text.trim()
    )
      headerRows.push(headerRow + 1);
    // Some exports put progress/deadline above or below the main header band.
    for (const r of headerRows)
      sheet.getRow(r).eachCell((c, col) => {
        if (Object.values(mapping).includes(col)) return;
        const text = String(c.text || "")
          .trim()
          .toLowerCase();
        for (const [key, names] of Object.entries(aliases))
          if (!mapping[key] && names.some((n) => n.toLowerCase() === text))
            mapping[key] = col;
        for (const p of propertiesFor(settings))
          if (!mapping[p.id] && p.name.toLowerCase() === text)
            mapping[p.id] = col;
      });
    for (const [key, col] of Object.entries(options.columns || {})) {
      requireThat(
        SAMPLE_PROPERTIES.some((p) => p.id === key) ||
          propertiesFor(settings).some((p) => p.id === key),
        400,
        "가져올 속성 연결을 확인하세요.",
      );
      mapping[key] = col;
    }
    requireThat(
      new Set(Object.values(mapping)).size === Object.keys(mapping).length,
      400,
      "한 원본 열을 여러 속성에 연결할 수 없습니다.",
    );
    const startRow = options.startRow || headerRow + 1;
    const endRow = Math.min(options.endRow || sheet.rowCount, sheet.rowCount);
    if (!mapping.title) {
      sheets.push({
        name: sheet.name,
        rows: [],
        mapping: {},
        warnings: [
          "작업 열을 찾지 못했습니다. 첫 20행 안에 작업·업무명·title 헤더를 추가하세요.",
        ],
        unresolved: [],
        hiddenWeeks: [],
      });
      continue;
    }
    requireThat(
      startRow > headerRow && startRow <= endRow + 1,
      400,
      "가져올 행 범위를 확인하세요.",
    );
    const weekMap = {},
      weekHeaders = [],
      hiddenWeeks = [],
      warnings = [],
      rows = [],
      unresolved = new Set();
    if (sheet.model.merges?.length)
      warnings.push(
        "병합 셀이 있습니다. 행 단위로 변환하므로 중복 업무·값을 원본과 대조하세요.",
      );
    if (sheet.conditionalFormattings?.length)
      warnings.push(
        "조건부 서식의 동적 표시색은 복제하지 않습니다. 원본과 색상을 대조하세요.",
      );
    const mapped = new Set(Object.values(mapping));
    for (let col = 1; col <= sheet.columnCount; col++) {
      if (mapped.has(col)) continue;
      for (const r of headerRows) {
        const date = dateFromHeader(sheet.getCell(r, col).value, year);
        if (date) {
          weekHeaders.push({ col, ...date });
          break;
        }
      }
    }
    // Anchor the last short date to the selected year, then follow December →
    // January boundaries backwards. Explicit years always remain authoritative.
    let following;
    for (const header of weekHeaders.toReversed()) {
      let date = header.date;
      if (!header.explicit && following) {
        let inferredYear = Number(following.slice(0, 4));
        if (Number(date.slice(5, 7)) - Number(following.slice(5, 7)) > 6)
          inferredYear--;
        date = `${inferredYear}${date.slice(4)}`;
      }
      following = date;
      const week = mondayOf(date);
      weekMap[header.col] = week;
      if (sheet.getColumn(header.col).hidden) hiddenWeeks.push(week);
    }
    if (Object.keys(weekMap).length !== new Set(Object.values(weekMap)).size)
      warnings.push(
        "같은 주차에 연결되는 열이 있습니다. 오른쪽 열 값으로 덮어쓰지 않고 충돌을 확인해야 합니다.",
      );
    for (let row = startRow; row <= endRow; row++) {
      const title = rawValue(
        sheet.getCell(row, mapping.title),
        warnings,
        `${sheet.name}!${row}`,
      );
      if (!String(title).trim() || String(title) === "작업") continue;
      const fields = {},
        cells = {};
      const rowWarnings = [],
        notes = [];
      for (const [key, col] of Object.entries(mapping)) {
        if (key === "id") continue;
        const c = sheet.getCell(row, col);
        const fieldType = (
          propertiesFor(settings).find((p) => p.id === key) ||
          SAMPLE_PROPERTIES.find((p) => p.id === key)
        )?.kind;
        let value = rawValue(c, rowWarnings, c.address);
        if (
          key === "progress" &&
          typeof value === "number" &&
          c.numFmt?.includes("%")
        )
          value = `${Number((value * 100).toPrecision(15))}%`;
        if (fieldType === "number" && value !== "") {
          if (String(value) === "완료") {
            fields.status = "완료";
            value = 100;
          } else if (String(value).includes("%"))
            value = Number(String(value).replace("%", ""));
          else if (typeof value === "number" && c.numFmt?.includes("%"))
            value *= 100;
          else if (Number.isFinite(Number(value))) value = Number(value);
          else {
            rowWarnings.push(
              `${c.address}: 숫자가 아닌 값은 설명에 보존합니다.`,
            );
            notes.push(`${key}: ${value}`);
            value = "";
          }
        }
        if (fieldType === "number" && value !== "" && !Number.isFinite(value)) {
          notes.push(`${key}: ${value}`);
          rowWarnings.push(
            `${c.address}: 범위를 벗어난 숫자는 설명에 보존합니다.`,
          );
          value = "";
        }
        if (
          fieldType === "date" &&
          value !== "" &&
          !dateSchema.safeParse(value).success
        ) {
          const v = String(value).match(/^(\d{1,2})[/.](\d{1,2})$/);
          const date = v
            ? `${year}-${v[1].padStart(2, "0")}-${v[2].padStart(2, "0")}`
            : "";
          if (dateSchema.safeParse(date).success) value = date;
          else {
            notes.push(`목표일: ${value}`);
            rowWarnings.push(
              `${c.address}: 날짜 형식을 확인할 수 없어 설명에 보존합니다.`,
            );
            value = "";
          }
        }
        if (fieldType !== "number") value = String(value);
        fields[key] = value;
        cells[key] = { value, style: cellStyle(c, rowWarnings, c.address) };
      }
      for (const [col, key] of Object.entries(weekMap)) {
        const c = sheet.getCell(row, Number(col)),
          v = rawValue(c, rowWarnings, c.address),
          style = cellStyle(c, rowWarnings, c.address);
        if (v !== "" || Object.keys(style).length) {
          if (cells[key])
            rowWarnings.push(
              `${c.address}: 중복 주차 ${key}는 첫 열을 보존합니다.`,
            );
          else cells[key] = { value: String(v), style };
        }
      }
      if (notes.length) {
        fields.description = [fields.description, ...notes]
          .filter(Boolean)
          .join("\n");
        cells.description = {
          value: fields.description,
          style: cells.description?.style || {},
        };
      }
      const ownerName = String(fields.owner || "").trim(),
        supporterNames = splitNames(fields.supporters);
      if (ownerName) unresolved.add(ownerName);
      supporterNames.forEach((n) => unresolved.add(n));
      for (const p of propertiesFor(settings).filter(
        (p) => p.kind === "member" && !["owner", "supporters"].includes(p.id),
      )) {
        splitNames(fields[p.id]).forEach((n) => unresolved.add(n));
      }
      rows.push({
        row,
        title: String(title),
        fields,
        cells,
        ownerName,
        supporterNames,
        hidden: !!sheet.getRow(row).hidden,
        height: sheet.getRow(row).height
          ? Math.min(
              500,
              Math.max(34, Math.round((sheet.getRow(row).height * 4) / 3)),
            )
          : undefined,
      });
      warnings.push(...rowWarnings);
    }
    const widths = {};
    for (const [key, col] of Object.entries(mapping)) {
      if (key !== "id" && sheet.getColumn(col).width)
        widths[key] = Math.min(
          850,
          Math.max(45, Math.round(sheet.getColumn(col).width * 7)),
        );
    }
    for (const [col, key] of Object.entries(weekMap)) {
      if (sheet.getColumn(Number(col)).width)
        widths[key] = Math.min(
          850,
          Math.max(45, Math.round(sheet.getColumn(Number(col)).width * 7)),
        );
    }
    const visibleFields = Object.entries(mapping)
      .filter(
        ([key, col]) =>
          key !== "id" && (key === "title" || !sheet.getColumn(col).hidden),
      )
      .map(([key]) => key);
    sheets.push({
      name: sheet.name,
      widths,
      visibleFields,
      headerRow,
      startRow,
      endRow,
      mapping,
      weekMap,
      rows,
      warnings: [...new Set(warnings)],
      unresolved: [...unresolved],
      hiddenWeeks: [...new Set(hiddenWeeks)],
      sourceHidden: sheet.state !== "visible",
    });
  }
  return sheets;
}
function excelStyle(style) {
  return {
    border: Object.fromEntries(
      BORDER_SIDES.flatMap((side) => {
        const b = style[`border${side}`];
        if (!b || b.style === "none") return [];
        return [
          [
            side.toLowerCase(),
            {
              style: b.style === "solid" ? "thin" : b.style,
              color: { argb: "FF" + b.color.slice(1).toUpperCase() },
            },
          ],
        ];
      }),
    ),
    font: {
      name: style.fontFamily || FONTS[0],
      size: style.fontSize || 9,
      bold: !!style.bold,
      italic: !!style.italic,
      strike: !!style.strike,
      underline: !!style.underline,
      color: { argb: "FF" + (style.color || "#243642").slice(1).toUpperCase() },
    },
    alignment: {
      horizontal: style.textAlign || "left",
      vertical: style.verticalAlign || "middle",
      wrapText: textMode(style) === "wrap",
    },
    ...(style.backgroundColor
      ? {
          fill: {
            type: "pattern",
            pattern: "solid",
            fgColor: {
              argb: "FF" + style.backgroundColor.slice(1).toUpperCase(),
            },
          },
        }
      : {}),
  };
}
export async function makeWorkbook(tasks, keys, users, year, settings) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GraeBoard";
  const ws = wb.addWorksheet(String(year), {
    views: [{ state: "frozen", xSplit: Math.min(3, keys.length), ySplit: 1 }],
  });
  const labels = fieldLabels(settings);
  ws.columns = keys.map((k) => ({
    header: labels.get(k) || k,
    key: k,
    width: k === "title" ? 42 : k === "description" ? 45 : 16,
  }));
  ws.getRow(1).font = {
    bold: true,
    color: { argb: "FF243642" },
    name: FONTS[0],
  };
  ws.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFEDF6F4" },
  };
  const argb = (hex) => "FF" + hex.slice(1).toUpperCase();
  const { color, backgroundColor } = settings.weekHeader || {};
  const boundaryStyles = weekBoundaryStyles(
    keys,
    settings.weekBorders,
    settings.currentWeekBorders,
    mondayOf(todayKey()),
  );
  keys.forEach((key, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
    const header = ws.getRow(1).getCell(i + 1);
    header.border = excelStyle(boundaryStyles.get(key) || {}).border;
    if (color)
      header.font = { ...ws.getRow(1).font, color: { argb: argb(color) } };
    if (backgroundColor)
      header.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: argb(backgroundColor) },
      };
  });
  for (const t of tasks) {
    const r = ws.addRow(keys.map((k) => displayValue(t, k, users, settings)));
    const styles = withWeekBoundaries(
      keys,
      keys.map((key) => cell(t, key).style),
      boundaryStyles,
      keys.map((key) => explicitStyle(t, key)),
    );
    keys.forEach((k, i) => {
      const property = propertiesFor(settings).find((p) => p.id === k);
      const option = propertyOption(property, t.cells[k]?.value);
      r.getCell(i + 1).style = excelStyle({
        ...(property?.display !== "emoji" && option
          ? { backgroundColor: option.backgroundColor }
          : {}),
        ...styles[i],
      });
    });
  }
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, tasks.length + 1), column: keys.length },
  };
  return wb.xlsx.writeBuffer();
}
const fieldLabels = (settings) =>
  new Map(fieldsFor(settings).map((f) => [f.key, f.label]));
export function installTransferRoutes(
  app,
  {
    db,
    teamAccess,
    managedTeam,
    assignableUsers,
    referencedUsers,
    documentImagesDir,
  },
) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });
  app.post("/api/export", async (req, res) => {
    const d = z
      .object({
        teamId: z.string().uuid(),
        reportId: z.string().uuid().optional(),
        revision: z.string().optional(),
        year: yearSchema,
        startMonth: z.number().int().min(1).max(12).default(1),
        format: z.enum(["xlsx", "csv", "json"]),
        scope: z.enum(["view", "all"]),
        taskIds: z.array(z.string().uuid()).max(20000).default([]),
        keys: z.array(z.string()).max(150).optional(),
      })
      .parse(req.body);
    periodScopeSchema.parse(d);
    const team = teamAccess(req.user, d.teamId);
    const reportRow =
      d.reportId &&
      db
        .prepare("SELECT * FROM reports WHERE id=? AND team_id=?")
        .get(d.reportId, d.teamId);
    requireThat(!d.reportId || reportRow, 404, "사본을 찾을 수 없습니다.");
    requireThat(
      !reportRow || d.revision === reportRevision(reportRow.data),
      409,
      "사본이 변경되었습니다. 최신 내용을 확인한 뒤 내보내세요.",
    );
    const report = reportRow ? readReport(db, reportRow) : null;
    requireThat(
      !reportRow || d.year === reportRow.year,
      409,
      "사본의 표시 연도가 변경되었습니다. 다시 내보내세요.",
    );
    const startMonth =
      d.scope === "all" ? report?.view.startMonth || 1 : d.startMonth;
    const settings = report?.settings || team.settings;
    let tasks = report
      ? report.tasks
      : getTasks(db, d.teamId, periodYears(d.year, startMonth));
    if (d.scope === "view") {
      const selected = new Set(d.taskIds);
      const taskMap = new Map(tasks.map((t) => [t.id, t]));
      tasks = [...selected].map((id) => taskMap.get(id)).filter(Boolean);
      requireThat(
        tasks.length === selected.size,
        409,
        "일부 업무가 변경되었습니다. 다시 내보내세요.",
      );
    }
    const allowedKeys = orderColumns(
      fieldsFor(settings),
      weeksForPeriod(d.year, startMonth),
    ).map((column) => column.key);
    const keys = d.scope === "all" ? allowedKeys : d.keys || allowedKeys;
    requireThat(
      keys.length > 0 &&
        keys.every((k) => allowedKeys.includes(k)) &&
        new Set(keys).size === keys.length,
      400,
      "내보낼 열을 확인하세요.",
    );
    const users = report?.users || referencedUsers(d.teamId);
    audit(db, req.user.id, d.teamId, "export", id(), undefined, {
      format: d.format,
      scope: d.scope,
      count: tasks.length,
      ...(reportRow ? { reportId: reportRow.id, name: reportRow.name } : {}),
    });
    res.attachment(
      `graeboard-${d.year}${startMonth > 1 ? `-${d.year + 1}` : ""}.${d.format}`,
    );
    if (d.format === "xlsx")
      return res
        .type(
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .send(
          Buffer.from(await makeWorkbook(tasks, keys, users, d.year, settings)),
        );
    if (d.format === "csv") {
      const quote = (v) =>
        '"' + safeSpreadsheetText(v).replaceAll('"', '""') + '"';
      const labels = fieldLabels(settings);
      const rows = [
        keys.map((k) => labels.get(k) || k),
        ...tasks.map((t) =>
          keys.map((k) => displayValue(t, k, users, settings)),
        ),
      ];
      return res
        .type("text/csv; charset=utf-8")
        .send("\uFEFF" + rows.map((r) => r.map(quote).join(",")).join("\r\n"));
    }
    const reports =
      !report && canManageTeam(req.user, d.teamId) && d.scope === "all"
        ? db
            .prepare(
              "SELECT id,name,year,reference_date AS referenceDate,created_at AS createdAt,data FROM reports WHERE team_id=? AND year=?",
            )
            .all(d.teamId, d.year)
            .map(({ id, ...r }) => ({
              ...r,
              data: {
                ...reportDocumentContents(db, readReport(db, { id, ...r })),
                memos: memoContents(db, { reportId: id }),
              },
            }))
        : [];
    const views = report
      ? [{ name: "__current", data: viewLayout(report.view) }]
      : db
          .prepare(
            "SELECT name,data FROM views WHERE user_id=? AND team_id=? AND name='__current' AND year=?",
          )
          .all(req.user.id, d.teamId, d.year)
          .map((v) => ({
            ...v,
            data: viewLayout(parse(v.data)),
          }));
    const documentTasks = report
      ? reportDocumentContents(db, { ...report, tasks }).tasks
      : withTaskDocuments(db, tasks);
    const memos = memoContents(db, {
      reportId: reportRow?.id,
      teamId: d.teamId,
      year: d.year,
    });
    const documentImages = exportDocumentImages(documentImagesDir, [
      ...memos.map((memo) => memo.markdown),
      ...reports.flatMap((report) =>
        report.data.memos.map((memo) => memo.markdown),
      ),
      ...documentTasks.flatMap((task) =>
        (task.documents || []).map((doc) => doc.markdown),
      ),
      ...reports.flatMap((report) =>
        report.data.tasks.flatMap((task) =>
          (task.documents || []).map((doc) => doc.markdown),
        ),
      ),
    ]);
    res.type("application/json").send(
      json({
        format: "weekly-plan",
        schemaVersion: 6,
        exportedAt: now(),
        team: { ...team, settings },
        ...(reportRow
          ? { sheet: { id: reportRow.id, name: reportRow.name } }
          : {}),
        year: d.year,
        startMonth,
        documentImages,
        memos,
        tasks: documentTasks.map((t) =>
          d.scope === "all"
            ? t
            : {
                ...t,
                cells: Object.fromEntries(
                  Object.entries(t.cells).filter(([k]) => keys.includes(k)),
                ),
              },
        ),
        users: users.map(profileSnapshot),
        views,
        filters: report ? [] : filtersFor(db, req.user, team),
        currentFilters: report
          ? { selectedId: "", data: savedFilter(report.view, settings) }
          : currentFiltersFor(db, req.user, team),
        reports,
      }),
    );
  });
  app.post("/api/import/preview", upload.single("file"), async (req, res) => {
    const teamId = z.string().uuid().parse(req.body.teamId),
      year = yearSchema.parse(req.body.year);
    const team = managedTeam(
      req.user,
      teamId,
      "팀장만 자료를 가져올 수 있습니다.",
    );
    const reportId = z.string().uuid().optional().parse(req.body.reportId);
    const reportRow =
      reportId &&
      db
        .prepare("SELECT * FROM reports WHERE id=? AND team_id=?")
        .get(reportId, teamId);
    requireThat(!reportId || reportRow, 404, "사본을 찾을 수 없습니다.");
    const settings = reportRow
      ? decodeReport(reportRow.data).settings
      : team.settings;
    requireThat(req.file, 400, "가져올 XLSX 파일을 선택하세요.");
    requireThat(
      req.file.originalname.toLowerCase().endsWith(".xlsx"),
      400,
      "XLSX 파일을 선택하세요.",
    );
    const sheetOptions = importSheetOptionsSchema.parse(
      req.body.sheetOptions ? parse(req.body.sheetOptions) : {},
    );
    const optionsKey = Object.keys(sheetOptions).length
      ? json(
          Object.fromEntries(
            Object.entries(sheetOptions)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, options]) => [
                name,
                {
                  ...options,
                  columns: options.columns
                    ? Object.fromEntries(
                        Object.entries(options.columns).sort(([a], [b]) =>
                          a.localeCompare(b),
                        ),
                      )
                    : undefined,
                },
              ]),
          ),
        )
      : "";
    const importId = stableId(
      teamId +
        year +
        (reportId || "") +
        createHash("sha256").update(req.file.buffer).digest("hex") +
        optionsKey,
    );
    const existing = db
      .prepare("SELECT * FROM imports WHERE id=?")
      .get(importId);
    let sheets;
    if (existing) sheets = parse(existing.data);
    else {
      sheets = await inspectWorkbook(
        req.file.buffer,
        year,
        settings,
        sheetOptions,
      );
      if (reportId) sheets = sheets.map((sheet) => ({ ...sheet, reportId }));
      db.prepare(
        "INSERT INTO imports(id,team_id,actor_id,filename,data,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        importId,
        teamId,
        req.user.id,
        req.file.originalname,
        json(sheets),
        now(),
      );
    }
    const users = assignableUsers(teamId),
      personMap = {};
    sheets
      .flatMap((s) => s.unresolved)
      .forEach((name) => {
        const matches = users.filter((u) => u.name === name || u.id === name);
        if (matches.length === 1) personMap[name] = matches[0].id;
      });
    res.json({
      id: importId,
      alreadyApplied: !!existing?.applied_at,
      sheets: sheets.map((s) => ({
        ...s,
        rows: undefined,
        count: s.rows.length,
        preview: s.rows.slice(0, 5).map((r) => ({
          row: r.row,
          title: r.title,
          owner: r.ownerName,
          hidden: r.hidden,
        })),
        warnings: s.warnings.slice(0, 150),
        warningCount: s.warnings.length,
      })),
      personMap,
      users,
    });
  });
  app.post("/api/import/:id/exceptions", (req, res) => {
    const imp = db
      .prepare("SELECT * FROM imports WHERE id=?")
      .get(req.params.id);
    requireThat(imp, 404, "이관 기록을 찾을 수 없습니다.");
    managedTeam(req.user, imp.team_id);
    res
      .attachment("import-exceptions.json")
      .type("application/json")
      .send(
        json({
          filename: imp.filename,
          sheets: parse(imp.data).map((s) => ({
            name: s.name,
            warnings: s.warnings,
            unresolved: s.unresolved,
          })),
        }),
      );
  });
  app.post("/api/import/:id/apply", (req, res) => {
    const d = z
      .object({
        sheet: stringSchema(),
        year: yearSchema,
        personMap: z.record(z.string(), z.string().uuid()),
        mode: z.enum(["tasks", "report", "copy"]),
        reportId: z.string().uuid().optional(),
        revision: z.string().optional(),
        referenceDate: dateSchema,
        acceptWarnings: z.literal(true),
      })
      .parse(req.body);
    const imp = db
      .prepare("SELECT * FROM imports WHERE id=?")
      .get(req.params.id);
    requireThat(imp, 404, "이관 미리보기를 찾을 수 없습니다.");
    const team = managedTeam(req.user, imp.team_id);
    requireThat(
      (d.mode === "copy") === !!d.reportId,
      400,
      "가져올 시트를 확인하세요.",
    );
    const reportRow =
      d.reportId &&
      db
        .prepare("SELECT * FROM reports WHERE id=? AND team_id=?")
        .get(d.reportId, team.id);
    requireThat(!d.reportId || reportRow, 404, "사본을 찾을 수 없습니다.");
    const sheet = parse(imp.data).find((s) => s.name === d.sheet);
    requireThat(sheet?.rows.length, 400, "업무가 있는 시트를 선택하세요.");
    requireThat(
      (sheet.reportId || null) === (d.reportId || null),
      400,
      "미리보기와 반영할 시트가 다릅니다. 파일을 다시 선택하세요.",
    );
    const opKey = stableId(
        `${imp.id}:${d.sheet}:${d.mode}:${d.year}${d.reportId ? `:${d.reportId}` : ""}`,
      ),
      old = db.prepare("SELECT response FROM operations WHERE id=?").get(opKey);
    if (old) return res.json({ ...parse(old.response), repeated: true });
    requireThat(
      !reportRow ||
        (d.revision === reportRevision(reportRow.data) &&
          d.year === reportRow.year),
      409,
      "사본이 변경되었습니다. 최신 내용을 확인한 뒤 다시 가져오세요.",
    );
    const report = reportRow ? readReport(db, reportRow) : null;
    requireThat(
      !report || report.tasks.length + sheet.rows.length <= 20000,
      400,
      "사본에는 최대 20,000개 업무를 저장할 수 있습니다.",
    );
    const users = assignableUsers(team.id),
      ids = new Set(users.map((u) => u.id));
    for (const name of sheet.unresolved)
      requireThat(
        ids.has(d.personMap[name]),
        400,
        `담당자 “${name}” 연결을 확인하세요.`,
      );
    const result = transaction(db, () => {
      const reportName =
        d.mode === "report"
          ? requireUniqueReportName(db, team.id, sheet.name)
          : null;
      const tasks = [],
        hiddenRows = [],
        rowHeights = {};
      const settings = structuredClone(report?.settings || team.settings);
      const lastPosition = report
        ? Math.max(-1, ...report.tasks.map((task) => task.position))
        : 0;
      const importedKeys = new Set(
        sheet.rows.flatMap((r) => Object.keys(r.fields)),
      );
      for (const key of importedKeys) {
        if (settings.properties.some((p) => p.id === key)) continue;
        const definition = SAMPLE_PROPERTIES.find((p) => p.id === key);
        if (definition)
          settings.properties.push({ ...definition, visible: true });
      }
      for (const row of sheet.rows) {
        const taskId = stableId(`${opKey}:${row.row}`);
        const fields = {
          ...row.fields,
          owner: d.personMap[row.ownerName] || "",
        };
        // 지원자 열은 예시 양식에만 있으므로 팀에 정의된 경우에만 채운다.
        if (propertiesFor(settings).some((p) => p.id === "supporters"))
          fields.supporters = row.supporterNames.map((n) => d.personMap[n]);
        else delete fields.supporters;
        // 선택형 값은 이름으로 옵션을 찾아 ID로 저장한다. 없는 이름은 새 옵션으로 추가한다.
        for (const property of propertiesFor(settings).filter(
          (p) => p.kind === "option",
        )) {
          const text = String(fields[property.id] ?? "");
          if (!text) continue;
          let option = property.values.find(
            (v) => !v.archived && (v.label === text || v.id === text),
          );
          if (!option) {
            option = {
              id: shortId("o"),
              label: text,
              backgroundColor: "#edf6f4",
              dotColor: "#177b70",
              emoji: "📌",
            };
            property.values.push(option);
          }
          fields[property.id] = option.id;
        }
        for (const p of propertiesFor(settings).filter(
          (p) => p.kind === "member" && !["owner", "supporters"].includes(p.id),
        )) {
          if (fields[p.id] === undefined) continue;
          const names = splitNames(fields[p.id]);
          requireThat(
            p.multiple || names.length <= 1,
            400,
            `${p.name}: 한 명의 팀원을 선택하세요.`,
          );
          fields[p.id] = p.multiple
            ? [...new Set(names.map((n) => d.personMap[n]))]
            : d.personMap[names[0]] || "";
        }
        const cells = { ...row.cells };
        for (const [key, value] of Object.entries(fields))
          cells[key] = { value, style: cells[key]?.style || {} };
        for (const [key, c] of Object.entries(cells)) {
          styleSchema.parse(c.style);
          validateCellValue(db, team.id, key, c.value, settings);
          requireThat(
            String(c.value).length <= 10000,
            400,
            "10,000자를 넘는 셀이 있습니다. 원본을 나누어 가져오세요.",
          );
        }
        let task;
        if (d.mode === "tasks")
          task = insertTask(db, {
            taskId,
            teamId: team.id,
            year: d.year,
            actorId: req.user.id,
            cells,
          });
        else
          task = {
            id: taskId,
            teamId: team.id,
            years: [d.year],
            position: report ? lastPosition + tasks.length + 1 : row.row,
            createdBy: req.user.id,
            createdAt: now(),
            updatedAt: now(),
            defaultStyle: {},
            cells: Object.fromEntries(initialCells(cells)),
          };
        tasks.push(task);
        if (row.height) rowHeights[task.id] = row.height;
        if (row.hidden) hiddenRows.push(taskId);
      }
      const view = {
        ...defaultView(d.year),
        widths: sheet.widths || {},
        visibleFields: sheet.visibleFields || defaultView(d.year).visibleFields,
        rowHeights,
        hiddenRows,
        hiddenWeeks: sheet.hiddenWeeks.filter((k) =>
          weeksForYear(d.year).some((w) => w.key === k),
        ),
      };
      if (report) {
        const people = new Map(report.users.map((user) => [user.id, user]));
        for (const user of users)
          if (!people.has(user.id)) people.set(user.id, user);
        const nextView = {
          ...report.view,
          rowHeights: { ...report.view.rowHeights, ...rowHeights },
          hiddenRows: [...report.view.hiddenRows, ...hiddenRows],
        };
        db.prepare("UPDATE reports SET data=? WHERE id=?").run(
          encodeReport({
            ...report,
            tasks: [...report.tasks, ...tasks],
            settings,
            users: [...people.values()],
            view: nextView,
          }),
          reportRow.id,
        );
      } else if (d.mode === "report") {
        db.prepare("INSERT INTO reports VALUES(?,?,?,?,?,?,?,?)").run(
          id(),
          team.id,
          d.year,
          reportName,
          d.referenceDate,
          req.user.id,
          now(),
          encodeReport({
            tasks,
            users,
            view,
            settings,
          }),
        );
      } else {
        db.prepare("UPDATE teams SET settings=? WHERE id=?").run(
          json(settings),
          team.id,
        );
        db.prepare(
          "INSERT INTO views VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,team_id,year,name) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
        ).run(
          id(),
          req.user.id,
          team.id,
          d.year,
          "__current",
          json(viewLayout(view)),
          now(),
        );
      }
      const r = {
        count: tasks.length,
        warningCount: sheet.warnings.length,
        mode: d.mode,
        ...(reportRow ? { reportId: reportRow.id, name: reportRow.name } : {}),
      };
      db.prepare("INSERT INTO operations VALUES(?,?,?,?)").run(
        opKey,
        req.user.id,
        json(r),
        now(),
      );
      db.prepare("UPDATE imports SET applied_at=?,result=? WHERE id=?").run(
        now(),
        json(r),
        imp.id,
      );
      audit(db, req.user.id, team.id, "import", imp.id, undefined, {
        ...r,
        sheet: sheet.name,
      });
      return r;
    });
    res.json(result);
  });
}
function stringSchema() {
  return z.string().min(1).max(120);
}
