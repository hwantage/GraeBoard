import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  statusSummary,
} from "../../shared/domain.js";
import { aggregate, drillDown } from "../../shared/insights/insights.js";
import {
  insightChartSchema,
  insightsSettingsSchema,
} from "../../shared/insights/insights-schema.js";
import {
  insightPropertyUsages,
  summaryPropertyWarning,
} from "../../shared/insights/insights-references.js";

const category = {
  id: "category",
  name: "분류",
  kind: "option",
  display: "text",
  values: ["a", "b", "c"].map((id) => ({
    id,
    label: id.toUpperCase(),
    dotColor: "#0066cc",
    backgroundColor: "#ffffff",
    emoji: "",
  })),
};
const settings = normalizeSettings({
  ...DEFAULT_SETTINGS,
  properties: [...DEFAULT_SETTINGS.properties, category],
  insights: { workColors: [{ color: "#0066cc" }], charts: [] },
});
const task = (id, weeks, owner = "one", fields = {}) => ({
  id,
  years: [2026],
  cells: Object.fromEntries([
    ...weeks.map((key) => [
      key,
      {
        value: "",
        style: { backgroundColor: "#0066cc", work: true },
        version: 1,
      },
    ]),
    ...Object.entries({ owner, ...fields }).map(([key, value]) => [
      key,
      { value, style: {}, version: 1 },
    ]),
  ]),
});
const tasks = [
  task("a", ["2026-01-05", "2026-01-12"], "one", { category: "a" }),
  task("b", ["2026-01-12", "2026-02-02"], "two", { category: "b" }),
  task("c", ["2026-02-02"], "", { category: "b" }),
];
const context = {
  settings,
  users: [
    { id: "one", name: "One" },
    { id: "two", name: "Two" },
  ],
  period: {
    from: "2026-01",
    to: "2026-03",
    weeks: [
      { key: "2026-01-05", year: 2026, month: 1 },
      { key: "2026-01-12", year: 2026, month: 1 },
      { key: "2026-01-19", year: 2026, month: 1 },
      { key: "2026-02-02", year: 2026, month: 2 },
      { key: "2026-03-02", year: 2026, month: 3 },
    ],
  },
  currentWeek: "2026-11-09",
};
const line = (unit = "week", extra = {}) => ({
  id: "ctrend1",
  title: "Trend",
  type: "line",
  dimensions: { axis: { kind: "time", unit, basis: "work" } },
  values: [{ kind: "count" }],
  ...extra,
});
const pie = (extra = {}) => ({
  id: "cpie001",
  title: "Pie",
  type: "pie",
  dimensions: { axis: { kind: "property", propertyId: "category" } },
  values: [{ kind: "count" }],
  ...extra,
});

test("optional summary field preserves old settings; new chart contracts reject invalid axes and nonadditive pie values", () => {
  const old = { workColors: [], charts: [] };
  assert.deepEqual(insightsSettingsSchema.parse(old), old);
  const added = {
    ...old,
    summaryPropertyId: "category",
    charts: [line(), pie()],
  };
  assert.deepEqual(insightsSettingsSchema.parse(added), added);
  assert.equal(
    insightsSettingsSchema.safeParse({ ...old, summaryPropertyId: null })
      .success,
    true,
  );
  for (const chart of [
    line("week", { dimensions: { axis: { kind: "owner" } } }),
    pie({
      dimensions: { axis: { kind: "time", unit: "month", basis: "work" } },
    }),
    pie({ values: [{ kind: "avgDuration" }] }),
    pie({ dimensions: { axis: { kind: "owner" }, series: { kind: "owner" } } }),
    line("week", { display: { mode: "stacked" } }),
  ])
    assert.equal(insightChartSchema.safeParse(chart).success, false);
});

test("header retains status default, switches categories, preserves missing/archived buckets and explicit off", () => {
  assert.equal(
    statusSummary(tasks, settings).find((group) => group.id === "__empty")
      .count,
    3,
  );
  const configured = {
    ...settings,
    insights: { ...settings.insights, summaryPropertyId: "category" },
  };
  const counts = statusSummary(
    [...tasks, task("empty", []), task("old", [], "", { category: "removed" })],
    configured,
  );
  assert.deepEqual(
    counts.map((group) => [group.id, group.count]),
    [
      ["a", 1],
      ["b", 2],
      ["c", 0],
      ["__empty", 1],
      ["__archived", 1],
    ],
  );
  assert.equal(counts[0].color, "#0066cc");
  assert.deepEqual(
    statusSummary(tasks, {
      ...configured,
      insights: { ...configured.insights, summaryPropertyId: null },
    }),
    [],
  );
});

test("archiving a referenced property keeps counts and ID, restoration recovers, missing or changed type never falls back to status", () => {
  const configured = {
    ...settings,
    insights: {
      ...settings.insights,
      summaryPropertyId: "category",
      charts: [pie()],
    },
  };
  const archived = {
    ...configured,
    properties: configured.properties.map((p) =>
      p.id === "category" ? { ...p, archived: true } : p,
    ),
  };
  assert.deepEqual(
    statusSummary(tasks, archived),
    statusSummary(tasks, configured),
  );
  assert.match(summaryPropertyWarning(archived), /보관된 통계 속성: 분류/);
  assert.equal(summaryPropertyWarning(configured), "");
  assert.deepEqual(insightPropertyUsages(configured, "category"), [
    "상단 통계",
    "차트: Pie",
  ]);
  const archivedResult = aggregate(tasks, pie(), {
    ...context,
    settings: archived,
  });
  assert.deepEqual(archivedResult.errors, []);
  assert.match(archivedResult.warnings.join(), /보관된 속성/);
  assert.deepEqual(
    archivedResult.cells.map((cell) => cell.values[0].raw),
    [1, 2, 0],
  );
  const filtered = line("month", {
    filter: { propertyFilters: { category: ["a"] } },
  });
  assert.deepEqual(
    aggregate(tasks, filtered, { ...context, settings: archived }).cells.map(
      (cell) => cell.values[0].raw,
    ),
    [1, 0, 0],
  );
  assert.match(
    aggregate(tasks, filtered, {
      ...context,
      settings: {
        ...configured,
        properties: configured.properties.filter((p) => p.id !== "category"),
      },
    }).errors.join(),
    /다시 선택/,
  );
  for (const properties of [
    configured.properties.filter((p) => p.id !== "category"),
    configured.properties.map((p) =>
      p.id === "category" ? { ...p, kind: "text" } : p,
    ),
  ]) {
    const broken = { ...configured, properties };
    assert.deepEqual(statusSummary(tasks, broken), []);
    assert.match(summaryPropertyWarning(broken), /인사이트 설정에서 다시 선택/);
    assert.match(
      aggregate(tasks, pie(), { ...context, settings: broken }).errors.join(),
      /다시 선택/,
    );
  }
});

test("weekly trend uses exact selected weeks including zero; monthly counts deduplicate tasks while total counts unique tasks", () => {
  const weekly = aggregate(tasks, line(), context);
  assert.deepEqual(
    weekly.rows.map((row) => row.key),
    context.period.weeks.map((week) => week.key),
  );
  assert.deepEqual(
    weekly.cells.map((cell) => cell.values[0].raw),
    [1, 2, 0, 2, 0],
  );
  assert.equal(weekly.totals[0].raw, 3);
  const monthly = aggregate(tasks, line("month"), context);
  assert.deepEqual(
    monthly.cells.map((cell) => cell.values[0].raw),
    [2, 2, 0],
  );
  assert.deepEqual(
    drillDown(tasks, line("month"), monthly.cells[0], context)
      .map((metric) => metric.task.id)
      .sort(),
    ["a", "b"],
  );
  assert.deepEqual(drillDown(tasks, line(), weekly.cells[2], context), []);
});

test("team and each owner share the same trend buckets, include unassigned and intersect existing filters", () => {
  const chart = line("week", {
    dimensions: { ...line().dimensions, series: { kind: "owner" } },
  });
  const result = aggregate(tasks, chart, context);
  assert.deepEqual(
    new Set(result.series.map((series) => series.key)),
    new Set(["one", "two", ""]),
  );
  assert.equal(
    result.cells.find(
      (cell) => cell.row === "2026-01-12" && cell.series === "one",
    ).values[0].raw,
    1,
  );
  const individual = line("month", {
    filter: {
      propertyFilters: { owner: ["two"] },
      propertyFilterModes: { owner: "include" },
    },
  });
  assert.deepEqual(
    aggregate(tasks, individual, context).cells.map(
      (cell) => cell.values[0].raw,
    ),
    [1, 1, 0],
  );
  assert.deepEqual(
    aggregate(
      tasks,
      {
        ...individual,
        filter: { propertyFilters: { owner: ["two"], category: ["a"] } },
      },
      context,
    ).cells.map((cell) => cell.values[0].raw),
    [0, 0, 0],
  );
});

test("year-edge weeks follow sheet display months, empty selections stay empty, full years exceed the old 50-row bar cap", () => {
  const t = [task("edge", ["2025-12-29"])];
  const edge = {
    ...context,
    period: {
      from: "2026-01",
      to: "2026-01",
      weeks: [{ key: "2025-12-29", year: 2026, month: 1 }],
    },
  };
  assert.equal(aggregate(t, line(), edge).rows[0].key, "2025-12-29");
  assert.equal(aggregate(t, line("month"), edge).rows[0].key, "2026-01");
  assert.equal(
    aggregate(tasks, line(), {
      ...context,
      period: { ...context.period, weeks: [] },
    }).rows.length,
    0,
  );
  const full = aggregate([], line(), {
    ...context,
    period: { from: "2026-01", to: "2027-12" },
  });
  assert.ok(full.rows.length >= 104);
  assert.deepEqual(full.errors, []);
  assert.ok(full.cells.every((cell) => cell.values[0].raw === 0));
});

test("pie uses disjoint categories, includes zeros, preserves archived options, rejects negative numeric slices", () => {
  const result = aggregate(tasks, pie(), context);
  assert.deepEqual(
    result.cells.map((cell) => cell.values[0].raw),
    [1, 2, 0],
  );
  assert.equal(result.totals[0].raw, 3);
  const archivedOption = {
    ...settings,
    properties: settings.properties.map((p) =>
      p.id === "category"
        ? {
            ...p,
            values: p.values.map((option) =>
              option.id === "a" ? { ...option, archived: true } : option,
            ),
          }
        : p,
    ),
  };
  assert.deepEqual(
    aggregate(tasks, pie(), { ...context, settings: archivedOption }).cells.map(
      (cell) => cell.values[0].raw,
    ),
    [1, 2, 0],
  );
  assert.deepEqual(
    drillDown(tasks, pie(), result.cells[1], context)
      .map((metric) => metric.task.id)
      .sort(),
    ["b", "c"],
  );
  const numeric = {
    ...settings,
    properties: [
      ...settings.properties,
      { id: "score", kind: "number", name: "Score", values: [] },
    ],
  };
  const negative = [
    task("negative", ["2026-01-05"], "one", { category: "a", score: -1 }),
  ];
  assert.match(
    aggregate(
      negative,
      pie({ values: [{ kind: "numberSum", propertyId: "score" }] }),
      { ...context, settings: numeric },
    ).errors.join(),
    /음수/,
  );
});
