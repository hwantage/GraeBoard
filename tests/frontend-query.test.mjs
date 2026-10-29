import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { setImmediate } from "node:timers/promises";

const moduleURL = (code) =>
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const source = (name) =>
  stripTypeScriptTypes(
    readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"),
    { mode: "transform" },
  );
const { siteFor } = await import(moduleURL(source("site")));
const { queryPolicyFor } = await import(moduleURL(source("query-policy")));
const { joinQuery } = await import(moduleURL(source("shared-query")));

test("explicit site takes priority over legacy auth mode and internal query cadence stays seven seconds", () => {
  const internal = siteFor({
    site: "internal",
    authMode: "access",
    accountLinking: true,
  });
  assert.equal(internal.external, false);
  assert.equal(internal.accountLinking, false);
  const policy = queryPolicyFor(internal);
  assert.equal(policy.pollMs, 7000);
  assert.equal(policy.retryDelay(1, { status: 503 }), 7000);
  assert.equal(policy.retryDelay(8, { status: 503 }), 7000);
  assert.equal(
    policy.retryDelay(1, { status: 429, retryAfterMs: 12000 }),
    12000,
  );
  const external = queryPolicyFor(
    siteFor({ site: "external", authMode: "password" }),
  );
  assert.equal(external.pollMs, 30000);
  assert.equal(external.retryDelay(1, { status: 503 }), 5000);
  assert.equal(external.retryDelay(2, { status: 503 }), 10000);
  assert.equal(external.retryDelay(8, { status: 503 }), 60000);
});

test("shared reads preserve a remaining subscriber and abort once the final subscriber leaves", async () => {
  let finish;
  const work = {
    controller: new AbortController(),
    consumers: new Set(),
    promise: new Promise((resolve) => (finish = resolve)),
  };
  const first = new AbortController(),
    second = new AbortController();
  const one = joinQuery(work, first.signal);
  const two = joinQuery(work, second.signal);
  first.abort();
  assert.equal(await one, undefined);
  assert.equal(work.controller.signal.aborted, false);
  second.abort();
  assert.equal(await two, undefined);
  assert.equal(work.controller.signal.aborted, true);
  assert.equal(work.consumers.size, 0);
  finish(true);
  await work.promise;
});

test("a polling consumer keeps a shared request alive and all consumers release on completion", async () => {
  let finish;
  const work = {
    controller: new AbortController(),
    consumers: new Set(),
    promise: new Promise((resolve) => (finish = resolve)),
  };
  const subscription = new AbortController();
  const first = joinQuery(work, subscription.signal),
    poll = joinQuery(work);
  subscription.abort();
  assert.equal(work.controller.signal.aborted, false);
  finish("latest");
  assert.deepEqual(await Promise.all([first, poll]), [undefined, "latest"]);
  assert.equal(work.consumers.size, 0);
  assert.equal(work.controller.signal.aborted, false);
});

test("only successful business mutations dispatch the local-save signal", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    value: events,
    configurable: true,
  });
  t.after(() =>
    previous
      ? Object.defineProperty(globalThis, "window", previous)
      : delete globalThis.window,
  );
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
  let saves = 0;
  events.addEventListener("graeboard:local-save", () => saves++);
  const code = source("api")
    .replace('"./site"', JSON.stringify(moduleURL(source("site"))))
    .replace(
      '"../shared/compact.js"',
      JSON.stringify(new URL("../shared/compact.js", import.meta.url).href),
    )
    .replace(
      '"../shared/api-error-message.js"',
      JSON.stringify(
        new URL("../shared/api-error-message.js", import.meta.url).href,
      ),
    );
  const { api } = await import(moduleURL(code));
  await api("/auth/login", { method: "POST", body: "{}" });
  await api("/admin/users", { method: "POST", body: "{}" });
  await api("/teams/team/sync/refresh", { method: "POST", body: "{}" });
  await api("/tasks?teamId=team");
  assert.equal(saves, 0);
  await api("/cells/batch", { method: "POST", body: "{}" });
  assert.equal(saves, 1);
});

test("local calendar merges preserve in-flight member data without fetching it again", async (t) => {
  const slots = [],
    effects = [],
    requests = [];
  let cursor = 0;
  const harness = {
    useRef(value) {
      const index = cursor++;
      return (slots[index] ||= { current: value });
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === "function" ? next(slots[index]) : next;
        },
      ];
    },
    useMemo(work) {
      return work();
    },
    useEffect(work, deps) {
      const index = cursor++;
      if (slots[index]?.deps.every((value, i) => Object.is(value, deps[i])))
        return;
      slots[index]?.cleanup?.();
      slots[index] = { deps };
      effects.push(() => (slots[index].cleanup = work()));
    },
    api(path) {
      return new Promise((resolve) => requests.push({ path, resolve }));
    },
  };
  globalThis.__calendarQueryTest = harness;
  t.after(() => delete globalThis.__calendarQueryTest);
  const code = source("useCalendarData")
    .replace(
      '"react"',
      JSON.stringify(
        moduleURL(
          "export const { useEffect, useMemo, useRef, useState } = globalThis.__calendarQueryTest;",
        ),
      ),
    )
    .replace(
      '"./api"',
      JSON.stringify(
        moduleURL("export const { api } = globalThis.__calendarQueryTest;"),
      ),
    );
  const { useCalendarData } = await import(moduleURL(code));
  const queries = [
    { userId: "one", from: "2026-10-01", to: "2026-10-31" },
    { userId: "two", from: "2026-10-01", to: "2026-10-31" },
  ];
  const render = () => {
    cursor = 0;
    const result = useCalendarData("team", queries, 0);
    while (effects.length) effects.shift()();
    return result;
  };
  render();
  requests[0].resolve({
    entries: [{ id: "entry-one", title: "first" }],
    weekly: [],
  });
  await setImmediate();
  const state = render();
  state.updateData((data, query) =>
    query.userId === "two"
      ? {
          ...data,
          entries: data.entries.map((entry) => ({ ...entry, title: "merged" })),
        }
      : data,
  );
  requests[1].resolve({
    entries: [{ id: "entry-two", title: "stale" }],
    weekly: [],
  });
  await setImmediate();
  const complete = render();
  assert.equal(requests.length, 2);
  assert.equal(complete.schedules.get("one").data.entries[0].title, "first");
  assert.equal(complete.schedules.get("two").data.entries[0].title, "merged");
  for (const slot of slots) slot?.cleanup?.();
});
