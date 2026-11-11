import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  weeksForPeriod,
  mondayOf,
} from "../../shared/domain.js";
import {
  aggregate,
  createTaskMetricsCache,
  drillDown,
  numericValue,
  numericProperties,
  taskMetrics,
  taskWorkWeeks,
  workColorSet,
  periodError,
  weekMonth,
} from "../../shared/insights/insights.js";
import {
  insightChartSchema,
  insightsSettingsSchema,
} from "../../shared/insights/insights-schema.js";

const property = (id, kind = "text", extra = {}) => ({
  id,
  name: id,
  kind,
  display: "text",
  values: [],
  ...extra,
});
const options = ["a", "b", "c"].map((id) => ({
  id,
  label: id,
  backgroundColor: "#ffffff",
  dotColor: "#000000",
  emoji: "",
}));
const settings = normalizeSettings({
  ...DEFAULT_SETTINGS,
  properties: [
    ...DEFAULT_SETTINGS.properties,
    property("deadline", "date"),
    property("score"),
    property("numeric", "number"),
    property("category", "option", {
      values: [
        ...options,
        { ...options[0], id: "old", label: "old", archived: true },
      ],
    }),
  ],
  insights: {
    workColors: [{ color: "#aabbcc" }, { color: "#0066cc" }],
    deadlinePropertyId: "deadline",
    charts: [],
  },
});
const ctx = (extra = {}) => ({
  settings,
  users: [
    { id: "one", name: "One" },
    { id: "two", name: "Two" },
  ],
  period: { from: "2026-01", to: "2026-12" },
  currentWeek: "2026-02-02",
  ...extra,
});
const task = (id, weeks = [], fields = {}, extra = {}) => ({
  id,
  teamId: "team",
  years: [2026],
  position: 0,
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  cells: Object.fromEntries([
    ...weeks.map((week) => [
      week,
      {
        value: "/////",
        style: { backgroundColor: "#ABC", work: true },
        version: 1,
      },
    ]),
    ...Object.entries(fields).map(([key, value]) => [
      key,
      { value, style: {}, version: 1 },
    ]),
  ]),
  ...extra,
});
const chart = (extra = {}) => ({
  id: "c123abc",
  title: "Chart",
  type: "table",
  dimensions: { row: { kind: "owner" } },
  values: [{ kind: "count" }],
  ...extra,
});
const number = (kind, propertyId) =>
  chart({
    type: "number",
    dimensions: {},
    values: [{ kind, ...(propertyId ? { propertyId } : {}) }],
  });
const raw = (tasks, kind, propertyId, context = ctx()) =>
  aggregate(tasks, number(kind, propertyId), context).totals[0];

test("work weeks use exact normalized backgrounds, multiple colors, noncontiguous and future weeks, never cell text", () => {
  const t = task("one", ["2026-01-05", "2026-01-19", "2026-12-07"]);
  t.cells["2026-01-12"] = { value: "work", style: {}, version: 1 };
  t.cells["2026-01-26"] = {
    value: "",
    style: { backgroundColor: "#0066CC", work: true },
    version: 1,
  };
  t.cells["2026-02-02"] = {
    value: "",
    style: { backgroundColor: "#aabbcd" },
    version: 1,
  };
  assert.deepEqual(taskWorkWeeks(t, workColorSet(settings)), [
    "2026-01-05",
    "2026-01-19",
    "2026-01-26",
    "2026-12-07",
  ]);
  assert.deepEqual(
    taskWorkWeeks({ ...t, deletedAt: "deleted" }, workColorSet(settings)),
    [],
  );
  assert.deepEqual(taskWorkWeeks(t, new Set()), []);
});
test("default, row and column inheritance count recordless weeks; explicit cell overrides cancel common styles", () => {
  const t = task(
    "one",
    [],
    {},
    {
      defaultStyle: { backgroundColor: "#0066cc", work: true },
      rowStyle: { backgroundColor: "#fff" },
    },
  );
  t.formatting = {
    revision: 2,
    rules: [
      {
        id: "r",
        rows: null,
        keys: ["2026-01-05", "2026-01-12"],
        style: { backgroundColor: "#ABC", work: true },
        orders: { backgroundColor: 1, work: 1 },
      },
    ],
  };
  t.cells["2026-01-12"] = {
    value: "",
    style: { backgroundColor: "#ffffff" },
    version: 1,
  };
  assert.deepEqual(taskWorkWeeks(t, workColorSet(settings)), ["2026-01-05"]);
  t.formatting.rules.push({
    id: "later",
    rows: ["one"],
    keys: ["2026-01-05"],
    style: {},
    orders: { backgroundColor: 2 },
  });
  assert.deepEqual(
    taskWorkWeeks(t, workColorSet(settings)),
    ["2026-01-05"],
    "a reset on this week falls back to default, while the white row and cell still win elsewhere",
  );
  const row = task(
    "row",
    [],
    {},
    { rowStyle: { backgroundColor: "#ABC", work: true } },
  );
  assert.equal(
    taskWorkWeeks(row, workColorSet(settings)).length,
    weeksForPeriod(2026).length,
  );
});
test("whole loaded task duration crosses years while range work totals use Friday month ownership", () => {
  const t = task(
    "cross",
    ["2025-12-22", "2025-12-29", "2026-01-05", "2026-02-02"],
    {},
    { years: [2025, 2026] },
  );
  const c = ctx({ period: { from: "2026-01", to: "2026-01" } });
  const m = taskMetrics(t, c);
  assert.equal(weekMonth("2025-12-29"), "2026-01");
  assert.equal(m.duration, 4);
  assert.equal(m.rangeWeeks.length, 2);
  assert.equal(m.progressState, "inProgress");
  assert.equal(m.startMonth, "2025-12");
  assert.equal(m.endMonth, "2026-02");
  assert.equal(raw([t], "avgDuration", null, c).raw, 4);
  assert.equal(raw([t], "workWeeks", null, c).raw, 2);
  assert.equal(raw([task("outside", ["2026-03-02"])], "count", null, c).raw, 0);
});
test("progress compares first/last week to KST current week with inclusive boundaries", () => {
  const cases = [
    [[], "none"],
    [["2026-01-26"], "completed"],
    [["2026-02-02"], "inProgress"],
    [["2026-01-05", "2026-02-09"], "inProgress"],
    [["2026-02-09"], "planned"],
  ];
  for (const [weeks, expected] of cases)
    assert.equal(
      taskMetrics(task(expected, weeks), ctx()).progressState,
      expected,
    );
  assert.equal(mondayOf("2026-02-08"), "2026-02-02");
});
test("all deadline states, same-week on time and exact delay-week arithmetic", () => {
  const cases = [
    ["2026-01-26", "2026-01-30", "onTimeCompleted", 0],
    ["2026-01-26", "2026-01-19", "delayedCompleted", 1],
    ["2026-02-02", "2026-01-30", "overdue", 1],
    ["2026-02-16", "2026-02-06", "plannedDelay", 2],
    ["2026-02-02", "2026-02-08", "onTime", 0],
    ["2026-02-02", "", "noDeadline", 0],
    [null, "2026-01-01", "noWork", 0],
  ];
  for (const [week, deadline, state, delay] of cases) {
    const m = taskMetrics(task(state, week ? [week] : [], { deadline }), ctx());
    assert.equal(m.deadlineState, state);
    assert.equal(m.delayWeeks, delay);
  }
  const rows = cases.map(([week, deadline], i) =>
    task(String(i), week ? [week] : [], { deadline }),
  );
  assert.equal(raw(rows, "delayed").raw, 2);
  assert.equal(raw(rows, "delayRate").raw, 40);
  assert.equal(raw(rows, "avgDelay").raw, 1);
  assert.equal(
    taskMetrics(
      rows[0],
      ctx({
        settings: {
          ...settings,
          insights: { ...settings.insights, deadlinePropertyId: null },
        },
      }),
    ).deadlineState,
    "noDeadline",
  );
});
test("text numbers, signs, decimals, commas, percents, empty values and invalid exclusions", () => {
  for (const [input, expected] of [
    ["1", 1],
    [" 2 ", 2],
    ["1,000", 1000],
    ["100%", 100],
    ["-1.25%", -1.25],
    ["+5", 5],
    [0, 0],
    ["완료", null],
    ["1e2", null],
    [".5", null],
    ["", null],
    ["  ", null],
  ])
    assert.equal(numericValue(input).value, expected);
  assert.equal(numericValue("완료").excluded, true);
  assert.equal(numericValue("").excluded, false);
  assert.equal(numericValue(Infinity).excluded, true);
  const rows = ["1", " 2 ", "1,000", "100%", "완료", ""].map((score, i) =>
    task(String(i), ["2026-01-05"], { score }),
  );
  assert.deepEqual(raw(rows, "numberSum", "score"), { raw: 1103, excluded: 1 });
  assert.equal(raw(rows, "numberAvg", "score").raw, 275.75);
  assert.equal(raw(rows, "numberMax", "score").raw, 1000);
  assert.ok(numericProperties(rows, settings).some((p) => p.id === "score"));
  assert.ok(
    !numericProperties([task("empty")], settings).some((p) => p.id === "score"),
  );
  assert.ok(numericProperties([], settings).some((p) => p.id === "numeric"));
  assert.equal(
    raw(
      [task("negative", ["2026-01-05"], { score: "-3" })],
      "numberMax",
      "score",
    ).raw,
    -3,
  );
});
const rows = [
  task("a", ["2026-01-05"], {
    owner: "one",
    supporters: ["two"],
    category: "a",
    score: "10",
    deadline: "2026-01-02",
  }),
  task("b", ["2026-01-05", "2026-01-12"], {
    owner: "one",
    category: "b",
    score: "20",
    deadline: "2026-01-16",
  }),
  task("c", ["2026-01-26", "2026-02-02", "2026-02-09"], {
    owner: "two",
    category: "old",
    score: "bad",
    deadline: "2026-01-30",
  }),
  task("d", ["2026-02-16"], { category: "", score: "" }),
  task(
    "deleted",
    ["2026-01-05"],
    { owner: "one", score: "100" },
    { deletedAt: "yesterday" },
  ),
  task("empty"),
];
test("all aggregate values use distinct tasks, owner only and loaded duration", () => {
  for (const [kind, expected] of Object.entries({
    count: 4,
    completed: 2,
    inProgress: 1,
    workWeeks: 7,
    avgDuration: 1.75,
    medianDuration: 1.5,
    maxDuration: 3,
    delayed: 2,
    delayRate: 200 / 3,
    avgDelay: 1.5,
  }))
    assert.ok(Math.abs(raw(rows, kind).raw - expected) < 1e-10, kind);
  const r = aggregate(
    rows,
    chart({
      values: [
        { kind: "count" },
        { kind: "workWeeks" },
        { kind: "avgDuration" },
        { kind: "numberSum", propertyId: "score" },
      ],
    }),
    ctx(),
  );
  assert.equal(r.rows.find((r) => r.key === "").label, "(미지정)");
  assert.equal(
    r.cells.find((r) => r.row === "one").values[0].raw,
    2,
    "supporters do not increase any owner total",
  );
  assert.equal(r.seriesTotals.all[0].raw, 4);
  assert.equal(r.seriesTotals.all[3].excluded, 1);
});
test("dimensions include archived option/property warnings, missing references and every status and duration band", () => {
  const r = aggregate(
    rows,
    chart({
      dimensions: { row: { kind: "property", propertyId: "category" } },
    }),
    ctx(),
  );
  assert.ok(r.rows.some((r) => r.label === "보관된 값: old"));
  assert.ok(r.rows.some((r) => r.label === "미지정"));
  const archived = ctx({
    settings: {
      ...settings,
      properties: settings.properties.map((p) =>
        p.id === "category" ? { ...p, archived: true } : p,
      ),
    },
  });
  assert.match(
    aggregate(
      rows,
      chart({
        dimensions: { row: { kind: "property", propertyId: "category" } },
      }),
      archived,
    ).warnings.join(),
    /보관된 속성/,
  );
  assert.match(
    aggregate(
      rows,
      chart({
        dimensions: { row: { kind: "property", propertyId: "missing" } },
      }),
      ctx(),
    ).warnings.join(),
    /참조 속성/,
  );
  for (const kind of ["progressState", "deadlineState", "durationBand"])
    assert.equal(
      aggregate(rows, chart({ dimensions: { row: { kind } } }), ctx()).totals[0]
        .raw,
      4,
    );
  const bandRows = [1, 2, 5, 9].map((length, i) =>
    task(
      String(i),
      weeksForPeriod(2026)
        .slice(1, length + 1)
        .map((w) => w.key),
    ),
  );
  assert.deepEqual(
    aggregate(
      bandRows,
      chart({ dimensions: { row: { kind: "durationBand" } } }),
      ctx(),
    ).rows.map((r) => r.label),
    ["1주", "2~4주", "5~8주", "9주 이상"],
  );
});
test("work time dimensions split monthly weeks, count a task once per month and total once; quarter/start/end and cross time intersections", () => {
  const t = task("span", ["2026-01-26", "2026-02-02", "2026-02-09"]);
  const monthly = chart({
    dimensions: { row: { kind: "time", unit: "month", basis: "work" } },
    values: [{ kind: "count" }, { kind: "workWeeks" }],
  });
  const r = aggregate([t], monthly, ctx());
  assert.deepEqual(
    r.cells.map((cell) => cell.values.map((v) => v.raw)),
    [
      [1, 1],
      [1, 2],
    ],
  );
  assert.deepEqual(
    r.totals.map((v) => v.raw),
    [1, 3],
  );
  for (const [basis, month] of [
    ["start", "2026-01"],
    ["end", "2026-02"],
  ])
    assert.equal(
      aggregate(
        [t],
        chart({ dimensions: { row: { kind: "time", unit: "month", basis } } }),
        ctx(),
      ).rows[0].key,
      month,
    );
  assert.equal(
    aggregate(
      [t],
      chart({
        dimensions: { row: { kind: "time", unit: "quarter", basis: "work" } },
      }),
      ctx(),
    ).rows[0].key,
    "2026-Q1",
  );
  const quarter = chart({
    dimensions: { row: { kind: "time", unit: "quarter", basis: "work" } },
  });
  assert.equal(
    aggregate([task("boundary", ["2026-03-30"])], quarter, ctx()).rows[0].key,
    "2026-Q2",
  );
  const startOutside = chart({
    dimensions: { row: { kind: "time", unit: "month", basis: "start" } },
  });
  const february = ctx({ period: { from: "2026-02", to: "2026-02" } });
  assert.equal(aggregate([t], startOutside, february).totals[0].raw, 0);
  assert.deepEqual(drillDown([t], startOutside, null, february), []);
  const cross = aggregate(
    [t],
    chart({
      dimensions: {
        row: { kind: "time", unit: "month", basis: "work" },
        column: { kind: "time", unit: "month", basis: "work" },
      },
      values: [{ kind: "workWeeks" }],
    }),
    ctx(),
  );
  assert.equal(
    cross.cells.find((c) => c.row === "2026-01" && c.series === "2026-02")
      .values[0].raw,
    0,
  );
});
test("value, overall and within-series percentages; exact drilldown and existing include/exclude filter rules", () => {
  const definition = chart({
    type: "bar",
    dimensions: {
      axis: { kind: "property", propertyId: "category" },
      series: { kind: "owner" },
    },
    display: { percent: "series" },
  });
  assert.deepEqual(
    drillDown(rows, number("completed"), null, ctx()).map((m) => m.task.id),
    ["a", "b"],
  );
  assert.deepEqual(
    drillDown(rows, number("inProgress"), null, ctx()).map((m) => m.task.id),
    ["c"],
  );
  assert.deepEqual(
    drillDown(rows, number("delayed"), null, ctx()).map((m) => m.task.id),
    ["a", "c"],
  );
  assert.deepEqual(
    drillDown(rows, number("numberSum", "score"), null, ctx()).map(
      (m) => m.task.id,
    ),
    ["a", "b"],
  );
  const totalsChart = chart({
    dimensions: {
      row: { kind: "property", propertyId: "category" },
      column: { kind: "owner" },
    },
    values: [{ kind: "count" }, { kind: "completed" }],
  });
  assert.deepEqual(
    drillDown(
      rows,
      totalsChart,
      { total: true, series: "two", valueIndex: 0 },
      ctx(),
    ).map((m) => m.task.id),
    ["c"],
  );
  assert.deepEqual(
    drillDown(
      rows,
      totalsChart,
      { total: true, series: "two", valueIndex: 1 },
      ctx(),
    ),
    [],
  );
  const r = aggregate(rows, definition, ctx());
  const selected = r.cells.find((c) => c.row === "a" && c.series === "one");
  assert.equal(selected.values[0].value, 50);
  assert.deepEqual(
    drillDown(rows, definition, selected, ctx()).map((m) => m.task.id),
    ["a"],
  );
  assert.equal(
    aggregate(
      rows,
      { ...definition, display: { percent: "total" } },
      ctx(),
    ).cells.find((c) => c.row === "a" && c.series === "one").values[0].value,
    25,
  );
  const filtered = aggregate(
    rows,
    chart({
      filter: {
        propertyFilters: { owner: ["one"] },
        propertyFilterModes: { owner: "exclude" },
      },
    }),
    ctx(),
  );
  assert.equal(filtered.totals[0].raw, 2);
});
test("Top N duration, delay and numeric sorting, exclusions, ties and cap", () => {
  for (const [sort, first] of [
    [{ kind: "duration" }, "c"],
    [{ kind: "delayWeeks" }, "c"],
    [{ kind: "number", propertyId: "score" }, "b"],
  ]) {
    const r = aggregate(
      rows,
      chart({ type: "top", dimensions: {}, sort, limit: 5 }),
      ctx(),
    );
    assert.equal(r.list[0].task.id, first);
    assert.equal(r.excluded, sort.kind === "number" ? 1 : 0);
  }
  const many = Array.from({ length: 80 }, (_, i) =>
    task(String(i).padStart(2, "0"), ["2026-01-05"]),
  );
  assert.equal(
    aggregate(
      many,
      chart({
        type: "top",
        dimensions: {},
        sort: { kind: "duration" },
        limit: 50,
      }),
      ctx(),
    ).list.length,
    50,
  );
});
test("bar/radar/table runtime cardinality constraints and empty option radar axes", () => {
  const many = Array.from({ length: 201 }, (_, i) =>
    task(String(i), ["2026-01-05"], { owner: String(i) }),
  );
  assert.equal(aggregate(many, chart(), ctx()).errors.length, 1);
  assert.equal(aggregate(many.slice(0, 200), chart(), ctx()).errors.length, 0);
  const divided = chart({
    type: "bar",
    dimensions: { axis: { kind: "progressState" }, series: { kind: "owner" } },
  });
  assert.equal(aggregate(many.slice(0, 12), divided, ctx()).errors.length, 0);
  assert.equal(aggregate(many.slice(0, 13), divided, ctx()).errors.length, 1);
  assert.equal(
    aggregate(
      many.slice(0, 50),
      chart({ type: "bar", dimensions: { axis: { kind: "owner" } } }),
      ctx(),
    ).errors.length,
    0,
  );
  assert.equal(
    aggregate(
      many.slice(0, 51),
      chart({ type: "bar", dimensions: { axis: { kind: "owner" } } }),
      ctx(),
    ).errors.length,
    1,
  );
  const radar = chart({
    type: "radar",
    dimensions: {
      axis: { kind: "property", propertyId: "category" },
      series: { kind: "owner" },
    },
  });
  const owners = many.slice(0, 8).map((t) => ({
    ...t,
    cells: { ...t.cells, category: { value: "a", style: {}, version: 1 } },
  }));
  assert.equal(aggregate(owners, radar, ctx()).errors.length, 0);
  const progressRadar = {
    ...radar,
    dimensions: { axis: { kind: "progressState" }, series: { kind: "owner" } },
  };
  assert.equal(aggregate(rows, progressRadar, ctx()).errors.length, 0);
  assert.equal(
    aggregate(rows.slice(0, 2), progressRadar, ctx()).errors.length,
    1,
  );
  for (const [count, invalid] of [
    [12, 0],
    [13, 1],
  ]) {
    const context = ctx({
      settings: {
        ...settings,
        properties: settings.properties.map((p) =>
          p.id === "category"
            ? {
                ...p,
                values: Array.from({ length: count }, (_, i) => ({
                  ...options[0],
                  id: String(i),
                  label: String(i),
                })),
              }
            : p,
        ),
      },
    });
    assert.equal(
      aggregate(
        [task("axis", ["2026-01-05"], { category: "0" })],
        radar,
        context,
      ).errors.length,
      invalid,
    );
  }
  assert.equal(aggregate(rows.slice(0, 2), radar, ctx()).rows.length, 3);
  assert.equal(aggregate(rows.slice(0, 2), radar, ctx()).errors.length, 0);
  assert.equal(
    aggregate(
      many.slice(0, 9).map((t) => ({
        ...t,
        cells: {
          ...t.cells,
          category: { value: "a", style: {}, version: 1 },
        },
      })),
      radar,
      ctx(),
    ).errors.length,
    1,
  );
});
test("period supports 24 months, rejects reversed/25-month/invalid bounds", () => {
  assert.equal(periodError({ from: "2025-03", to: "2027-02" }), "");
  for (const period of [
    { from: "2025-03", to: "2027-03" },
    { from: "2026-03", to: "2026-02" },
    { from: "", to: "2026-02" },
    { from: "1999-12", to: "2000-01" },
  ])
    assert.ok(periodError(period));
});
test("metric memoization reuses unchanged tasks and ignores color labels/order; changed task, period and current week invalidate", () => {
  const cache = createTaskMetricsCache(),
    context = ctx({ cache });
  const a = taskMetrics(rows[0], context),
    b = taskMetrics(rows[1], context);
  assert.equal(taskMetrics(rows[0], context), a);
  assert.equal(
    taskMetrics(rows[1], {
      ...context,
      settings: {
        ...settings,
        insights: {
          ...settings.insights,
          workColors: settings.insights.workColors
            .toReversed()
            .map((c) => ({ ...c, name: "rename" })),
        },
      },
    }),
    b,
  );
  assert.notEqual(
    taskMetrics(
      {
        ...rows[0],
        cells: { ...rows[0].cells, "2026-01-12": rows[0].cells["2026-01-05"] },
      },
      context,
    ),
    a,
  );
  assert.equal(taskMetrics(rows[1], context), b);
  assert.notEqual(
    taskMetrics(rows[0], { ...context, currentWeek: "2026-01-05" }),
    a,
  );
  assert.notEqual(
    taskMetrics(rows[1], {
      ...context,
      period: { from: "2026-02", to: "2026-02" },
    }),
    b,
  );
});
test("shared strict chart schema rejects invalid IDs, slots, values, display, filter and sort/limit combinations", () => {
  const valid = [
    number("count"),
    chart(),
    chart({ type: "bar", dimensions: { axis: { kind: "owner" } } }),
    chart({
      type: "radar",
      dimensions: { axis: { kind: "durationBand" }, series: { kind: "owner" } },
    }),
    chart({
      type: "top",
      dimensions: {},
      sort: { kind: "duration" },
      limit: 10,
    }),
  ];
  for (const definition of valid)
    assert.equal(insightChartSchema.safeParse(definition).success, true);
  for (const invalid of [
    chart({ id: "bad" }),
    chart({ type: "bar" }),
    chart({ values: [] }),
    number("invalid"),
    chart({
      dimensions: { row: { kind: "property", propertyId: "2026-01-01" } },
    }),
    chart({ display: { orientation: "horizontal" } }),
    chart({ sort: { kind: "duration" } }),
    chart({ unknown: true }),
    chart({ filter: { extra: true } }),
    chart({ values: Array(5).fill({ kind: "count" }) }),
    chart({
      type: "top",
      dimensions: {},
      sort: { kind: "duration" },
      limit: 51,
    }),
  ])
    assert.equal(
      insightChartSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
  const config = {
    workColors: [{ color: "#ABC" }],
    deadlinePropertyId: "removed",
    charts: [chart()],
  };
  assert.equal(
    insightsSettingsSchema.parse(config).workColors[0].color,
    "#aabbcc",
  );
  assert.equal(
    insightsSettingsSchema.safeParse({ ...config, charts: [chart(), chart()] })
      .success,
    false,
  );
  assert.equal(
    insightsSettingsSchema.safeParse({
      ...config,
      workColors: [{ color: "#abc" }, { color: "#AABBCC" }],
    }).success,
    false,
  );
  assert.equal(
    insightsSettingsSchema.safeParse({
      ...config,
      workColors: Array(21).fill({ color: "#ffffff" }),
    }).success,
    false,
  );
  assert.equal(
    insightsSettingsSchema.safeParse({
      ...config,
      charts: Array(31).fill(chart()),
    }).success,
    false,
  );
});

test("report bars retain zero calendar months, all duration bands and explicit missing-deadline states without creating contributors", () => {
  const items = [
    task("a", ["2026-01-26", "2026-02-02"], {
      owner: "one",
      deadline: "2026-02-06",
    }),
    task("b", ["2026-01-05"], { owner: "two" }),
  ];
  const monthly = chart({
    type: "bar",
    dimensions: { axis: { kind: "time", unit: "month", basis: "work" } },
    values: [{ kind: "workWeeks" }],
  });
  const context = ctx({ period: { from: "2025-12", to: "2026-03" } });
  const r = aggregate(items, monthly, context);
  assert.deepEqual(
    r.rows.map((row) => row.key),
    ["2025-12", "2026-01", "2026-02", "2026-03"],
  );
  assert.deepEqual(
    r.cells.map((c) => c.values[0].raw),
    [0, 2, 1, 0],
  );
  assert.equal(r.totals[0].raw, 3);
  assert.deepEqual(
    drillDown(items, monthly, { row: "2026-03", series: "all" }, context),
    [],
  );
  assert.deepEqual(
    drillDown(items, monthly, { row: "2026-02", series: "all" }, context).map(
      (m) => m.task.id,
    ),
    ["a"],
  );
  const duration = chart({
    type: "bar",
    dimensions: { axis: { kind: "durationBand" } },
  });
  const d = aggregate(items, duration, context);
  assert.deepEqual(
    d.rows.map((r) => r.label),
    ["1주", "2~4주", "5~8주", "9주 이상"],
  );
  assert.deepEqual(
    d.cells.map((c) => c.values[0].raw),
    [1, 1, 0, 0],
  );
  const deadlines = chart({
    type: "bar",
    dimensions: { axis: { kind: "deadlineState" } },
  });
  const dl = aggregate(items, deadlines, context);
  assert.equal(dl.cells.find((c) => c.row === "noDeadline").values[0].raw, 1);
  assert.equal(dl.cells.find((c) => c.row === "overdue").values[0].raw, 0);
  assert.equal(
    dl.rows.some((r) => r.key === "noWork"),
    false,
  );
  assert.equal(dl.totals[0].raw, 2);
  assert.deepEqual(
    drillDown(
      items,
      deadlines,
      { row: "noDeadline", series: "all" },
      context,
    ).map((m) => m.task.id),
    ["b"],
  );
  const empty = aggregate([], monthly, context);
  assert.equal(empty.rows.length, 4);
  assert.ok(
    empty.cells.every((c) => c.values[0].raw === 0 && c.taskIds.length === 0),
  );
});
