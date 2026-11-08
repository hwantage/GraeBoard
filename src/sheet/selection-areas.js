import { scopeKey } from "../../shared/formatting.js";
/** @typedef {import("../types").Task} Task */
/** @typedef {import("../types").Point} Point */
/** @typedef {import("../types").Selection} Selection */
/** @typedef {import("../types").SelectionArea} SelectionArea */
/** @typedef {import("../types").FormatRule} FormatRule */
/** @typedef {{r1: number, r2: number, c1: number, c2: number}} Range */
/** @typedef {Range & {kind?: SelectionArea["kind"]}} Area */
/**
 * 실행취소·재실행으로 바뀐 대상. 셀, 행 전체, 공통 서식 규칙의 범위로 나타내고,
 * 사라진 행은 그 자리를 이어받는 행(near, 앞쪽부터)과 열(key)로 나타낸다.
 * @typedef {{
 *   cells?: Point[],
 *   rows?: string[],
 *   rules?: Pick<FormatRule, "rows" | "keys">[],
 *   near?: string[],
 *   key?: string,
 * }} ChangeTargets
 */
/** @typedef {{taskId?: string, key: string, preserveHorizontalScroll?: boolean}} ChangeJump */

// 영역이 많으면 선택 표시가 흩어지므로 바뀐 셀을 감싸는 하나의 범위로 보여 준다.
const MAX_AREAS = 100;

/** @param {Iterable<number>} values @returns {[number, number][]} */
function runs(values) {
  /** @type {[number, number][]} */
  const result = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    const last = result.at(-1);
    if (last && last[1] === value - 1) last[1] = value;
    else if (!last || last[1] < value) result.push([value, value]);
  }
  return result;
}

/**
 * Excel처럼 떨어진 영역도 같은 행 또는 같은 열을 공유하면 하나의 표로 복사한다.
 * 선택한 행과 열이 만나는 셀이 모두 선택되어 있어야 하며, 사이의 선택하지 않은
 * 행·열은 건너뛴다. 맞지 않으면 null이다.
 * @param {Range[]} ranges
 * @returns {{rows: number[], columns: number[]} | null}
 */
export function copyLayout(ranges) {
  // 모든 영역의 경계로 자른 구간은 각 영역에 완전히 포함되거나 겹치지 않는다.
  const bands = (/** @type {[number, number][]} */ spans) => {
    const cuts = [...new Set(spans.flat())].sort((a, b) => a - b);
    return cuts
      .slice(0, -1)
      .map((start, i) => /** @type {[number, number]} */ ([start, cuts[i + 1]]))
      .filter(([start, end]) => spans.some(([a, b]) => a <= start && end <= b));
  };
  const rows = bands(ranges.map((r) => [r.r1, r.r2 + 1]));
  const columns = bands(ranges.map((r) => [r.c1, r.c2 + 1]));
  for (const [top, bottom] of rows)
    for (const [left, right] of columns)
      if (
        !ranges.some(
          (r) =>
            r.r1 <= top &&
            bottom <= r.r2 + 1 &&
            r.c1 <= left &&
            right <= r.c2 + 1,
        )
      )
        return null;
  const expand = (/** @type {[number, number][]} */ spans) =>
    spans.flatMap(([start, end]) =>
      Array.from({ length: end - start }, (_, i) => start + i),
    );
  return { rows: expand(rows), columns: expand(columns) };
}

/** @param {FormatRule | undefined} rule */
function ruleText(rule) {
  return (
    rule &&
    JSON.stringify([
      scopeKey(rule),
      Object.entries(rule.style).sort(),
      Object.entries(rule.orders || {}).sort(),
    ])
  );
}

/**
 * 전후로 달라진 공통 서식 규칙. 서버의 서식 복원과 같이 규칙 ID별로 비교한다.
 * @param {FormatRule[]} [before] @param {FormatRule[]} [after]
 * @returns {FormatRule[]}
 */
export function changedRules(before = [], after = []) {
  const previous = new Map(before.map((rule) => [rule.id, rule]));
  const next = new Map(after.map((rule) => [rule.id, rule]));
  return [...new Set([...previous.keys(), ...next.keys()])]
    .filter((id) => ruleText(previous.get(id)) !== ruleText(next.get(id)))
    .map((id) => /** @type {FormatRule} */ (next.get(id) || previous.get(id)));
}

/**
 * 사라질 행의 자리를 이어받는 행. 바로 아래 행, 없으면 바로 위 행이다.
 * @param {Set<string>} removed @param {Task[]} shown 사라지기 전 화면의 행
 * @returns {string[]}
 */
export function nearbyRows(removed, shown) {
  const index = shown.findIndex((task) => removed.has(task.id));
  if (index < 0) return [];
  const after = shown.slice(index).find((task) => !removed.has(task.id));
  const before = shown
    .slice(0, index)
    .findLast((task) => !removed.has(task.id));
  return [after, before].flatMap((task) => (task ? [task.id] : []));
}

// 순서만 바뀐 행: 공통 행의 상대 순서에서 가장 길게 유지된 순서 밖의 행이다.
/** @param {Task[]} before @param {Task[]} after @param {Set<string>} common */
function movedRows(before, after, common) {
  const order = (/** @type {Task[]} */ tasks) =>
    tasks
      .filter((task) => common.has(task.id))
      .sort((a, b) => a.position - b.position)
      .map((task) => task.id);
  const index = new Map(order(before).map((id, i) => [id, i]));
  const sequence = order(after);
  /** @type {number[]} */
  const tails = [],
    /** @type {number[]} */ ends = [],
    /** @type {number[]} */ parents = [];
  sequence.forEach((id, i) => {
    const value = /** @type {number} */ (index.get(id));
    let low = 0,
      high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle] < value) low = middle + 1;
      else high = middle;
    }
    tails[low] = value;
    ends[low] = i;
    parents[i] = low ? ends[low - 1] : -1;
  });
  const kept = new Set();
  for (let i = ends.length ? ends[ends.length - 1] : -1; i >= 0; i = parents[i])
    kept.add(sequence[i]);
  return sequence.filter((id) => !kept.has(id));
}

/**
 * 사본 시트의 실행취소 전후를 비교해 바뀐 셀·행·서식 규칙을 찾는다.
 * @param {Task[]} before @param {Task[]} after
 * @param {Task[]} shown 실행취소 전 화면의 행(사라지는 행의 자리 계산)
 * @param {string} [key] 사라진 행 대신 선택할 열
 * @returns {ChangeTargets}
 */
export function sheetChanges(before, after, shown, key) {
  const previous = new Map(before.map((task) => [task.id, task]));
  const next = new Set(after.map((task) => task.id));
  const removed = new Set(
    before.filter((task) => !next.has(task.id)).map((task) => task.id),
  );
  /** @type {Point[]} */
  const cells = [];
  const rows = after
    .filter((task) => !previous.has(task.id))
    .map((task) => task.id);
  /** @type {Map<string, FormatRule>} */
  const rules = new Map();
  const same = (/** @type {unknown} */ a, /** @type {unknown} */ b) =>
    a === b || JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
  for (const task of after) {
    const old = previous.get(task.id);
    if (!old || old === task) continue;
    if (
      !same(old.rowStyle, task.rowStyle) ||
      !same(old.defaultStyle, task.defaultStyle)
    ) {
      rows.push(task.id);
      continue;
    }
    if (old.cells !== task.cells)
      for (const column of new Set([
        ...Object.keys(old.cells),
        ...Object.keys(task.cells),
      ])) {
        const a = old.cells[column],
          b = task.cells[column];
        if (
          a !== b &&
          !same([a?.value ?? "", a?.style], [b?.value ?? "", b?.style])
        )
          cells.push({ taskId: task.id, key: column });
      }
    if (old.formatting !== task.formatting)
      for (const rule of changedRules(
        old.formatting?.rules,
        task.formatting?.rules,
      ))
        rules.set(rule.id, rule);
  }
  rows.push(
    ...movedRows(
      before,
      after,
      new Set(before.filter((t) => next.has(t.id)).map((t) => t.id)),
    ),
  );
  if (!cells.length && !rows.length && !rules.size && removed.size)
    return { near: nearbyRows(removed, shown), key };
  return { cells, rows, rules: [...rules.values()] };
}

/**
 * 현재 선택이 바뀐 셀을 모두 담고 있는지. 서버는 값이 그대로인 셀을 저장하지 않으므로
 * 방금 한 작업을 되돌릴 때 선택이 바뀐 셀만으로 줄어들지 않게 한다. 셀이 아주 많으면
 * 담지 않은 것으로 본다.
 * @param {Range[]} outer @param {Range[]} inner
 */
export function coversAll(outer, inner, limit = 10000) {
  let count = 0;
  for (const area of inner)
    for (let r = area.r1; r <= area.r2; r++)
      for (let c = area.c1; c <= area.c2; c++)
        if (
          ++count > limit ||
          !outer.some((o) => o.r1 <= r && r <= o.r2 && o.c1 <= c && c <= o.c2)
        )
          return false;
  return true;
}

/**
 * 바뀐 대상 중 화면에 보이는 셀을 선택하고, 시트 순서의 첫 영역으로 이동할 위치를 정한다.
 * 사각형이면 한 영역, 아니면 여러 영역으로 선택한다. 보이는 대상이 없으면 null이다.
 * @param {ChangeTargets} targets
 * @param {Task[]} tasks 화면에 보이는 행
 * @param {{key: string}[]} columns 화면에 보이는 열
 * @returns {{selection: Selection, jump: ChangeJump | null} | null}
 */
export function changeSelection(targets, tasks, columns) {
  if (!tasks.length || !columns.length) return null;
  const rowIndex = new Map(tasks.map((task, i) => [task.id, i]));
  const columnIndex = new Map(columns.map((column, i) => [column.key, i]));
  const near = targets.near?.find((id) => rowIndex.has(id));
  if (near) {
    const point = {
      taskId: near,
      key:
        targets.key && columnIndex.has(targets.key)
          ? targets.key
          : columns[0].key,
    };
    return { selection: { anchor: point, focus: point }, jump: point };
  }
  const indexes = (
    /** @type {string[]} */ ids,
    /** @type {Map<string, number>} */ index,
  ) =>
    ids.flatMap((id) => {
      const i = index.get(id);
      return i === undefined ? [] : [i];
    });
  let all = false;
  const fullRows = new Set(indexes(targets.rows || [], rowIndex));
  /** @type {Set<number>} */
  const fullColumns = new Set();
  /** @type {Map<number, Set<number>>} 열 → 규칙이 닿는 행 */
  const ruleCells = new Map();
  for (const rule of targets.rules || []) {
    const rows = rule.rows && indexes(rule.rows, rowIndex);
    const keys = rule.keys && indexes(rule.keys, columnIndex);
    if (!rows && !keys) all = true;
    else if (!keys) rows?.forEach((r) => fullRows.add(r));
    else if (!rows) keys.forEach((c) => fullColumns.add(c));
    else
      for (const c of keys) {
        const covered = ruleCells.get(c) || new Set();
        rows.forEach((r) => covered.add(r));
        ruleCells.set(c, covered);
      }
  }
  // 열 서식은 그 열의 모든 행을 규칙에 담으므로 보이는 행을 모두 덮으면 열 선택으로 되돌린다.
  for (const [c, rows] of ruleCells)
    if (rows.size === tasks.length) fullColumns.add(c);
  /** @type {Map<number, Set<number>>} 행 → 열 */
  const cells = new Map();
  const add = (/** @type {number} */ r, /** @type {number} */ c) => {
    if (fullRows.has(r) || fullColumns.has(c)) return;
    const row = cells.get(r) || new Set();
    row.add(c);
    cells.set(r, row);
  };
  for (const [c, rows] of ruleCells) for (const r of rows) add(r, c);
  for (const point of targets.cells || []) {
    const r = rowIndex.get(point.taskId),
      c = columnIndex.get(point.key);
    if (r !== undefined && c !== undefined) add(r, c);
  }
  const lastRow = tasks.length - 1,
    lastColumn = columns.length - 1;
  /** @type {Area[]} */
  let areas = [];
  if (all)
    areas.push({ kind: "all", r1: 0, r2: lastRow, c1: 0, c2: lastColumn });
  else {
    for (const [r1, r2] of runs(fullRows))
      areas.push({ kind: "rows", r1, r2, c1: 0, c2: lastColumn });
    for (const [c1, c2] of runs(fullColumns))
      areas.push({ kind: "columns", r1: 0, r2: lastRow, c1, c2 });
    // 같은 열 구간이 바로 아래 행에도 있으면 하나의 사각형으로 늘린다.
    /** @type {Map<string, Area>} */
    let open = new Map();
    for (const r of [...cells.keys()].sort((a, b) => a - b)) {
      /** @type {Map<string, Area>} */
      const current = new Map();
      for (const [c1, c2] of runs(/** @type {Set<number>} */ (cells.get(r)))) {
        const span = `${c1}:${c2}`,
          area = open.get(span);
        if (area && area.r2 === r - 1) {
          area.r2 = r;
          current.set(span, area);
        } else {
          const created = { r1: r, r2: r, c1, c2 };
          areas.push(created);
          current.set(span, created);
        }
      }
      open = current;
    }
  }
  if (!areas.length) return null;
  if (areas.length > MAX_AREAS)
    areas = [
      {
        r1: Math.min(...areas.map((a) => a.r1)),
        r2: Math.max(...areas.map((a) => a.r2)),
        c1: Math.min(...areas.map((a) => a.c1)),
        c2: Math.max(...areas.map((a) => a.c2)),
      },
    ];
  areas.sort((a, b) => a.r1 - b.r1 || a.c1 - b.c1);
  const area = (/** @type {Area} */ range) =>
    toSelectionArea(range, tasks, columns);
  const [first, ...rest] = areas;
  return {
    selection: {
      ...area(first),
      ...(rest.length ? { areas: rest.map(area) } : {}),
    },
    jump:
      first.kind === "all"
        ? null
        : {
            ...(first.kind === "columns" ? {} : { taskId: tasks[first.r1].id }),
            key: columns[first.c1].key,
            ...(first.kind === "rows"
              ? { preserveHorizontalScroll: true }
              : {}),
          },
  };
}

/**
 * 화면 좌표의 범위를 선택 영역으로 바꾼다. 왼쪽 위에서 오른쪽 아래로 끌어 선택한
 * 것과 같은 방향이어서 Shift 확장은 왼쪽 위에서 시작하고, 행·열 전체는 머리글
 * 선택과 같은 기준 셀을 쓴다.
 * @param {Area} range @param {Task[]} tasks @param {{key: string}[]} columns
 * @returns {SelectionArea}
 */
export function toSelectionArea(range, tasks, columns) {
  const corner = (/** @type {number} */ r, /** @type {number} */ c) => ({
    taskId: tasks[range.kind === "columns" ? 0 : r].id,
    key: columns[range.kind === "rows" ? 0 : c].key,
  });
  return {
    ...(range.kind ? { kind: range.kind } : {}),
    anchor: corner(range.r1, range.c1),
    focus: corner(range.r2, range.c2),
  };
}

/**
 * Excel처럼 선택한 영역에서 범위를 뺀다. 겹치지 않으면 null, 겹치면 남은 위·왼쪽·
 * 오른쪽·아래 사각형이다. 행·열 전체 선택에서 남은 조각이 여전히 표의 모든 열·행에
 * 걸치면 행·열 선택으로 남긴다.
 * @param {Area} area @param {Range} remove
 * @param {number} lastRow @param {number} lastColumn
 * @returns {Area[] | null}
 */
export function subtractRange(area, remove, lastRow, lastColumn) {
  const r1 = Math.max(area.r1, remove.r1),
    r2 = Math.min(area.r2, remove.r2),
    c1 = Math.max(area.c1, remove.c1),
    c2 = Math.min(area.c2, remove.c2);
  if (r1 > r2 || c1 > c2) return null;
  const rows = area.kind === "rows" || area.kind === "all",
    columns = area.kind === "columns" || area.kind === "all";
  /** @param {Range} piece @returns {Area} */
  const typed = (piece) => {
    const allColumns = rows && piece.c1 === 0 && piece.c2 === lastColumn,
      allRows = columns && piece.r1 === 0 && piece.r2 === lastRow;
    return allColumns || allRows
      ? { ...piece, kind: allColumns ? "rows" : "columns" }
      : piece;
  };
  return [
    { r1: area.r1, r2: r1 - 1, c1: area.c1, c2: area.c2 },
    { r1, r2, c1: area.c1, c2: c1 - 1 },
    { r1, r2, c1: c2 + 1, c2: area.c2 },
    { r1: r2 + 1, r2: area.r2, c1: area.c1, c2: area.c2 },
  ]
    .filter((piece) => piece.r1 <= piece.r2 && piece.c1 <= piece.c2)
    .map(typed);
}
