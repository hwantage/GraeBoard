import {
  inspectWorkbook,
  makeWorkbook,
  stableId,
  importSheetOptionsSchema,
} from "./transfer-core.mjs";
import { canonical, digest } from "../server/sync/protocol.mjs";
import { pack } from "../shared/compact.js";
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
} from "../shared/domain.js";
import {
  yearSchema,
  styleSchema,
  validateCellValue,
  dateSchema,
} from "../server/validation.mjs";
import { assert } from "./access.mjs";
import { taskList, settingsFor } from "./tasks.mjs";
import { reportView } from "./reports.mjs";
import { profileFor } from "./config.mjs";
import { R2ImageStore, imageReferences } from "./images.mjs";
const clean = (value) => JSON.parse(JSON.stringify(value));
const download = (bytes, type, name) =>
  new Response(bytes, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
export async function transferRoutes(ctx, path, method, body) {
  if (path === "/export" && method === "POST") {
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
      const report = body.reportId
        ? await s.get("report", [body.reportId])
        : null;
      assert(
        !body.reportId || (report && !report.deleted),
        404,
        "사본을 찾을 수 없습니다.",
      );
      const reportData = report ? await reportView(s, report) : null;
      if (reportData)
        assert(
          reportData.revision === body.revision,
          409,
          "사본이 변경되었습니다.",
        );
      let tasks =
        reportData?.tasks ||
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
      const settings = reportData?.settings || (await settingsFor(s)),
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
            report
              ? d.key[0] === "report" &&
                d.key[1] === body.reportId &&
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
          report
            ? d.key[0] === "reportMemo" && d.key[1] === body.reportId
            : d.key[0] === "annual" && d.key[1] === String(year),
        )
        .map((d) => ({ id: d.key.at(-1), ...d.payload }));
      const view = await s.get("view", [ctx.user.id, String(year)]),
        reports = [];
      if (!report && body.scope === "all" && canManageTeam(ctx.user, teamId))
        for (const row of await s.list("report"))
          if (row.payload.year === year) {
            const data = structuredClone(row.payload.data);
            data.tasks = data.tasks.map((t) => ({
              ...t,
              documents: docs
                .filter(
                  (d) =>
                    d.key[0] === "report" &&
                    d.key[1] === row.key[0] &&
                    d.key[2] === t.id,
                )
                .map((d) => ({ id: d.key.at(-1), ...d.payload })),
            }));
            data.memos = docs
              .filter(
                (d) => d.key[0] === "reportMemo" && d.key[1] === row.key[0],
              )
              .map((d) => ({ id: d.key.at(-1), ...d.payload }));
            reports.push({
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
        users: reportData?.users || bootstrap.users,
        memos,
        reports,
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
    const p = profileFor(ctx.env, (await ctx.team(teamId)).profile_id, teamId),
      images = new R2ImageStore(ctx.env[p.bucketBinding], teamId),
      documentImages = [];
    for (const url of imageReferences(
      { tasks: data.tasks, memos: data.memos, reports: data.reports },
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
          schemaVersion: 6,
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
          reports: data.reports,
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
  if (path === "/import/preview" && method === "POST") {
    const form = await ctx.request.formData(),
      teamId = form.get("teamId"),
      year = yearSchema.parse(form.get("year")),
      reportId = form.get("reportId") || null,
      file = form.get("file");
    await ctx.team(teamId, { manage: true });
    assert(
      file &&
        file.size > 0 &&
        file.size <= 25 * 1024 * 1024 &&
        file.name?.toLowerCase().endsWith(".xlsx"),
      400,
      "25MiB 이하 XLSX 파일을 선택하세요.",
    );
    const options = importSheetOptionsSchema.parse(
        form.get("sheetOptions") ? JSON.parse(form.get("sheetOptions")) : {},
      ),
      bytes = Buffer.from(await file.arrayBuffer()),
      id = stableId(
        teamId + year + (reportId || "") + digest(bytes) + canonical(options),
      );
    let settings = await ctx.data(teamId, settingsFor);
    if (reportId)
      settings = await ctx.data(teamId, async (s) => {
        const report = await s.get("report", [reportId]);
        assert(report && !report.deleted, 404, "사본을 찾을 수 없습니다.");
        return report.payload.data.settings;
      });
    const sheets = clean(
        await inspectWorkbook(bytes, year, settings, options),
      ).map((s) => ({ ...s, ...(reportId ? { reportId } : {}) })),
      users = (await ctx.bootstrap()).users.filter((u) =>
        ["lead", "member"].includes(u.teamRoles?.[teamId]),
      ),
      personMap = {};
    for (const name of sheets.flatMap((s) => s.unresolved)) {
      const match = users.filter((u) => u.name === name || u.id === name);
      if (match.length === 1) personMap[name] = match[0].id;
    }
    const existing = await ctx.data(teamId, async (s) => {
      const old = await s.get("import", [id]);
      if (!old)
        await s.put(
          "import",
          [id],
          { filename: file.name, sheets, applied: false },
          { shared: false },
        );
      return old;
    });
    return {
      id,
      alreadyApplied: existing?.payload.applied || false,
      sheets: sheets.map(({ rows, ...s }) => ({
        ...s,
        count: rows.length,
        preview: rows
          .slice(0, 5)
          .map((r) => ({
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
  const item = /^\/import\/([^/]+)\/(exceptions|apply)$/.exec(path);
  if (item && method === "POST") {
    const { teamId } = await ctx.locate("import", item[1]);
    await ctx.team(teamId, { manage: true });
    if (item[2] === "exceptions")
      return ctx.data(teamId, async (s) => {
        const imp = await s.get("import", [item[1]]);
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
    yearSchema.parse(body.year);
    dateSchema.parse(body.referenceDate);
    assert(
      body.acceptWarnings === true &&
        ["tasks", "report", "copy"].includes(body.mode),
      400,
      "이관 검토와 반영 방법을 확인하세요.",
    );
    const users = (await ctx.bootstrap()).users.filter((u) =>
        ["lead", "member"].includes(u.teamRoles?.[teamId]),
      ),
      allowed = new Set(users.map((u) => u.id)),
      opKey = stableId(
        `${item[1]}:${body.sheet}:${body.mode}:${body.year}${body.reportId ? ":" + body.reportId : ""}`,
      );
    return ctx.data(
      teamId,
      async (s) => {
        const imp = await s.get("import", [item[1]]),
          sheet = imp.payload.sheets.find((s) => s.name === body.sheet);
        assert(sheet?.rows.length, 400, "업무가 있는 시트를 선택하세요.");
        assert(
          (sheet.reportId || null) === (body.reportId || null) &&
            (body.mode === "copy") === !!body.reportId,
          400,
          "미리보기와 반영 대상이 다릅니다.",
        );
        for (const name of sheet.unresolved)
          assert(
            allowed.has(body.personMap?.[name]),
            400,
            `담당자 ${name} 연결을 확인하세요.`,
          );
        const existing = body.reportId
          ? await s.get("report", [body.reportId])
          : null;
        if (existing)
          assert(
            (await reportView(s, existing)).revision === body.revision,
            409,
            "사본이 변경되었습니다.",
          );
        const settings = structuredClone(
            existing?.payload.data.settings || (await settingsFor(s)),
          ),
          tasks = [],
          hiddenRows = [],
          rowHeights = {};
        delete settings.revision;
        for (const key of new Set(
          sheet.rows.flatMap((r) => Object.keys(r.fields)),
        ))
          if (!settings.properties.some((p) => p.id === key)) {
            const def = sampleProperties().find((p) => p.id === key);
            if (def) settings.properties.push({ ...def, visible: true });
          }
        let last = Math.max(
          0,
          ...(await s.list("task")).map((r) => r.payload.position),
        );
        for (const row of sheet.rows) {
          const id = stableId(`${opKey}:${row.row}`),
            fields = {
              ...row.fields,
              owner: body.personMap[row.ownerName] || "",
            };
          if (propertiesFor(settings).some((p) => p.id === "supporters"))
            fields.supporters = row.supporterNames.map(
              (n) => body.personMap[n],
            );
          else delete fields.supporters;
          for (const p of propertiesFor(settings)) {
            if (p.kind === "option" && fields[p.id]) {
              const text = String(fields[p.id]);
              let option = p.values.find(
                (v) => !v.archived && (v.label === text || v.id === text),
              );
              if (!option) {
                option = {
                  id: "o" + digest([opKey, p.id, text]).slice(0, 12),
                  label: text,
                  backgroundColor: "#edf6f4",
                  dotColor: "#177b70",
                  emoji: "📌",
                };
                p.values.push(option);
              }
              fields[p.id] = option.id;
            }
            if (
              p.kind === "member" &&
              !["owner", "supporters"].includes(p.id) &&
              fields[p.id] !== undefined
            ) {
              const names = splitNames(fields[p.id]);
              assert(
                p.multiple || names.length <= 1,
                400,
                "한 명의 담당자를 선택하세요.",
              );
              fields[p.id] = p.multiple
                ? [...new Set(names.map((n) => body.personMap[n]))]
                : body.personMap[names[0]] || "";
            }
          }
          const cells = structuredClone(row.cells);
          for (const [key, value] of Object.entries(fields))
            cells[key] = { value, style: cells[key]?.style || {} };
          for (const [key, c] of Object.entries(cells)) {
            styleSchema.parse(c.style);
            validateCellValue(
              null,
              teamId,
              key,
              c.value,
              settings,
              undefined,
              allowed,
            );
          }
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
          await s.put("report", existing.key, {
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
          assert(
            !(await s.list("report")).some(
              (r) => r.payload.name === sheet.name,
            ),
            409,
            "같은 이름의 사본이 있습니다.",
          );
          await s.put("report", [stableId(opKey + ":report")], {
            year: body.year,
            name: sheet.name,
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
            ? { reportId: body.reportId, name: existing.payload.name }
            : {}),
        };
      },
      { write: true, body: { ...body, operationId: opKey }, action: "import" },
    );
  }
  return undefined;
}
