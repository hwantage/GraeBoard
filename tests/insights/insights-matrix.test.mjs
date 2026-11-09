import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, normalizeSettings } from "../../shared/domain.js";
import { aggregate, drillDown } from "../../shared/insights/insights.js";

const option = (id, label, extra = {}) => ({
  id,
  label,
  backgroundColor: "#edf6f4",
  dotColor: "#177b70",
  emoji: "",
  ...extra,
});
const settings = normalizeSettings({
  ...DEFAULT_SETTINGS,
  properties: [
    ...DEFAULT_SETTINGS.properties,
    {
      id: "category",
      name: "분류",
      kind: "option",
      display: "text",
      values: [
        option("ux", "UX 개선"),
        option("diff", "차별화"),
        option("unused", "아직 없는 분류"),
        option("old", "예전 분류", { archived: true }),
      ],
    },
    { id: "score", name: "점수", kind: "text", display: "text", values: [] },
    {
      id: "deadline",
      name: "목표일",
      kind: "date",
      display: "text",
      values: [],
    },
  ],
  insights: { workColors: [{ color: "#0066cc" }], charts: [] },
});
const ctx = {
  settings,
  users: [
    { id: "a", name: "가람" },
    { id: "b", name: "나래" },
  ],
  period: { from: "2026-01", to: "2026-02" },
  currentWeek: "2026-02-09",
};
const task = (id, owner, category, weeks, score, deadline = "") => ({
  id,
  teamId: "team",
  years: [2026],
  cells: Object.fromEntries([
    ...Object.entries({ owner, category, score, deadline }).map(
      ([key, value]) => [key, { value, style: {}, version: 1 }],
    ),
    ...weeks.map((key) => [
      key,
      {
        value: "",
        style: { backgroundColor: "#0066cc", work: true },
        version: 1,
      },
    ]),
  ]),
});
const tasks = [
  task("a-ux", "a", "ux", ["2026-01-05"], "10", "2026-01-05"),
  task(
    "a-diff",
    "a",
    "diff",
    ["2026-01-26", "2026-02-02", "2026-02-09"],
    "30",
    "2026-01-26",
  ),
  task(
    "b-diff",
    "b",
    "diff",
    ["2026-01-12", "2026-01-19"],
    "bad",
    "2026-02-09",
  ),
  task("b-old", "b", "old", ["2026-01-05"], ""),
  task("b-missing", "b", "removed", ["2026-01-05"], "-5"),
  task("unassigned", "", "", ["2026-01-05"], "0"),
  {
    ...task("deleted", "a", "diff", ["2026-01-05"], "999"),
    deletedAt: "deleted",
  },
  task("outside", "a", "ux", ["2026-03-02"], "999"),
];
const chart = (values = [{ kind: "count" }], extra = {}) => ({
  id: "cmatrix",
  title: "비교",
  type: "table",
  dimensions: {
    row: { kind: "owner" },
    column: { kind: "property", propertyId: "category" },
  },
  values,
  ...extra,
});
const at = (result, row, series, index = 0) =>
  result.cells.find((cell) => cell.row === row && cell.series === series)
    .values[index];
const ids = (chart, selection, context = ctx) =>
  drillDown(tasks, chart, selection, context)
    .map((m) => m.task.id)
    .sort();

test("owner × property matrix keeps zero active categories, observed archived/missing and unassigned; source totals and exact drilldown", () => {
  const c = chart([{ kind: "count" }, { kind: "workWeeks" }]),
    r = aggregate(tasks, c, ctx);
  assert.deepEqual(
    r.series.map((s) => s.key),
    ["ux", "diff", "unused", "old", "removed", ""],
  );
  assert.equal(at(r, "a", "diff").raw, 1);
  assert.equal(at(r, "b", "diff").raw, 1);
  assert.equal(at(r, "b", "ux").raw, 0);
  assert.equal(at(r, "a", "unused").raw, 0);
  assert.deepEqual(
    r.rowTotals.a.map((v) => v.raw),
    [2, 4],
  );
  assert.deepEqual(
    r.rowTotals.b.map((v) => v.raw),
    [3, 4],
  );
  assert.deepEqual(
    r.seriesTotals.diff.map((v) => v.raw),
    [2, 5],
  );
  assert.deepEqual(
    r.totals.map((v) => v.raw),
    [6, 9],
  );
  assert.deepEqual(ids(c, { row: "a", series: "diff" }), ["a-diff"]);
  assert.deepEqual(ids(c, { row: "a", series: "", scope: "row" }), [
    "a-diff",
    "a-ux",
  ]);
  assert.deepEqual(ids(c, { row: "", series: "diff", scope: "series" }), [
    "a-diff",
    "b-diff",
  ]);
  assert.deepEqual(ids(c, { row: "", series: "", scope: "grand" }), [
    "a-diff",
    "a-ux",
    "b-diff",
    "b-missing",
    "b-old",
    "unassigned",
  ]);
  assert.deepEqual(ids(c, { row: "a", series: "unused" }), []);
});

test("row means, numeric exclusions, delay rates and percentages recompute from unique contributors", () => {
  const c = chart([
    { kind: "avgDuration" },
    { kind: "numberAvg", propertyId: "score" },
    { kind: "delayRate" },
    { kind: "numberSum", propertyId: "score" },
  ]);
  const r = aggregate(tasks, c, ctx);
  assert.equal(r.rowTotals.a[0].raw, 2);
  assert.equal(r.rowTotals.a[1].raw, 20);
  assert.equal(r.rowTotals.a[2].raw, 50);
  assert.equal(r.rowTotals.b[1].raw, -5);
  assert.equal(r.rowTotals.b[1].excluded, 1);
  assert.equal(r.totals[1].raw, 8.75);
  assert.ok(Math.abs(r.totals[2].raw - 100 / 3) < 1e-10);
  assert.deepEqual(
    ids(c, { row: "b", series: "", scope: "row", valueIndex: 1 }),
    ["b-missing"],
  );
  assert.deepEqual(
    ids(c, { row: "", series: "", scope: "grand", valueIndex: 2 }),
    ["a-diff", "a-ux", "b-diff"],
  );
  const overall = aggregate(
    tasks,
    chart([{ kind: "count" }], { display: { percent: "total" } }),
    ctx,
  );
  assert.ok(Math.abs(overall.rowTotals.a[0].value - 100 / 3) < 1e-10);
  const series = aggregate(
    tasks,
    chart([{ kind: "count" }], { display: { percent: "series" } }),
    ctx,
  );
  assert.equal(at(series, "a", "diff").value, 50);
  assert.equal(
    series.rowTotals.a[0].value,
    2,
    "series denominators differ; row totals stay raw",
  );
  assert.equal(series.seriesTotals.unused[0].value, 0);
});

test("cross-time row/grand totals deduplicate tasks and union weeks; filters, periods and work marks share the same scope", () => {
  const c = chart(
    [{ kind: "count" }, { kind: "workWeeks" }, { kind: "avgDuration" }],
    {
      dimensions: {
        row: { kind: "owner" },
        column: { kind: "time", unit: "month", basis: "work" },
      },
    },
  );
  const r = aggregate(tasks.slice(0, 3), c, ctx);
  assert.equal(at(r, "a", "2026-01").raw, 2);
  assert.equal(at(r, "a", "2026-02").raw, 1);
  assert.deepEqual(
    r.rowTotals.a.map((v) => v.raw),
    [2, 4, 2],
  );
  assert.deepEqual(
    r.totals.map((v) => v.raw),
    [3, 6, 2],
  );
  assert.deepEqual(ids(c, { row: "a", series: "", scope: "row" }), [
    "a-diff",
    "a-ux",
  ]);
  const filtered = chart([{ kind: "count" }], {
    filter: { propertyFilters: { category: ["diff"] } },
  });
  assert.equal(aggregate(tasks, filtered, ctx).totals[0].raw, 2);
  assert.deepEqual(ids(filtered, { scope: "grand" }), ["a-diff", "b-diff"]);
  const feb = { ...ctx, period: { from: "2026-02", to: "2026-02" } };
  assert.equal(aggregate(tasks, chart(), feb).rowTotals.a[0].raw, 1);
  assert.deepEqual(ids(chart(), { scope: "grand" }, feb), ["a-diff"]);
  const ordinary = {
    ...tasks[0],
    cells: {
      ...tasks[0].cells,
      "2026-01-05": {
        ...tasks[0].cells["2026-01-05"],
        style: { backgroundColor: "#0066cc" },
      },
    },
  };
  assert.equal(aggregate([ordinary], chart(), ctx).totals[0].raw, 0);
});

test("zero/negative numeric cells and empty denominators remain finite; nonadditive percentages use source aggregates", () => {
  const numeric = chart([{ kind: "numberAvg", propertyId: "score" }], {
    display: { percent: "series" },
  });
  const r = aggregate(tasks, numeric, ctx);
  assert.equal(at(r, "b", "diff").value, 0);
  assert.equal(at(r, "b", "diff").excluded, 1);
  assert.equal(at(r, "b", "removed").raw, -5);
  assert.equal(r.rowTotals.b[0].raw, -5);
  assert.ok(r.cells.every((cell) => Number.isFinite(cell.values[0].value)));
  const rates = aggregate(
    tasks,
    chart([{ kind: "delayRate" }], { display: { percent: "total" } }),
    ctx,
  );
  assert.ok(
    Math.abs(rates.rowTotals.a[0].value - 150) < 1e-10,
    "owner's 50% rate / overall one-in-three rate, not a sum of category rates",
  );
  const empty = aggregate(
    tasks,
    chart([{ kind: "numberSum", propertyId: "score" }]),
    { ...ctx, period: { from: "2027-01", to: "2027-01" } },
  );
  assert.equal(empty.totals[0].raw, 0);
  assert.deepEqual(empty.rowTotals, {});
  const missing = aggregate(
    tasks,
    chart([{ kind: "count" }], {
      dimensions: {
        row: { kind: "owner" },
        column: { kind: "property", propertyId: "gone" },
      },
    }),
    ctx,
  );
  assert.match(missing.warnings.join(), /참조 속성/);
  assert.equal(missing.totals[0].raw, 6);
  assert.equal(missing.rowTotals.b[0].raw, 3);
});
