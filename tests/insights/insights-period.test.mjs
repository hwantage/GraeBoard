import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  defaultView,
  visibleWeeks,
} from "../../shared/domain.js";
import {
  aggregate,
  taskMetrics,
  createTaskMetricsCache,
  drillDown,
  periodForWeeks,
} from "../../shared/insights/insights.js";

const settings = normalizeSettings({
  ...DEFAULT_SETTINGS,
  insights: {
    workColors: [{ color: "#0066cc" }],
    charts: [],
    deadlinePropertyId: null,
  },
});
const task = (id, weeks, years = [2026]) => ({
  id,
  teamId: "team",
  years,
  position: 0,
  cells: Object.fromEntries(
    weeks.map((key) => [
      key,
      { value: "", style: { backgroundColor: "#0066cc", work: true } },
    ]),
  ),
});
const chart = (basis = "work", value = "workWeeks") => ({
  id: "cperiod",
  title: "선택 주차",
  type: "bar",
  dimensions: { axis: { kind: "time", unit: "month", basis } },
  values: [{ kind: value }],
});
const context = (weeks, from = "2026-01", to = "2026-12", extra = {}) => ({
  settings,
  users: [],
  currentWeek: "2026-11-09",
  period: { from, to, weeks },
  ...extra,
});
const selection = (keys, year = 2026, startMonth = 1) =>
  visibleWeeks(year, defaultView(year, startMonth))
    .filter((w) => keys.includes(w.key))
    .map(({ key, year, month }) => ({ key, year, month }));

test("exact week membership clips work totals and drilldowns while duration/status use the whole task; cache sees week changes", () => {
  const a = task("a", ["2026-01-05", "2026-01-12", "2026-01-19"]);
  const b = task("b", ["2026-01-05"]);
  const cache = createTaskMetricsCache();
  const ctx = context(selection(["2026-01-12"]), "2026-01", "2026-01", {
    cache,
  });
  const metric = taskMetrics(a, ctx);
  assert.deepEqual(metric.rangeWeeks, ["2026-01-12"]);
  assert.equal(metric.duration, 3);
  assert.equal(metric.progressState, "completed");
  assert.equal(taskMetrics(a, ctx), metric);
  const result = aggregate([a, b], chart(), ctx);
  assert.equal(result.totals[0].raw, 1);
  assert.deepEqual(
    drillDown([a, b], chart(), undefined, ctx).map((m) => m.task.id),
    ["a"],
  );
  const changed = context(
    selection(["2026-01-05", "2026-01-19"]),
    "2026-01",
    "2026-01",
    { cache },
  );
  const next = taskMetrics(a, changed);
  assert.notEqual(next, metric);
  assert.equal(next.weeks, metric.weeks);
  assert.deepEqual(next.rangeWeeks, ["2026-01-05", "2026-01-19"]);
  assert.equal(aggregate([a, b], chart(), changed).totals[0].raw, 3);
});

test("display boundary weeks use the annual calendar month and never the Monday year or unconditional Friday month", () => {
  for (const [year, key, month] of [
    [2000, "1999-12-27", "2000-01"],
    [2026, "2026-12-28", "2026-12"],
  ]) {
    const ctx = context(selection([key], year), month, month);
    const row = task("edge", [key], [year]);
    assert.deepEqual(taskMetrics(row, ctx).rangeWeeks, [key]);
    for (const basis of ["work", "start", "end"]) {
      const result = aggregate([row], chart(basis), ctx);
      assert.deepEqual(
        result.rows.map((r) => r.key),
        [month],
      );
      assert.equal(result.totals[0].raw, 1);
    }
  }
});

test("start/end time charts require the actual selected endpoint week, not another week in the same month", () => {
  const rows = [
    task("a", ["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26"]),
  ];
  const ctx = context(
    selection(["2026-01-12", "2026-01-19"]),
    "2026-01",
    "2026-01",
  );
  assert.equal(aggregate(rows, chart(), ctx).totals[0].raw, 2);
  for (const basis of ["start", "end"]) {
    const result = aggregate(rows, chart(basis, "count"), ctx);
    assert.equal(result.totals[0].raw, 0);
    assert.deepEqual(
      drillDown(rows, chart(basis, "count"), undefined, ctx),
      [],
    );
  }
});

test("hidden/collapsed weeks, sparse months and empty selections cannot reintroduce tasks or fake month buckets", () => {
  const view = {
    ...defaultView(2026),
    fromMonth: 1,
    toMonth: 3,
    hiddenWeeks: ["2026-01-05"],
    collapsedMonths: [2],
  };
  const weeks = visibleWeeks(2026, view).map(({ key, year, month }) => ({
    key,
    year,
    month,
  }));
  const rows = [
    task("hidden", ["2026-01-05"]),
    task("collapsed", ["2026-02-09"]),
    task("shown", ["2026-03-09"]),
  ];
  const ctx = context(weeks, "2026-01", "2026-03");
  const result = aggregate(rows, chart(), ctx);
  assert.deepEqual(
    result.rows.map((r) => r.key),
    ["2026-01", "2026-03"],
  );
  assert.equal(result.totals[0].raw, 1);
  assert.deepEqual(
    drillDown(rows, chart(), undefined, ctx).map((m) => m.task.id),
    ["shown"],
  );
  const empty = aggregate(rows, chart(), context([], "2026-01", "2026-03"));
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.totals[0].raw, 0);
  assert.deepEqual(empty.metrics, []);
});

test("rolling display-month mapping invalidates cached metrics even for the very same selected week", () => {
  const row = task("boundary", ["2026-12-28"], [2026, 2027]);
  const cache = createTaskMetricsCache();
  const december = context(
    [{ key: "2026-12-28", year: 2026, month: 12 }],
    "2026-12",
    "2026-12",
    { cache },
  );
  const january = context(
    [{ key: "2026-12-28", year: 2027, month: 1 }],
    "2027-01",
    "2027-01",
    { cache },
  );
  assert.equal(aggregate([row], chart(), december).rows[0].key, "2026-12");
  assert.equal(aggregate([row], chart(), january).rows[0].key, "2027-01");
  assert.equal(aggregate([row], chart(), december).totals[0].raw, 1);
  assert.equal(aggregate([row], chart(), january).totals[0].raw, 1);
  assert.notEqual(taskMetrics(row, december), taskMetrics(row, january));
  assert.equal(taskMetrics(row, january).duration, 1);
  const quarters = {
    ...chart(),
    dimensions: { axis: { kind: "time", unit: "quarter", basis: "work" } },
  };
  assert.equal(aggregate([row], quarters, december).rows[0].key, "2026-Q4");
  assert.equal(aggregate([row], quarters, january).rows[0].key, "2027-Q1");
});

test("report scope copies visible display metadata and gives an empty selection no selected month or week", () => {
  const visible = visibleWeeks(2026, { ...defaultView(2026), startMonth: 2 });
  const boundary = visible.filter((w) => w.key === "2026-12-28");
  assert.deepEqual(periodForWeeks(boundary, 2026, 2), {
    from: "2027-01",
    to: "2027-01",
    weeks: [{ key: "2026-12-28", year: 2027, month: 1 }],
  });
  const empty = periodForWeeks([], 2026, 2);
  assert.deepEqual(empty, { from: "2026-02", to: "2027-01", weeks: [] });
  assert.deepEqual(
    aggregate([task("a", ["2026-12-28"])], chart(), {
      ...context([]),
      period: empty,
    }).rows,
    [],
  );
});
