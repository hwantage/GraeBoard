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
const inPeriod = (week, period) =>
  !period || (weekMonth(week) >= period.from && weekMonth(week) <= period.to);
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
  return weeksForTask(task).filter((key) =>
    colors.has(normalizeWorkColor(cell(task, key).style.backgroundColor)),
  );
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
    startMonth: start && weekMonth(start),
    endMonth: end && weekMonth(end),
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
    const bands = [
      [1, "1주"],
      [4, "2~4주"],
      [8, "5~8주"],
      [Infinity, "9주 이상"],
    ];
    const index = bands.findIndex(([end]) => metric.duration <= end);
    return entry(String(index), bands[index][1]);
  }
  const source =
    dimension.basis === "work"
      ? metric.rangeWeeks
      : [dimension.basis === "start" ? metric.start : metric.end].filter(
          (w) => w && inPeriod(w, ctx.period),
        );
  const groups = new Map();
  for (const week of source) {
    const month = weekMonth(week),
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
        addMetric(groups.get(key), metric, weeks);
        addMetric(seriesGroups.get(column.key), metric, weeks);
        addMetric(all, metric, weeks);
      }
  }
  // Empty option axes still describe the same radar shape for every person.
  if (chart.type === "radar" && rowDimension?.kind === "property") {
    const property = propertiesFor(ctx.settings, true).find(
      (p) => p.id === rowDimension.propertyId,
    );
    for (const option of property?.values || [])
      if (!option.archived && !rows.has(option.id))
        rows.set(option.id, { key: option.id, label: option.label });
  }
  if (!rowDimension && !rows.size)
    rows.set("all", { key: "all", label: "전체" });
  if (!seriesDimension && !series.size)
    series.set("all", { key: "all", label: "전체" });
  const order = (groups, dimension) => {
    const entries = [...groups.values()];
    if (dimension?.kind === "time" || dimension?.kind === "durationBand")
      entries.sort((a, b) => a.key.localeCompare(b.key));
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
  const cells = [];
  if (!errors.length)
    for (const row of rowList)
      for (const column of seriesList) {
        const items =
          groups.get(JSON.stringify([row.key, column.key])) || new Map();
        const values = chart.values.map((definition, index) => {
          const result = measure(items, definition);
          const denominator =
            chart.display?.percent === "series"
              ? measure(seriesGroups.get(column.key) || new Map(), definition)
                  .raw
              : totals[index].raw;
          return {
            ...result,
            value:
              chart.display?.percent && chart.display.percent !== "value"
                ? denominator
                  ? (result.raw / denominator) * 100
                  : 0
                : result.raw,
          };
        });
        cells.push({
          row: row.key,
          series: column.key,
          values,
          taskIds: [...items.keys()],
        });
      }
  const seriesTotals = Object.fromEntries(
    seriesList.map((series) => [
      series.key,
      chart.values.map((definition, index) => {
        const result = measure(
          seriesGroups.get(series.key) || new Map(),
          definition,
        );
        const denominator =
          chart.display?.percent === "series" ? result.raw : totals[index].raw;
        return {
          ...result,
          value:
            chart.display?.percent && chart.display.percent !== "value"
              ? denominator
                ? (result.raw / denominator) * 100
                : 0
              : result.raw,
        };
      }),
    ]),
  );
  return {
    rows: rowList,
    series: seriesList,
    cells,
    totals,
    seriesTotals,
    list: [],
    excluded: 0,
    warnings,
    errors,
    metrics,
  };
}
export function drillDown(tasks, chart, selectedCell, ctx) {
  const result = aggregate(tasks, chart, ctx);
  const cells = !selectedCell
    ? result.cells
    : result.cells.filter(
        (cell) =>
          cell.series === selectedCell.series &&
          (selectedCell.total || cell.row === selectedCell.row),
      );
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
