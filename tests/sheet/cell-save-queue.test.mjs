import test from "node:test";
import assert from "node:assert/strict";
import {
  enqueue,
  project,
  rebase,
  request,
  watch,
} from "../../src/sheet/cell-save-queue.js";

const SEEN = "2026-11-14T00:00:00.000Z";
const task = (id, cells = {}, extra = {}) => ({
  id,
  teamId: "team",
  updatedAt: SEEN,
  formatting: { revision: 3, rules: [] },
  cells,
  ...extra,
});
const cellAt = (value, version, style = {}) => ({ value, style, version });
const change = (taskId, key, expectedVersion, value) => ({
  taskId,
  key,
  expectedVersion,
  expectedFormatRevision: 3,
  value,
});
const payload = (changes, format) => ({
  operationId: "op",
  createdAt: "now",
  changes,
  ...(format ? { format } : {}),
});
const saved = (cells, before, extra = {}) => ({
  cells,
  before,
  operationId: "op",
  savedAt: "now",
  ...extra,
});
const rowFormat = (rows, style = { bold: true }) =>
  payload([], {
    teamId: "team",
    expectedRevision: 3,
    scopes: [{ rows, keys: null, style }],
    expectedTasks: Object.fromEntries(rows.map((id) => [id, SEEN])),
  });

test("a change on a cell with an own change ahead builds on that change's outcome", () => {
  const b = enqueue(payload([change("x", "title", 4, "B")]), 2);
  assert.equal(b.bases.get("c:x:title"), 4);
  // A, ahead of B on the same cell, is saved: B now expects what A left.
  const [moved] = rebase(
    [b],
    saved(
      [{ taskId: "x", key: "title", ...cellAt("A", 7) }],
      [{ taskId: "x", key: "title", ...cellAt("old", 4) }],
    ),
  );
  assert.equal(request(moved, "later").changes[0].expectedVersion, 7);
  assert.equal(request(moved, "later").createdAt, "later");
});

test("someone else's change is never absorbed: the queued change still conflicts", () => {
  const b = enqueue(payload([change("x", "title", 4, "B")]), 2);
  // Someone else saved version 5 before the own save replaced it.
  const [kept] = rebase(
    [b],
    saved(
      [{ taskId: "x", key: "title", ...cellAt("A", 6) }],
      [{ taskId: "x", key: "title", ...cellAt("theirs", 5) }],
    ),
  );
  assert.equal(kept, b);
  assert.equal(request(kept, "later").changes[0].expectedVersion, 4);
  // A result that does not touch a change leaves it as it was.
  const other = enqueue(payload([change("y", "title", 2, "C")]), 3);
  const [same] = rebase(
    [other],
    saved(
      [{ taskId: "x", key: "title", ...cellAt("Z", 8) }],
      [{ taskId: "x", key: "title", ...cellAt("A", 5) }],
    ),
  );
  assert.equal(same, other);
});

test("an own change that moves a cell it did not name (a format clearing its style) moves the expectation", () => {
  const typed = enqueue(payload([change("x", "title", 4, "B")]), 2);
  const [moved] = rebase(
    [typed],
    saved(
      [{ taskId: "x", key: "title", ...cellAt("old", 6) }],
      [{ taskId: "x", key: "title", ...cellAt("old", 4) }],
    ),
  );
  assert.equal(moved.bases.get("c:x:title"), 6);
});

test("a format change follows the formatting revision and row stamps of own changes ahead", () => {
  const format = enqueue(rowFormat(["x"]), 2);
  assert.equal(format.bases.get("t:x"), SEEN);
  assert.equal(format.bases.get("f"), 3);
  // An own cell save on the row ahead of it: the row is what the format saw.
  const [moved] = rebase(
    [format],
    saved(
      [{ taskId: "x", key: "title", ...cellAt("v", 2) }],
      [{ taskId: "x", key: "title", ...cellAt("", 1) }],
      {
        updatedAt: { x: "2026-11-14T00:00:05.000Z" },
        previousUpdatedAt: { x: SEEN },
        formatRevision: 3,
      },
    ),
  );
  const sent = request(moved, "later").format;
  assert.equal(sent.expectedTasks.x, "2026-11-14T00:00:05.000Z");
  // A cell save leaves the formatting revision as it is.
  assert.equal(sent.expectedRevision, 3);
  // A later change of a cell's style follows an own format's new revision.
  const styled = enqueue(
    payload([{ ...change("y", "title", 0), style: { italic: true } }]),
    3,
  );
  const [after] = rebase(
    [styled],
    saved([], [], { formatRevision: 4, previousFormatRevision: 3 }),
  );
  assert.equal(request(after, "later").changes[0].expectedFormatRevision, 4);
});

test("someone else's change of the row before an own cell save keeps the queued format conflicting", () => {
  const format = enqueue(rowFormat(["x"]), 2);
  // Someone else changed another cell of the row (stamp :03) before the own
  // cell save (stamp :05) reached the server.
  const own = saved(
    [{ taskId: "x", key: "title", ...cellAt("v", 2) }],
    [{ taskId: "x", key: "title", ...cellAt("", 1) }],
    {
      updatedAt: { x: "2026-11-14T00:00:05.000Z" },
      previousUpdatedAt: { x: "2026-11-14T00:00:03.000Z" },
      formatRevision: 3,
    },
  );
  const [kept] = rebase([format], own);
  assert.equal(request(kept, "later").format.expectedTasks.x, SEEN);
  // A result without the stamps before (a replayed operation or an older
  // server) moves nothing: the server refuses the format and the user
  // decides, instead of it restyling over an unseen change.
  const { previousUpdatedAt: _, ...replayed } = own;
  const [held] = rebase([format], replayed);
  assert.equal(held, format);
  // Someone else's formatting meanwhile: the revision before the own format
  // save is not the one seen.
  const [stays] = rebase(
    [format],
    saved([], [], { formatRevision: 6, previousFormatRevision: 5 }),
  );
  assert.equal(stays.bases.get("f"), 3);
});

test("the sheet shows queued values, styles and formats with the version each change expects", () => {
  const tasks = [
    task("x", { title: cellAt("old", 4, { bold: true }) }),
    task("y", { title: cellAt("y", 2, { color: "#111111" }) }),
  ];
  const a = enqueue(
    payload([{ ...change("x", "title", 4, "new"), style: { italic: true } }]),
    1,
  );
  const f = enqueue(
    payload([], {
      teamId: "team",
      expectedRevision: 3,
      scopes: [{ rows: ["y"], keys: ["title"], style: { color: "#222222" } }],
      expectedTasks: { y: SEEN },
    }),
    2,
  );
  const shown = project(tasks, [a, f]);
  assert.deepEqual(shown[0].cells.title, {
    value: "new",
    style: { italic: true },
    version: 4,
  });
  // The format's rule is on every row of the team and wins over older rules;
  // the cell's own colour gives way to it.
  assert.equal(shown[1].formatting.rules.length, 1);
  assert.equal(shown[1].formatting.rules[0].style.color, "#222222");
  assert.equal(shown[0].formatting, shown[1].formatting);
  assert.deepEqual(shown[1].cells.title.style, {});
  // The stored sheet is untouched.
  assert.equal(tasks[0].cells.title.value, "old");
  assert.deepEqual(tasks[1].cells.title.style, { color: "#111111" });
  assert.equal(project(tasks, []), tasks);
});

test("an editor opened over queued own edits of its cell follows each of them", () => {
  // The editor shows b, queued behind a, at the version both expect.
  let editor = watch("x", "title", 1);
  [editor] = rebase(
    [editor],
    saved(
      [{ taskId: "x", key: "title", ...cellAt("a", 2) }],
      [{ taskId: "x", key: "title", ...cellAt("old", 1) }],
    ),
  );
  [editor] = rebase(
    [editor],
    saved(
      [{ taskId: "x", key: "title", ...cellAt("b", 3) }],
      [{ taskId: "x", key: "title", ...cellAt("a", 2) }],
    ),
  );
  assert.equal(editor.bases.get("c:x:title"), 3);
  // Committed now, the edit expects version 3 whatever its payload says.
  const c = enqueue(payload([change("x", "title", 1, "c")]), 3, editor.bases);
  assert.equal(request(c, "later").changes[0].expectedVersion, 3);
});

test("a save forced over someone else's change does not carry the changes made on top of it", () => {
  const typed = enqueue(payload([change("x", "title", 1, "mine")]), 2);
  // Someone else saved version 2; the bold ahead was refused, then forced: it
  // replaced 2 and left 3.
  const [kept] = rebase(
    [typed],
    saved(
      [{ taskId: "x", key: "title", ...cellAt("theirs", 3) }],
      [{ taskId: "x", key: "title", ...cellAt("theirs", 2) }],
    ),
  );
  // The typed value still expects what it saw, version 1, and conflicts.
  assert.equal(kept.bases.get("c:x:title"), 1);
});

test("a queued format clears the own style of a cell a queued change created", () => {
  const tasks = [task("x", {})];
  const styled = enqueue(
    payload([{ ...change("x", "note", 0), style: { bold: true } }]),
    1,
  );
  const format = enqueue(rowFormat(["x"], { bold: false }), 2);
  assert.deepEqual(project(tasks, [styled, format])[0].cells.note.style, {});
});

test("a queued reset format clears every own style name of the cells in its scope", () => {
  const tasks = [
    task("x", { title: cellAt("t", 1, { bold: true, color: "#111111" }) }),
    task("y", { title: cellAt("u", 1, { bold: true }) }),
  ];
  const reset = enqueue(
    payload([], {
      teamId: "team",
      expectedRevision: 3,
      scopes: [{ rows: ["x"], keys: null, style: {}, reset: true }],
      expectedTasks: { x: SEEN },
    }),
    1,
  );
  const shown = project(tasks, [reset]);
  assert.deepEqual(shown[0].cells.title.style, {});
  // A row outside the scope keeps its own style and its identity.
  assert.equal(shown[1].cells, tasks[1].cells);
});

test("a format forced over someone else's formatting leaves the queued changes expecting what they saw", () => {
  const styled = enqueue(
    payload([{ ...change("x", "title", 2), style: { italic: true } }]),
    2,
  );
  const format = enqueue(rowFormat(["x"]), 3);
  // The forced format replaced revision 5 (someone else's), not 3, and a
  // row stamp the queued changes never saw.
  const forced = saved([], [], {
    formatRevision: 6,
    previousFormatRevision: 5,
    updatedAt: { x: "2026-11-14T00:00:09.000Z" },
    previousUpdatedAt: { x: "2026-11-14T00:00:07.000Z" },
  });
  const [keptStyle, keptFormat] = rebase([styled, format], forced);
  assert.equal(keptStyle, styled);
  assert.equal(keptFormat, format);
});
