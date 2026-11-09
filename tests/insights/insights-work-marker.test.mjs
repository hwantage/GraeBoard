import test from "node:test";
import assert from "node:assert/strict";
import { cell } from "../../shared/domain.js";
import { styleSchema } from "../../shared/validation.js";
import {
  compactStyle,
  expandStyle,
  pack,
  unpack,
  normalizeStyle,
} from "../../shared/formatting/compact.js";
import {
  commonStyle,
  resetCellStyle,
  copyRowFormatting,
} from "../../shared/formatting/formatting.js";
import { taskWorkWeeks } from "../../shared/insights/insights.js";
import { applySheetCloneOperation } from "../../shared/sheet-clones/sheet-clone-editing.js";

const blue = "#0066cc",
  week = "2026-01-05",
  next = "2026-01-12";
const colors = new Set([blue]);
const task = () => ({ id: "task", teamId: "team", years: [2026], cells: {} });
const rule = (id, style, order, keys = null) => ({
  id,
  rows: ["task"],
  keys,
  style,
  orders: Object.fromEntries(Object.keys(style).map((name) => [name, order])),
});

test("optional work marker is strict and survives compact cells, defaults, row and rule dictionaries", () => {
  for (const work of [true, false, null]) {
    const style = styleSchema.parse({ backgroundColor: blue, work });
    assert.deepEqual(expandStyle(compactStyle(style)), style);
    assert.equal(compactStyle(style).wk, work);
    const data = {
      cells: { [week]: { style } },
      defaultStyle: style,
      rowStyle: style,
      formatting: { revision: 1, rules: [rule("one", style, 1)] },
    };
    assert.deepEqual(unpack(pack(data)), data);
  }
  for (const work of ["true", 1, {}, []])
    assert.equal(styleSchema.safeParse({ work }).success, false);
  assert.equal(
    styleSchema.safeParse({ work: true, unknown: true }).success,
    false,
  );
});

test("identical ordinary backgrounds are never work and override marked default, row and column inheritance", () => {
  const t = task();
  t.cells[week] = { style: { backgroundColor: blue }, value: "", version: 1 };
  assert.deepEqual(taskWorkWeeks(t, colors), []);
  t.cells[week].style.work = true;
  assert.deepEqual(taskWorkWeeks(t, colors), [week]);
  t.formatting = {
    revision: 1,
    rules: [rule("row", { backgroundColor: blue, work: true }, 1)],
  };
  t.cells[week].style = { backgroundColor: blue };
  assert.equal(cell(t, week).style.work, false);
  assert.equal(cell(t, next).style.work, true);
  assert.equal(taskWorkWeeks(t, colors).includes(week), false);
  t.cells[week].style = { work: false };
  assert.equal(cell(t, week).style.work, false);
  t.cells[week].style = { work: null };
  assert.notEqual(cell(t, week).style.work, true);
  t.defaultStyle = { backgroundColor: blue, work: true };
  t.rowStyle = { backgroundColor: blue };
  delete t.formatting;
  assert.equal(cell(t, next).style.work, false);
  delete t.rowStyle;
  assert.equal(cell(t, next).style.work, true);
  t.deletedAt = "deleted";
  assert.deepEqual(taskWorkWeeks(t, colors), []);
});

test("normalization preserves a mark beside a different background and ordinary equal-HEX overrides; reset restores base", () => {
  const defaults = { backgroundColor: blue, work: true };
  assert.deepEqual(normalizeStyle({ backgroundColor: blue }, defaults), {
    work: false,
  });
  assert.deepEqual(
    normalizeStyle({ backgroundColor: blue, work: true }, defaults),
    {},
  );
  assert.deepEqual(
    normalizeStyle({ backgroundColor: "#ff0000", work: true }, defaults),
    { backgroundColor: "#ff0000", work: true },
  );
  const t = task();
  t.formatting = { revision: 1, rules: [rule("work", defaults, 1)] };
  const cleared = resetCellStyle(t, week);
  t.cells[week] = { style: normalizeStyle(cleared, defaults) };
  assert.notEqual(cell(t, week).style.work, true);
  t.defaultStyle = defaults;
  assert.equal(resetCellStyle(t, next).work, true);
});

test("ordered background meaning is independent of text and border orders, including legacy ordinary rules and reset", () => {
  const t = task();
  t.defaultStyle = { backgroundColor: blue, work: true };
  t.formatting = {
    revision: 4,
    rules: [
      rule("work", { backgroundColor: blue, work: true }, 1),
      rule(
        "text",
        { bold: true, borderTop: { style: "solid", color: "#000000" } },
        2,
      ),
      rule("ordinary", { backgroundColor: blue }, 3, [week]),
    ],
  };
  assert.equal(commonStyle(t, next).work, true);
  assert.equal(commonStyle(t, next).bold, true);
  assert.equal(commonStyle(t, week).work, false);
  t.formatting = {
    ...t.formatting,
    rules: [
      ...t.formatting.rules,
      {
        ...rule("reset", {}, 4, [week]),
        orders: { backgroundColor: 4, work: 4 },
      },
    ],
  };
  assert.equal(
    cell(t, week).style.work,
    true,
    "reset removes the ordinary override and restores the marked base",
  );
  assert.equal(cell(t, next).style.work, true);
});

test("row copy and clone formatting operations retain explicit work and ordinary overrides through restore", () => {
  const t = task();
  t.formatting = {
    revision: 1,
    rules: [rule("work", { backgroundColor: blue, work: true }, 1)],
  };
  t.cells[week] = { style: { backgroundColor: blue }, value: "", version: 1 };
  const copy = copyRowFormatting(t);
  assert.equal(
    cell({ ...t, ...copy, formatting: undefined }, week).style.work,
    false,
  );
  assert.equal(
    cell({ ...t, ...copy, formatting: undefined }, next).style.work,
    true,
  );
  const context = { teamId: "team" };
  let result = applySheetCloneOperation(
    [t],
    {
      kind: "format",
      id: "op",
      at: "now",
      scopes: [
        { rows: ["task"], keys: [next], style: { backgroundColor: blue } },
      ],
    },
    context,
  );
  assert.equal(cell(result[0], next).style.work, false);
  result = applySheetCloneOperation(
    result,
    { kind: "restore", at: "later", tasks: [t] },
    context,
  );
  assert.equal(cell(result[0], next).style.work, true);
});
