import {
  inspectWorkbook,
  makeWorkbook,
  stableId,
  importSheetOptionsSchema,
} from "../../../shared/transfer/workbook.mjs";
import { canonical, digest } from "../../../server/sync/core/protocol.mjs";
import { pack } from "../../../shared/formatting/compact.js";
import {
  fieldsFor,
  weeksForPeriod,
  orderColumns,
  displayValue,
  safeSpreadsheetText,
  propertiesFor,
  sampleProperties,
  splitNames,
  defaultView,
  viewLayout,
  canManageTeam,
} from "../../../shared/domain.js";
import {
  yearSchema,
  styleSchema,
  validateCellValue,
  dateSchema,
  sheetCloneNameSchema,
} from "../../../shared/validation.js";
import { requireFreeSheetCloneName } from "../../../shared/sheet-clones/sheet-clone-names.js";
import { assert } from "../../control/access.mjs";
import { taskList, settingsFor, excludedYears } from "../../sheet/tasks.mjs";
import { sheetCloneView } from "../../sheet-clones/sheet-clones.mjs";
import { sheetCloneSummaries } from "../sheet-clones/postgres-sheet-clones.mjs";
import { imageReferences } from "../../documents/images.mjs";
import {
  transferDownload as download,
  extendImportProperties,
  prepareImportCells,
} from "../../../server/storage/transfer/transfer-service.mjs";
const clean = (value) => JSON.parse(JSON.stringify(value));
export class PostgresTransferRepository {
  constructor({ context }) {
    this.context = context;
  }
  check(user) {
    assert(
      user.id === this.context.user.id,
      403,
      "사용자 저장소 범위를 확인하세요.",
    );
    return this.context;
  }
  async export(user, body) {
    const ctx = this.check(user);
    const year = yearSchema.parse(body.year),
      teamId = body.teamId,
      bootstrap = await ctx.bootstrap(),
      team = bootstrap.teams.find((t) => t.id === teamId);
    assert(team, 403, "팀에 접근할 권한이 없습니다.");
    assert(
      ["xlsx", "csv", "json"].includes(body.format) &&
        ["all", "view"].includes(body.scope),
      400,
      "내보내기 형식을 확인하세요.",
    );
    const data = await ctx.data(teamId, async (s) => {
      const sheetClone = body.sheetCloneId
        ? await s.get("sheetClone", [body.sheetCloneId])
        : null;
      assert(
        !body.sheetCloneId || (sheetClone && !sheetClone.deleted),
        404,
        "사본을 찾을 수 없습니다.",
      );
      const sheetCloneData = sheetClone
        ? await sheetCloneView(s, sheetClone)
        : null;
      if (sheetCloneData)
        assert(
          sheetCloneData.revision === body.revision,
          409,
          "사본이 변경되었습니다.",
        );
      let tasks =
        sheetCloneData?.tasks ||
        (await taskList(s, {
          year,
          startMonth: body.scope === "all" ? 1 : body.startMonth || 1,
        }));
      if (body.scope === "view") {
        const ids = new Set(body.taskIds || []),
          selected = tasks.filter((t) => ids.has(t.id));
        assert(
          selected.length === ids.size,
          409,
          "일부 업무가 변경되었습니다.",
        );
        tasks = selected;
      }
      const settings = sheetCloneData?.settings || (await settingsFor(s)),
        allowed = orderColumns(
          fieldsFor(settings),
          weeksForPeriod(year, body.startMonth || 1),
        ).map((c) => c.key),
        keys = body.scope === "all" ? allowed : body.keys || allowed;
      assert(
        keys.length && keys.every((k) => allowed.includes(k)),
        400,
        "내보낼 열을 확인하세요.",
      );
      const docs = await s.list("document");
      tasks = tasks.map((t) => ({
        ...t,
        documents: docs
          .filter((d) =>
            sheetClone
              ? d.key[0] === "sheetClone" &&
                d.key[1] === body.sheetCloneId &&
                d.key[2] === t.id
              : d.key[0] === "task" && d.key[1] === t.id,
          )
          .map((d) => ({
            id: d.key.at(-1),
            title: d.payload.title,
            markdown: d.payload.markdown,
          })),
      }));
      const memos = docs
        .filter((d) =>
          sheetClone
            ? d.key[0] === "sheetCloneMemo" && d.key[1] === body.sheetCloneId
            : d.key[0] === "annual" && d.key[1] === String(year),
        )
        .map((d) => ({ id: d.key.at(-1), ...d.payload }));
      const view = await s.get("view", [ctx.user.id, String(year)]),
        sheetClones = [];
      if (
        !sheetClone &&
        body.scope === "all" &&
        canManageTeam(ctx.user, teamId)
      )
        for (const row of await s.list("sheetClone"))
          if (row.payload.year === year) {
            const data = structuredClone(row.payload.data);
            data.tasks = data.tasks.map((t) => ({
              ...t,
              documents: docs
                .filter(
                  (d) =>
                    d.key[0] === "sheetClone" &&
                    d.key[1] === row.key[0] &&
                    d.key[2] === t.id,
                )
                .map((d) => ({ id: d.key.at(-1), ...d.payload })),
            }));
            data.memos = docs
              .filter(
                (d) => d.key[0] === "sheetCloneMemo" && d.key[1] === row.key[0],
              )
              .map((d) => ({ id: d.key.at(-1), ...d.payload }));
            sheetClones.push({
              name: row.payload.name,
              year,
              referenceDate: row.payload.referenceDate,
              createdAt: row.payload.createdAt,
              data,
            });
          }
      return {
        tasks,
        settings,
        keys,
        users: sheetCloneData?.users || bootstrap.users,
        memos,
        sheetClones,
        views: view ? [{ name: "__current", data: view.payload }] : [],
        filters: (await s.list("filter")).map((r) => ({
          id: r.key[0],
          ...r.payload,
          scope: "team",
        })),
        currentFilters: (await s.get("filterState", [ctx.user.id]))
          ?.payload || { selectedId: "", data: {} },
      };
    });
    const name = `graeboard-${year}.${body.format}`;
    if (body.format === "xlsx")
      return download(
        await makeWorkbook(
          data.tasks,
          data.keys,
          data.users,
          year,
          data.settings,
        ),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        name,
      );
    if (body.format === "csv") {
      const labels = new Map(
          fieldsFor(data.settings).map((f) => [
            f.key,
            f.label || f.name || f.key,
          ]),
        ),
        quote = (v) =>
          '"' + safeSpreadsheetText(String(v)).replaceAll('"', '""') + '"';
      return download(
        "\uFEFF" +
          [
            data.keys.map((k) => labels.get(k) || k),
            ...data.tasks.map((t) =>
              data.keys.map((k) =>
                displayValue(t, k, data.users, data.settings),
              ),
            ),
          ]
            .map((row) => row.map(quote).join(","))
            .join("\r\n"),
        "text/csv; charset=utf-8",
        name,
      );
    }
    const images = await ctx.imageStore(teamId),
      documentImages = [];
    for (const url of imageReferences(
      { tasks: data.tasks, memos: data.memos, sheetClones: data.sheetClones },
      teamId,
    )) {
      const bytes = await images.read(url);
      assert(bytes, 409, "참조 이미지가 누락되어 내보낼 수 없습니다.");
      documentImages.push({
        url,
        mimeType: "image/webp",
        base64: Buffer.from(bytes).toString("base64"),
      });
    }
    return download(
      JSON.stringify(
        pack({
          format: "weekly-plan",
          schemaVersion: 7,
          exportedAt: new Date().toISOString(),
          team: { id: teamId, name: team.name, settings: data.settings },
          year,
          startMonth: body.startMonth || 1,
          tasks: data.tasks,
          users: data.users.map(
            ({ id, name, color, avatarInitials, avatarImage }) => ({
              id,
              name,
              color,
              avatarInitials,
              avatarImage,
            }),
          ),
          memos: data.memos,
          sheetClones: data.sheetClones,
          views: data.views,
          filters: data.filters,
          currentFilters: data.currentFilters,
          documentImages,
        }),
      ),
      "application/json",
      name,
    );
  }
  async preview(user, input) {
    const ctx = this.check(user);
    const teamId = input.teamId,
      year = input.year,
      sheetCloneId = input.sheetCloneId || null,
      file = { name: input.file.name, size: input.file.bytes.byteLength };
    await ctx.team(teamId, { manage: true });
    assert(
      file &&
        file.size > 0 &&
        file.size <= 25 * 1024 * 1024 &&
        file.name?.toLowerCase().endsWith(".xlsx"),
      400,
      "25MiB 이하 XLSX 파일을 선택하세요.",
    );
    const options = importSheetOptionsSchema.parse(input.sheetOptions),
      bytes = Buffer.from(input.file.bytes),
      id = stableId(
        teamId +
          year +
          (sheetCloneId || "") +
          digest(bytes) +
          canonical(options),
      );
    let settings = await ctx.data(teamId, settingsFor);
    if (sheetCloneId)
      settings = await ctx.data(teamId, async (s) => {
        const sheetClone = await s.get("sheetClone", [sheetCloneId]);
        assert(
          sheetClone && !sheetClone.deleted,
          404,
          "사본을 찾을 수 없습니다.",
        );
        return sheetClone.payload.data.settings;
      });
    const sheets = clean(
        await inspectWorkbook(bytes, year, settings, options),
      ).map((s) => ({ ...s, ...(sheetCloneId ? { sheetCloneId } : {}) })),
      users = (await ctx.bootstrap()).users.filter((u) =>
        ["lead", "member"].includes(u.teamRoles?.[teamId]),
      ),
      personMap = {};
    for (const name of sheets.flatMap((s) => s.unresolved)) {
      const match = users.filter((u) => u.name === name || u.id === name);
      if (match.length === 1) personMap[name] = match[0].id;
    }
    const existing = await ctx.data(
      teamId,
      async (s) => {
        assert(
          !(await excludedYears(s)).has(year),
          409,
          "이 사이트에서 정리한 연도입니다. 먼저 복원하세요.",
        );
        if (sheetCloneId) {
          const sheetClone = await s.get("sheetClone", [sheetCloneId]);
          assert(
            sheetClone && !sheetClone.deleted,
            404,
            "사본을 찾을 수 없습니다.",
          );
        }
        const old = await s.get("import", [id]);
        if (!old)
          await s.put(
            "import",
            [id],
            { filename: file.name, sheets, applied: false },
            { shared: false },
          );
        return old;
      },
      { write: true },
    );
    return {
      id,
      alreadyApplied: existing?.payload.applied || false,
      sheets: sheets.map(({ rows, ...s }) => ({
        ...s,
        count: rows.length,
        preview: rows.slice(0, 5).map((r) => ({
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
  async exceptions(user, importId) {
    const ctx = this.check(user);
    const { teamId } = await ctx.locate("import", importId);
    await ctx.team(teamId, { manage: true });
    return ctx.data(teamId, async (s) => {
      const imp = await s.get("import", [importId]);
      return download(
        JSON.stringify({
          filename: imp.payload.filename,
          sheets: imp.payload.sheets.map((s) => ({
            name: s.name,
            warnings: s.warnings,
            unresolved: s.unresolved,
          })),
        }),
        "application/json",
        "import-exceptions.json",
      );
    });
  }
  async apply(user, importId, body) {
    const ctx = this.check(user);
    const { teamId } = await ctx.locate("import", importId);
    await ctx.team(teamId, { manage: true });
    yearSchema.parse(body.year);
    dateSchema.parse(body.referenceDate);
    assert(
      body.acceptWarnings === true &&
        ["tasks", "create-sheet-clone", "append-to-sheet-clone"].includes(
          body.mode,
        ),
      400,
      "이관 검토와 반영 방법을 확인하세요.",
    );
    const users = (await ctx.bootstrap()).users.filter((u) =>
        ["lead", "member"].includes(u.teamRoles?.[teamId]),
      ),
      allowed = new Set(users.map((u) => u.id)),
      opKey = stableId(
        `${importId}:${body.sheet}:${body.mode}:${body.year}${body.sheetCloneId ? ":" + body.sheetCloneId : ""}`,
      );
    return ctx.data(
      teamId,
      async (s) => {
        const imp = await s.get("import", [importId]),
          sheet = imp.payload.sheets.find((s) => s.name === body.sheet);
        assert(sheet?.rows.length, 400, "업무가 있는 시트를 선택하세요.");
        assert(
          (sheet.sheetCloneId || null) === (body.sheetCloneId || null) &&
            (body.mode === "append-to-sheet-clone") === !!body.sheetCloneId,
          400,
          "미리보기와 반영 대상이 다릅니다.",
        );
        for (const name of sheet.unresolved)
          assert(
            allowed.has(body.personMap?.[name]),
            400,
            `담당자 ${name} 연결을 확인하세요.`,
          );
        const existing = body.sheetCloneId
          ? await s.get("sheetClone", [body.sheetCloneId])
          : null;
        assert(
          !body.sheetCloneId ||
            (existing &&
              !existing.deleted &&
              existing.payload.year === body.year),
          404,
          "사본을 찾을 수 없습니다.",
        );
        if (existing) {
          assert(
            (await sheetCloneView(s, existing)).revision === body.revision,
            409,
            "사본이 변경되었습니다.",
          );
          assert(
            existing.payload.data.tasks.length + sheet.rows.length <= 20000,
            400,
            "사본에는 최대 20,000개 업무를 저장할 수 있습니다.",
          );
        }
        // A new copy is named after its sheet, as the internal site names it.
        const sheetCloneName =
          body.mode === "create-sheet-clone"
            ? sheetCloneNameSchema.parse(sheet.name)
            : null;
        if (sheetCloneName)
          requireFreeSheetCloneName(
            (await sheetCloneSummaries(s)).map((r) => r.payload.name),
            sheetCloneName,
          );
        const settings = structuredClone(
            existing?.payload.data.settings || (await settingsFor(s)),
          ),
          tasks = [],
          hiddenRows = [],
          rowHeights = {};
        delete settings.revision;
        if (body.mode !== "tasks") delete settings.insights;
        extendImportProperties(settings, sheet.rows);
        let last = Math.max(
          0,
          ...(await s.list("task")).map((r) => r.payload.position),
        );
        for (const row of sheet.rows) {
          const id = stableId(`${opKey}:${row.row}`),
            cells = prepareImportCells(row, {
              settings,
              personMap: body.personMap,
              allowed,
              teamId,
              optionId: (key, text) =>
                "o" + digest([opKey, key, text]).slice(0, 12),
            });
          const now = new Date().toISOString(),
            task = {
              id,
              teamId,
              years: [body.year],
              position: (last += 100),
              createdBy: ctx.user.id,
              createdAt: now,
              updatedAt: now,
              defaultStyle: settings.defaultStyle || {},
              rowStyle: {},
              deletedAt: null,
              cells: Object.fromEntries(
                Object.entries(cells).map(([key, c]) => [
                  key,
                  { ...c, version: 1 },
                ]),
              ),
              documents: [],
            };
          tasks.push(task);
          if (row.height) rowHeights[id] = row.height;
          if (row.hidden) hiddenRows.push(id);
          if (body.mode === "tasks") {
            const {
              id: _,
              teamId: __,
              cells: ___,
              documents: ____,
              updatedAt: _____,
              ...payload
            } = task;
            await s.put("task", [id], payload);
            for (const [key, c] of Object.entries(cells))
              await s.put("cell", [id, key], c);
          }
        }
        const view = {
          ...defaultView(body.year),
          widths: sheet.widths || {},
          visibleFields:
            sheet.visibleFields || defaultView(body.year).visibleFields,
          rowHeights,
          hiddenRows,
          hiddenWeeks: sheet.hiddenWeeks,
        };
        if (body.mode === "tasks") {
          const team = await s.get("team", []);
          await s.put("team", [], { ...team.payload, settings });
          await s.put(
            "view",
            [ctx.user.id, String(body.year)],
            viewLayout(view),
            { shared: false },
          );
        } else if (existing) {
          const data = existing.payload.data;
          await s.put("sheetClone", existing.key, {
            ...existing.payload,
            data: {
              ...data,
              tasks: [...data.tasks, ...tasks],
              settings,
              users: [
                ...new Map(
                  [...data.users, ...users].map(({ id, name }) => [
                    id,
                    { id, name },
                  ]),
                ).values(),
              ],
              view: {
                ...data.view,
                rowHeights: { ...data.view.rowHeights, ...rowHeights },
                hiddenRows: [...data.view.hiddenRows, ...hiddenRows],
              },
            },
          });
        } else {
          await s.put("sheetClone", [stableId(opKey + ":sheetClone")], {
            year: body.year,
            name: sheetCloneName,
            referenceDate: body.referenceDate,
            createdBy: ctx.user.id,
            createdAt: new Date().toISOString(),
            data: {
              tasks,
              users: users.map(({ id, name }) => ({ id, name })),
              view,
              settings,
            },
          });
        }
        await s.put(
          "import",
          imp.key,
          { ...imp.payload, applied: true },
          { shared: false },
        );
        return {
          count: tasks.length,
          warningCount: sheet.warnings.length,
          mode: body.mode,
          ...(existing
            ? { sheetCloneId: body.sheetCloneId, name: existing.payload.name }
            : {}),
        };
      },
      { write: true, body: { ...body, operationId: opKey }, action: "import" },
    );
  }
}
