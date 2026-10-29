import { retentionView } from "../sync/visibility.mjs";
import { exportDocumentImages } from "../document-images.mjs";
import { memoContents } from "../memo-storage.mjs";
import { reportDocumentContents, readReport } from "../document-storage.mjs";
import { reportRevision } from "../report-editing.mjs";
import { withTaskDocuments } from "../task-documents.mjs";
import { filtersFor, currentFiltersFor } from "../filters.mjs";
import ExcelJS from "exceljs";
import { explicitStyle } from "../../shared/formatting.js";
import {
  BORDER_SIDES,
  weekBoundaryStyles,
  withWeekBoundaries,
} from "../../shared/borders.js";
import { checkWorkbookArchive } from "../archive.mjs";
import { profileSnapshot } from "../../shared/profiles.js";
import {
  encodeReport,
  decodeReport,
  requireUniqueReportName,
} from "../reports.mjs";
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
} from "../../shared/domain.js";
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
} from "../db.mjs";
import {
  requireThat,
  yearSchema,
  periodScopeSchema,
  styleSchema,
  dateSchema,
  viewSchema,
  validateCellValue,
} from "../../shared/validation.js";

import {
  inspectWorkbook,
  makeWorkbook,
  stableId,
  importSheetOptionsSchema,
} from "../../shared/workbook.mjs";
import {
  transferDownload,
  extendImportProperties,
  prepareImportCells,
} from "./transfer-service.mjs";
const fieldLabels = (settings) =>
  new Map(fieldsFor(settings).map((f) => [f.key, f.label]));
const stringSchema = () => z.string().min(1).max(120);
export class SqliteTransferRepository {
  constructor(options) {
    Object.assign(this, options);
  }
  async export(user, input) {
    const { db, teamAccess, referencedUsers, documentImagesDir } = this;
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
      .parse(input);
    periodScopeSchema.parse(d);
    const team = teamAccess(user, d.teamId);
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
    if (reportRow)
      retentionView(db, d.teamId).requireVisible("report", [reportRow.id]);
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
    const visibility = retentionView(db, d.teamId);
    tasks = visibility.tasks(tasks, reportRow?.id);
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
    audit(db, user.id, d.teamId, "export", id(), undefined, {
      format: d.format,
      scope: d.scope,
      count: tasks.length,
      ...(reportRow ? { reportId: reportRow.id, name: reportRow.name } : {}),
    });
    const filename = `graeboard-${d.year}${startMonth > 1 ? `-${d.year + 1}` : ""}.${d.format}`;
    if (d.format === "xlsx")
      return transferDownload(
        Buffer.from(await makeWorkbook(tasks, keys, users, d.year, settings)),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename,
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
      return transferDownload(
        "\uFEFF" + rows.map((r) => r.map(quote).join(",")).join("\r\n"),
        "text/csv; charset=utf-8",
        filename,
      );
    }
    const reports =
      !report && canManageTeam(user, d.teamId) && d.scope === "all"
        ? db
            .prepare(
              "SELECT id,name,year,reference_date AS referenceDate,created_at AS createdAt,data FROM reports WHERE team_id=? AND year=?",
            )
            .all(d.teamId, d.year)
            .filter((row) => !visibility.hidden("report", [row.id]))
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
          .all(user.id, d.teamId, d.year)
          .map((v) => ({
            ...v,
            data: viewLayout(parse(v.data)),
          }));
    const documentTasks = visibility.tasks(
      report
        ? reportDocumentContents(db, { ...report, tasks }).tasks
        : withTaskDocuments(db, tasks),
      reportRow?.id,
    );
    const memos = visibility.documents(
      memoContents(db, {
        reportId: reportRow?.id,
        teamId: d.teamId,
        year: d.year,
      }),
      reportRow ? ["reportMemo", reportRow.id] : ["annual", String(d.year)],
    );
    for (const saved of reports) {
      const original = db
        .prepare("SELECT id FROM reports WHERE team_id=? AND name=?")
        .get(d.teamId, saved.name);
      if (original) {
        saved.data.tasks = visibility.tasks(saved.data.tasks, original.id);
        saved.data.memos = visibility.documents(saved.data.memos, [
          "reportMemo",
          original.id,
        ]);
      }
    }
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
    return transferDownload(
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
        filters: report ? [] : filtersFor(db, user, team),
        currentFilters: report
          ? { selectedId: "", data: savedFilter(report.view, settings) }
          : currentFiltersFor(db, user, team),
        reports,
      }),
      "application/json",
      filename,
    );
  }
  authorizePreview(user, input) {
    this.managedTeam(user, input.teamId, "팀장만 자료를 가져올 수 있습니다.");
    const reportId = z.string().uuid().optional().parse(input.reportId);
    requireThat(
      !reportId ||
        this.db
          .prepare("SELECT 1 FROM reports WHERE id=? AND team_id=?")
          .get(reportId, input.teamId),
      404,
      "사본을 찾을 수 없습니다.",
    );
  }
  async preview(user, input) {
    const { db, managedTeam, assignableUsers } = this;
    const teamId = z.string().uuid().parse(input.teamId),
      year = yearSchema.parse(input.year);
    const team = managedTeam(user, teamId, "팀장만 자료를 가져올 수 있습니다.");
    const reportId = z.string().uuid().optional().parse(input.reportId);
    const reportRow =
      reportId &&
      db
        .prepare("SELECT * FROM reports WHERE id=? AND team_id=?")
        .get(reportId, teamId);
    requireThat(!reportId || reportRow, 404, "사본을 찾을 수 없습니다.");
    const visibility = retentionView(db, teamId);
    requireThat(
      !visibility.years.has(String(year)),
      409,
      "이 사이트에서 정리한 연도입니다. 먼저 복원하세요.",
    );
    if (reportRow) visibility.requireVisible("report", [reportRow.id]);
    const settings = reportRow
      ? decodeReport(reportRow.data).settings
      : team.settings;
    requireThat(input.file, 400, "가져올 XLSX 파일을 선택하세요.");
    requireThat(
      input.file.name.toLowerCase().endsWith(".xlsx"),
      400,
      "XLSX 파일을 선택하세요.",
    );
    const sheetOptions = importSheetOptionsSchema.parse(input.sheetOptions);
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
        createHash("sha256").update(input.file.bytes).digest("hex") +
        optionsKey,
    );
    const existing = db
      .prepare("SELECT * FROM imports WHERE id=?")
      .get(importId);
    let sheets;
    if (existing) sheets = parse(existing.data);
    else {
      sheets = await inspectWorkbook(
        Buffer.from(input.file.bytes),
        year,
        settings,
        sheetOptions,
      );
      if (reportId) sheets = sheets.map((sheet) => ({ ...sheet, reportId }));
      db.prepare(
        "INSERT INTO imports(id,team_id,actor_id,filename,data,created_at) VALUES(?,?,?,?,?,?)",
      ).run(importId, teamId, user.id, input.file.name, json(sheets), now());
    }
    const users = assignableUsers(teamId),
      personMap = {};
    sheets
      .flatMap((s) => s.unresolved)
      .forEach((name) => {
        const matches = users.filter((u) => u.name === name || u.id === name);
        if (matches.length === 1) personMap[name] = matches[0].id;
      });
    return {
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
    };
  }
  exceptions(user, importId) {
    const { db, managedTeam } = this;
    const imp = db.prepare("SELECT * FROM imports WHERE id=?").get(importId);
    requireThat(imp, 404, "이관 기록을 찾을 수 없습니다.");
    managedTeam(user, imp.team_id);
    return transferDownload(
      json({
        filename: imp.filename,
        sheets: parse(imp.data).map((s) => ({
          name: s.name,
          warnings: s.warnings,
          unresolved: s.unresolved,
        })),
      }),
      "application/json",
      "import-exceptions.json",
    );
  }
  apply(user, importId, input, { clientId } = {}) {
    const { db, managedTeam, assignableUsers } = this;
    const work = () => {
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
        .parse(input);
      const imp = db.prepare("SELECT * FROM imports WHERE id=?").get(importId);
      requireThat(imp, 404, "이관 미리보기를 찾을 수 없습니다.");
      const team = managedTeam(user, imp.team_id);
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
      const visibility = retentionView(db, team.id);
      requireThat(
        !visibility.years.has(String(d.year)),
        409,
        "이 사이트에서 정리한 연도입니다. 먼저 복원하세요.",
      );
      if (reportRow) visibility.requireVisible("report", [reportRow.id]);
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
        old = db
          .prepare("SELECT response FROM operations WHERE id=?")
          .get(opKey);
      if (old) return { ...parse(old.response), repeated: true };
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
        extendImportProperties(settings, sheet.rows);
        for (const row of sheet.rows) {
          const taskId = stableId(`${opKey}:${row.row}`);
          const cells = prepareImportCells(row, {
            settings,
            personMap: d.personMap,
            allowed: ids,
            teamId: team.id,
            optionId: () => shortId("o"),
          });
          let task;
          if (d.mode === "tasks")
            task = insertTask(db, {
              taskId,
              teamId: team.id,
              year: d.year,
              actorId: user.id,
              cells,
            });
          else
            task = {
              id: taskId,
              teamId: team.id,
              years: [d.year],
              position: report ? lastPosition + tasks.length + 1 : row.row,
              createdBy: user.id,
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
          visibleFields:
            sheet.visibleFields || defaultView(d.year).visibleFields,
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
            user.id,
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
            user.id,
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
          ...(reportRow
            ? { reportId: reportRow.id, name: reportRow.name }
            : {}),
        };
        db.prepare("INSERT INTO operations VALUES(?,?,?,?)").run(
          opKey,
          user.id,
          json(r),
          now(),
        );
        db.prepare("UPDATE imports SET applied_at=?,result=? WHERE id=?").run(
          now(),
          json(r),
          imp.id,
        );
        audit(db, user.id, team.id, "import", imp.id, undefined, {
          ...r,
          sheet: sheet.name,
        });
        return r;
      });
      return result;
    };
    const value = db.syncCapture
      ? db.syncCapture.withActor(user.id, work)
      : work();
    const imp = db
      .prepare("SELECT team_id FROM imports WHERE id=?")
      .get(importId);
    if (imp) {
      this.documentEvents?.invalidate("team:" + imp.team_id, clientId);
      if (input.reportId)
        this.documentEvents?.invalidate("report:" + input.reportId, clientId);
    }
    return value;
  }
}
