import {
  cell,
  value,
  mondayOf,
  todayKey,
  weeksForPeriod,
  filteredTasks,
  propertiesFor,
  propertyOption,
} from "../domain.js";
import { dateSchema } from "../date-validation.js";

const DAY = 86400000;
export const PROGRESS_LABELS = {
  completed: "완료",
  inProgress: "진행 중",
  planned: "예정",
  none: "작업 없음",
};
export const DEADLINE_LABELS = {
  onTimeCompleted: "기한 내 완료",
  delayedCompleted: "지연 완료",
  overdue: "기한 지난 진행 중",
  plannedDelay: "지연 예정",
  onTime: "기한 내 진행",
  noDeadline: "목표일 없음",
  noWork: "작업 없음",
};
const DURATION_BANDS = [
  [1, "1주"],
  [4, "2~4주"],
  [8, "5~8주"],
  [Infinity, "9주 이상"],
];
export const VALUE_LABELS = {
  count: "업무 수",
  completed: "완료 업무 수",
  inProgress: "진행 중 업무 수",
  workWeeks: "작업 주 합",
  avgDuration: "평균 업무 기간",
  medianDuration: "중앙값 업무 기간",
  maxDuration: "최장 업무 기간",
  delayed: "지연 업무 수",
  delayRate: "지연율",
  avgDelay: "평균 지연 주",
  numberSum: "숫자 열 합계",
  numberAvg: "숫자 열 평균",
  numberMax: "숫자 열 최대",
};
export function normalizeWorkColor(color) {
  if (typeof color !== "string" || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color))
    return null;
  const hex = color.slice(1).toLowerCase();
  return "#" + (hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex);
}
export function workColorSet(settings) {
  return new Set(
    (settings.insights?.workColors || [])
      .map((entry) => normalizeWorkColor(entry.color))
      .filter(Boolean),
  );
}
export function weekMonth(week) {
  return new Date(Date.parse(week) + 4 * DAY).toISOString().slice(0, 7);
}
export function monthOffset(month) {
  const [year, number] = month.split("-").map(Number);
  return year * 12 + number - 1;
}
const monthKey = (year, month) => `${year}-${String(month).padStart(2, "0")}`;
// Internal report scope, derived from the exact same visibleWeeks as the sheet.
// Keep the display month: edge weeks can belong to a different month than Friday.
export function periodForWeeks(weeks, year, startMonth = 1) {
  const selected = weeks.map(({ key, year, month }) => ({ key, year, month }));
  const months = [
    ...new Set(selected.map((week) => monthKey(week.year, week.month))),
  ].sort();
  return {
    from: months[0] || monthKey(year, startMonth),
    to:
      months.at(-1) ||
      monthKey(
        year + (startMonth > 1 ? 1 : 0),
        startMonth > 1 ? startMonth - 1 : 12,
      ),
    weeks: selected,
  };
}
const selections = new WeakMap();
function selectedWeeks(period) {
  if (!period || !Array.isArray(period.weeks)) return null;
  if (!selections.has(period))
    selections.set(
      period,
      new Map(
        period.weeks.map((week) => [week.key, monthKey(week.year, week.month)]),
      ),
    );
  return selections.get(period);
}
const displayMonth = (week, period) =>
  selectedWeeks(period)?.get(week) || weekMonth(week);
export function periodError(period) {
  if (
    ![period.from, period.to].every((month) =>
      /^20\d{2}-(0[1-9]|1[0-2])$|^2100-(0[1-9]|1[0-2])$/.test(month),
    )
  )
    return "기간을 확인하세요 (2000~2100년).";
  const count = monthOffset(period.to) - monthOffset(period.from) + 1;
  return count < 1 || count > 24
    ? "기간은 시작 월부터 최대 24개월까지 선택하세요."
    : "";
}
const inPeriod = (week, period) => {
  const selected = selectedWeeks(period);
  return selected
    ? selected.has(week)
    : !period ||
        (weekMonth(week) >= period.from && weekMonth(week) <= period.to);
};
const isWeek = (key) =>
  /^\d{4}-\d{2}-\d{2}$/.test(key) &&
  dateSchema.safeParse(key).success &&
  mondayOf(key) === key;
const yearWeeks = new Map();
function weeksForTask(task) {
  const keys = new Set(Object.keys(task.cells).filter(isWeek));
  // Indefinite row/default formatting also applies to weeks with no cell record.
  for (const year of task.years || []) {
    if (!yearWeeks.has(year))
      yearWeeks.set(
        year,
        weeksForPeriod(year).map((w) => w.key),
      );
    for (const key of yearWeeks.get(year)) keys.add(key);
  }
  for (const rule of task.formatting?.rules || []) {
    if (rule.rows && !rule.rows.includes(task.id)) continue;
    for (const key of rule.keys || []) if (isWeek(key)) keys.add(key);
  }
  return [...keys].sort();
}
export function taskWorkWeeks(task, colors) {
  if (task.deletedAt || !colors.size) return [];
  return weeksForTask(task).filter((key) => {
    const style = cell(task, key).style;
    return (
      style.work === true &&
      colors.has(normalizeWorkColor(style.backgroundColor))
    );
  });
}
export function deadlinePropertyId(settings) {
  if (Object.hasOwn(settings.insights || {}, "deadlinePropertyId"))
    return settings.insights.deadlinePropertyId;
  return propertiesFor(settings, true).some(
    (p) => p.id === "deadline" && p.kind === "date",
  )
    ? "deadline"
    : null;
}

// A cache belongs to one mounted team screen. Task snapshots are immutable;
// unchanged rows retain identity through GET reconciliation and cell SSE merges.
export function createTaskMetricsCache() {
  const entries = new WeakMap();
  const derived = new WeakMap();
  return {
    metrics(task, signature, compute) {
      const prior = derived.get(task);
      if (prior?.signature === signature) return prior.metric;
      const metric = compute();
      derived.set(task, { signature, metric });
      return metric;
    },
    weeks(task, colors) {
      const signature = [...colors].sort().join(",");
      const old = entries.get(task);
      if (old?.signature === signature) return old.weeks;
      const weeks = taskWorkWeeks(task, colors);
      entries.set(task, { signature, weeks });
      return weeks;
    },
  };
}

/** @returns {import("../../src/insights/insights-types").TaskMetrics} */
export function taskMetrics(task, ctx) {
  if (ctx.cache) {
    const signature =
      JSON.stringify([...(ctx.colors || workColorSet(ctx.settings))].sort()) +
      JSON.stringify([
        ctx.period,
        ctx.currentWeek || mondayOf(todayKey()),
        deadlinePropertyId(ctx.settings),
        propertiesFor(ctx.settings, true).find(
          (p) => p.id === deadlinePropertyId(ctx.settings),
        )?.kind,
      ]);
    return ctx.cache.metrics(task, signature, () =>
      calculateTaskMetrics(task, ctx),
    );
  }
  return calculateTaskMetrics(task, ctx);
}
function calculateTaskMetrics(task, ctx) {
  const colors = ctx.colors || workColorSet(ctx.settings);
  const weeks = ctx.cache
    ? ctx.cache.weeks(task, colors)
    : taskWorkWeeks(task, colors);
  const start = weeks[0] || null,
    end = weeks.at(-1) || null;
  const currentWeek = ctx.currentWeek || mondayOf(todayKey());
  const property = propertiesFor(ctx.settings, true).find(
    (p) => p.id === deadlinePropertyId(ctx.settings),
  );
  const rawDeadline = property?.kind === "date" ? value(task, property.id) : "";
  const deadline =
    typeof rawDeadline === "string" && dateSchema.safeParse(rawDeadline).success
      ? rawDeadline
      : null;
  const deadlineWeek = deadline ? mondayOf(deadline) : null;
  const progressState = !start
    ? "none"
    : end < currentWeek
      ? "completed"
      : start > currentWeek
        ? "planned"
        : "inProgress";
  const delayWeeks =
    end && deadlineWeek
      ? Math.max(
          0,
          Math.round((Date.parse(end) - Date.parse(deadlineWeek)) / (7 * DAY)),
        )
      : 0;
  const deadlineState = !start
    ? "noWork"
    : !deadlineWeek
      ? "noDeadline"
      : progressState === "completed"
        ? end <= deadlineWeek
          ? "onTimeCompleted"
          : "delayedCompleted"
        : currentWeek > deadlineWeek
          ? "overdue"
          : end > deadlineWeek
            ? "plannedDelay"
            : "onTime";
  return {
    task,
    weeks,
    rangeWeeks: weeks.filter((week) => inPeriod(week, ctx.period)),
    duration: weeks.length,
    start,
    end,
    startMonth: start && displayMonth(start, ctx.period),
    endMonth: end && displayMonth(end, ctx.period),
    progressState,
    deadlineState,
    deadline,
    delayWeeks,
    delayed:
      deadlineState === "delayedCompleted" || deadlineState === "overdue",
  };
}
export function numericValue(raw) {
  if (raw === "" || raw == null || (typeof raw === "string" && !raw.trim()))
    return { value: null, excluded: false };
  if (typeof raw === "number")
    return Number.isFinite(raw)
      ? { value: raw, excluded: false }
      : { value: null, excluded: true };
  if (typeof raw !== "string") return { value: null, excluded: true };
  const cleaned = raw.trim().replaceAll(",", "");
  return /^[+-]?\d+(\.\d+)?%?$/.test(cleaned) &&
    Number.isFinite(Number(cleaned.replace(/%$/, "")))
    ? { value: Number(cleaned.replace(/%$/, "")), excluded: false }
    : { value: null, excluded: true };
}
export function numericProperties(tasks, settings) {
  return propertiesFor(settings).filter(
    (p) =>
      p.kind === "number" ||
      (p.kind === "text" &&
        tasks.some((task) => numericValue(value(task, p.id)).value !== null)),
  );
}

function dimensionEntries(metric, dimension, ctx) {
  if (!dimension)
    return [{ key: "all", label: "전체", weeks: metric.rangeWeeks }];
  const { task } = metric;
  const entry = (key, label, weeks = metric.rangeWeeks) => [
    { key, label, weeks },
  ];
  if (dimension.kind === "owner") {
    const id = String(value(task, "owner") || "");
    return entry(
      id,
      id ? ctx.users?.find((u) => u.id === id)?.name || id : "(미지정)",
    );
  }
  if (dimension.kind === "property") {
    const property = propertiesFor(ctx.settings, true).find(
      (p) => p.id === dimension.propertyId,
    );
    const stored = String(value(task, dimension.propertyId) || ""),
      option = propertyOption(property, stored);
    return entry(
      stored,
      !stored
        ? "미지정"
        : option
          ? option.archived
            ? `보관된 값: ${option.label}`
            : option.label
          : `보관된 값: ${stored}`,
    );
  }
  if (dimension.kind === "progressState")
    return entry(metric.progressState, PROGRESS_LABELS[metric.progressState]);
  if (dimension.kind === "deadlineState")
    return entry(metric.deadlineState, DEADLINE_LABELS[metric.deadlineState]);
  if (dimension.kind === "durationBand") {
    const index = DURATION_BANDS.findIndex(([end]) => metric.duration <= end);
    return entry(String(index), DURATION_BANDS[index][1]);
  }
  const source =
    dimension.basis === "work"
      ? metric.rangeWeeks
      : [dimension.basis === "start" ? metric.start : metric.end].filter(
          (w) => w && inPeriod(w, ctx.period),
        );
  const groups = new Map();
  for (const week of source) {
    const month = displayMonth(week, ctx.period),
      key =
        dimension.unit === "quarter"
          ? `${month.slice(0, 4)}-Q${Math.ceil(Number(month.slice(5)) / 3)}`
          : month;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(week);
  }
  return [...groups].map(([key, weeks]) => ({
    key,
    label: key,
    weeks: dimension.basis === "work" ? weeks : metric.rangeWeeks,
  }));
}
const average = (values) =>
  values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : 0;
function measure(items, definition) {
  const metrics = [...items.values()],
    durations = metrics.map((m) => m.duration),
    delayed = metrics.filter((m) => m.delayed);
  const eligible = metrics.filter((m) => m.deadline && m.weeks.length);
  const numbers = definition.propertyId
    ? metrics.map((m) => numericValue(value(m.task, definition.propertyId)))
    : [];
  const validNumbers = numbers
    .filter((n) => n.value !== null)
    .map((n) => n.value);
  const sorted = durations.toSorted((a, b) => a - b),
    mid = Math.floor(sorted.length / 2);
  const result = {
    count: () => metrics.length,
    completed: () =>
      metrics.filter((m) => m.progressState === "completed").length,
    inProgress: () =>
      metrics.filter((m) => m.progressState === "inProgress").length,
    workWeeks: () => metrics.reduce((sum, m) => sum + m.rangeWeeks.length, 0),
    avgDuration: () => average(durations),
    medianDuration: () =>
      sorted.length
        ? sorted.length % 2
          ? sorted[mid]
          : (sorted[mid - 1] + sorted[mid]) / 2
        : 0,
    maxDuration: () => durations.reduce((max, n) => Math.max(max, n), 0),
    delayed: () => delayed.length,
    delayRate: () =>
      eligible.length ? (delayed.length / eligible.length) * 100 : 0,
    avgDelay: () => average(delayed.map((m) => m.delayWeeks)),
    numberSum: () => validNumbers.reduce((sum, n) => sum + n, 0),
    numberAvg: () => average(validNumbers),
    numberMax: () =>
      validNumbers.length
        ? validNumbers.reduce((max, n) => Math.max(max, n), -Infinity)
        : 0,
  }[definition.kind]();
  return { raw: result, excluded: numbers.filter((n) => n.excluded).length };
}
function addMetric(items, metric, weeks) {
  const prior = items.get(metric.task.id);
  items.set(metric.task.id, {
    ...metric,
    rangeWeeks: prior
      ? [...new Set([...prior.rangeWeeks, ...weeks])].sort()
      : weeks,
  });
}

export function chartWarnings(chart, settings) {
  const refs = [
    ...Object.values(chart.dimensions),
    ...chart.values,
    chart.sort,
  ].filter(Boolean);
  const warnings = new Set();
  for (const ref of refs)
    if (ref.propertyId) {
      const property = propertiesFor(settings, true).find(
        (p) => p.id === ref.propertyId,
      );
      if (!property) warnings.add(`참조 속성이 없습니다: ${ref.propertyId}`);
      else if (property.archived) warnings.add(`보관된 속성: ${property.name}`);
      else if (ref.kind === "property" && property.kind !== "option")
        warnings.add(`선택형 속성이 아닙니다: ${property.name}`);
      else if (
        ref.kind.startsWith("number") &&
        !["text", "number"].includes(property.kind)
      )
        warnings.add(`숫자 열이 아닙니다: ${property.name}`);
    }
  for (const id of Object.keys(chart.filter?.propertyFilters || {})) {
    const property = propertiesFor(settings, true).find((p) => p.id === id);
    if (!property || property.archived)
      warnings.add(
        `${property ? "보관된 속성" : "참조 속성이 없습니다"}: ${property?.name || id}`,
      );
  }
  return [...warnings];
}

/** @returns {import("../../src/insights/insights-types").ChartResult} */
export function aggregate(tasks, chart, ctx) {
  const selected = filteredTasks(
    tasks.filter((task) => !task.deletedAt),
    chart.filter || {},
    ctx.settings,
    ctx.users || [],
  );
  const metrics = selected
    .map((task) => taskMetrics(task, ctx))
    .filter((metric) => metric.rangeWeeks.length);
  const warnings = chartWarnings(chart, ctx.settings);
  if (chart.type === "top") {
    let excluded = 0;
    const list = metrics
      .flatMap((metric) => {
        const n =
          chart.sort.kind === "number"
            ? numericValue(value(metric.task, chart.sort.propertyId))
            : {
                value:
                  chart.sort.kind === "delayWeeks"
                    ? metric.delayWeeks
                    : metric.duration,
                excluded: false,
              };
        if (n.excluded) excluded++;
        return n.value === null ? [] : [{ ...metric, sortValue: n.value }];
      })
      .sort(
        (a, b) =>
          b.sortValue - a.sortValue || a.task.id.localeCompare(b.task.id),
      )
      .slice(0, chart.limit);
    return {
      rows: [],
      series: [],
      cells: [],
      totals: [],
      seriesTotals: {},
      rowTotals: {},
      list,
      excluded,
      warnings,
      errors: [],
      metrics,
    };
  }
  const rowDimension =
    chart.type === "table" ? chart.dimensions.row : chart.dimensions.axis;
  const seriesDimension =
    chart.type === "table" ? chart.dimensions.column : chart.dimensions.series;
  const rows = new Map(),
    series = new Map(),
    groups = new Map(),
    all = new Map(),
    rowGroups = new Map(),
    seriesGroups = new Map();
  for (const metric of metrics) {
    for (const row of dimensionEntries(metric, rowDimension, ctx))
      for (const column of dimensionEntries(metric, seriesDimension, ctx)) {
        const weeks = row.weeks.filter((week) => column.weeks.includes(week));
        if (!weeks.length) continue;
        rows.set(row.key, { key: row.key, label: row.label });
        series.set(column.key, { key: column.key, label: column.label });
        const key = JSON.stringify([row.key, column.key]);
        if (!groups.has(key)) groups.set(key, new Map());
        if (!seriesGroups.has(column.key))
          seriesGroups.set(column.key, new Map());
        if (!rowGroups.has(row.key)) rowGroups.set(row.key, new Map());
        addMetric(groups.get(key), metric, weeks);
        addMetric(rowGroups.get(row.key), metric, weeks);
        addMetric(seriesGroups.get(column.key), metric, weeks);
        addMetric(all, metric, weeks);
      }
  }
  // Keep declared empty categories in comparative views, so a zero remains
  // visible instead of changing the matrix shape or legend between people.
  const completeOptions = (groups, dimension) => {
    if (dimension?.kind !== "property") return;
    const property = propertiesFor(ctx.settings, true).find(
      (p) => p.id === dimension.propertyId,
    );
    for (const option of property?.values || [])
      if (!option.archived && !groups.has(option.id))
        groups.set(option.id, { key: option.id, label: option.label });
  };
  if (chart.type === "radar") completeOptions(rows, rowDimension);
  if (chart.type === "bar") {
    if (
      rowDimension?.kind === "time" &&
      rowDimension.basis === "work" &&
      !periodError(ctx.period)
    ) {
      const selected = selectedWeeks(ctx.period);
      const months = selected
        ? [...new Set(selected.values())]
        : Array.from(
            {
              length:
                monthOffset(ctx.period.to) - monthOffset(ctx.period.from) + 1,
            },
            (_, i) => {
              const offset = monthOffset(ctx.period.from) + i;
              return monthKey(Math.floor(offset / 12), (offset % 12) + 1);
            },
          );
      for (const month of months) {
        const key =
          rowDimension.unit === "quarter"
            ? `${month.slice(0, 4)}-Q${Math.ceil(Number(month.slice(5)) / 3)}`
            : month;
        if (!rows.has(key)) rows.set(key, { key, label: key });
      }
    }
    if (rowDimension?.kind === "durationBand")
      DURATION_BANDS.forEach(([, label], index) =>
        rows.set(String(index), { key: String(index), label }),
      );
    if (rowDimension?.kind === "deadlineState")
      for (const [key, label] of Object.entries(DEADLINE_LABELS))
        if (key !== "noWork") rows.set(key, { key, label });
  }
  if ((chart.type === "table" && rowDimension) || chart.type === "bar")
    completeOptions(series, seriesDimension);
  if (!rowDimension && !rows.size)
    rows.set("all", { key: "all", label: "전체" });
  if (!seriesDimension && !series.size)
    series.set("all", { key: "all", label: "전체" });
  const order = (groups, dimension) => {
    const entries = [...groups.values()];
    if (dimension?.kind === "time" || dimension?.kind === "durationBand")
      entries.sort((a, b) => a.key.localeCompare(b.key));
    if (dimension?.kind === "deadlineState") {
      const states = Object.keys(DEADLINE_LABELS);
      entries.sort((a, b) => states.indexOf(a.key) - states.indexOf(b.key));
    }
    if (dimension?.kind === "property") {
      const property = propertiesFor(ctx.settings, true).find(
        (p) => p.id === dimension.propertyId,
      );
      const ranks = new Map(
        (property?.values || []).map((option, index) => [option.id, index]),
      );
      entries.sort(
        (a, b) =>
          (ranks.get(a.key) ?? Infinity) - (ranks.get(b.key) ?? Infinity),
      );
    }
    return entries;
  };
  const rowList = order(rows, rowDimension),
    seriesList = order(series, seriesDimension),
    errors = [];
  if (chart.type === "bar" && (rowList.length > 50 || seriesList.length > 12))
    errors.push(
      "막대는 X 칸 최대 50개, 나누기 최대 12개입니다. 필터를 좁혀 주세요.",
    );
  if (
    chart.type === "radar" &&
    (rowList.length < 3 || rowList.length > 12 || seriesList.length > 8)
  )
    errors.push(
      "레이더는 축 3~12개, 계열 최대 8개입니다. 기준이나 필터를 바꿔 주세요.",
    );
  if (chart.type === "table" && rowList.length > 200)
    errors.push("표는 최대 200행입니다. 필터를 좁혀 주세요.");
  const totals = chart.values.map((definition) => measure(all, definition));
  const displayed = (result, denominator) => ({
    ...result,
    value:
      chart.display?.percent && chart.display.percent !== "value"
        ? denominator
          ? (result.raw / denominator) * 100
          : 0
        : result.raw,
  });
  const seriesMeasures = new Map(
    seriesList.map((column) => [
      column.key,
      chart.values.map((definition) =>
        measure(seriesGroups.get(column.key) || new Map(), definition),
      ),
    ]),
  );
  const seriesTotals = Object.fromEntries(
    seriesList.map((column) => [
      column.key,
      seriesMeasures
        .get(column.key)
        .map((result, index) =>
          displayed(
            result,
            chart.display?.percent === "series"
              ? result.raw
              : totals[index].raw,
          ),
        ),
    ]),
  );
  const rowTotals = Object.fromEntries(
    rowList.map((row) => [
      row.key,
      chart.values.map((definition, index) => {
        const result = measure(rowGroups.get(row.key) || new Map(), definition);
        // Series percentages have different column denominators. A row total
        // therefore stays in raw units; summing those percentages would mislead.
        return chart.display?.percent === "series"
          ? { ...result, value: result.raw }
          : displayed(result, totals[index].raw);
      }),
    ]),
  );
  const cells = [];
  if (!errors.length)
    for (const row of rowList)
      for (const column of seriesList) {
        const items =
          groups.get(JSON.stringify([row.key, column.key])) || new Map();
        cells.push({
          row: row.key,
          series: column.key,
          values: chart.values.map((definition, index) =>
            displayed(
              measure(items, definition),
              chart.display?.percent === "series"
                ? seriesMeasures.get(column.key)[index].raw
                : totals[index].raw,
            ),
          ),
          taskIds: [...items.keys()],
        });
      }
  return {
    rows: rowList,
    series: seriesList,
    cells,
    totals,
    seriesTotals,
    rowTotals,
    list: [],
    excluded: 0,
    warnings,
    errors,
    metrics,
  };
}
export function drillDown(tasks, chart, selectedCell, ctx) {
  const result = aggregate(tasks, chart, ctx);
  const cells =
    !selectedCell || selectedCell.scope === "grand"
      ? result.cells
      : result.cells.filter((cell) => {
          if (selectedCell.scope === "row")
            return cell.row === selectedCell.row;
          if (selectedCell.scope === "series" || selectedCell.total)
            return cell.series === selectedCell.series;
          return (
            cell.series === selectedCell.series && cell.row === selectedCell.row
          );
        });
  const ids = new Set(cells.flatMap((cell) => cell.taskIds));
  const definition = chart.values[selectedCell?.valueIndex || 0];
  return result.metrics.filter((metric) => {
    if (!ids.has(metric.task.id)) return false;
    if (definition.kind === "completed")
      return metric.progressState === "completed";
    if (definition.kind === "inProgress")
      return metric.progressState === "inProgress";
    if (definition.kind === "delayed" || definition.kind === "avgDelay")
      return metric.delayed;
    if (definition.kind === "delayRate") return !!metric.deadline;
    if (definition.kind.startsWith("number"))
      return (
        numericValue(value(metric.task, definition.propertyId)).value !== null
      );
    return true;
  });
}
