import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

// Real app pages and their production event broker consume a real Git change.
// Freeze only page timers after initial load to separate change-induced requests
// from the normal seven-second polling; advance less than one polling interval
// while delivering the metadata event and checking rendered row order.
export async function measureBrowserMetadata(
  fixture,
  peer,
  { clients = 30 } = {},
) {
  const query = `/tasks?teamId=${fixture.teamId}&year=2026`,
    tasks = (await peer.api(query)).tasks.toSorted(
      (a, b) => a.position - b.position,
    );
  if (tasks.length < 2)
    throw new Error("Browser metadata fixture needs at least two tasks");
  const target = tasks[1],
    position = tasks[0].position - 1,
    { chromium } = await import("@playwright/test"),
    browser = await chromium.launch(),
    contexts = [],
    pages = [],
    observed = [];
  let recording = false;
  const tokenClients = new Map(
    fixture.tokens
      .slice(0, clients)
      .map((token, index) => ["weekly_session=" + token, index]),
  );
  const observeRequest = (request, response) => {
    const index = tokenClients.get(request.headers.cookie),
      counts = observed[index];
    if (!counts) return;
    const pathname = new URL(request.url, fixture.origin).pathname;
    if (request.method === "GET" && pathname === "/api/tasks") {
      if (recording) counts.taskRequests++;
      counts.pendingTasks++;
      counts.lastActivity = performance.now();
      response.once("finish", () => {
        counts.pendingTasks--;
        counts.lastActivity = performance.now();
      });
    }
    if (request.method === "POST" && pathname === "/api/events") {
      const connection = ++counts.eventStreams,
        write = response.write;
      let buffer = "";
      response.write = function (chunk, ...args) {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const line = frame
            .split("\n")
            .find((value) => value.startsWith("data: "));
          if (line && frame.includes("event: stream")) {
            const event = JSON.parse(line.slice(6));
            const stream = request.body?.streams?.find(
              (value) => value.id === event.id,
            );
            if (
              event.event === "ready" &&
              stream?.path.startsWith("/api/cells/events")
            ) {
              counts.readyConnection = connection;
              counts.lastActivity = performance.now();
            }
          }
        }
        return write.call(this, chunk, ...args);
      };
    }
  };
  fixture.server.on("request", observeRequest);
  try {
    for (let i = 0; i < clients; i++) {
      const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
      });
      contexts.push(context);
      await context.addCookies([
        {
          name: "weekly_session",
          value: fixture.tokens[i],
          url: fixture.origin,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const page = await context.newPage(),
        counts = {
          taskRequests: 0,
          eventStreams: 0,
          readyConnection: 0,
          pendingTasks: 0,
          lastActivity: performance.now(),
          pageErrors: [],
        };
      pages.push(page);
      observed.push(counts);
      page.on("pageerror", (error) => counts.pageErrors.push(error.message));
      const userId = fixture.db
        .prepare("SELECT user_id FROM sessions WHERE token=?")
        .get(
          createHash("sha256").update(fixture.tokens[i]).digest("hex"),
        ).user_id;
      await page.addInitScript(
        ({ userId, teamId }) =>
          localStorage.setItem(
            `weekly-board:${userId}`,
            JSON.stringify({ teamId, year: 2026 }),
          ),
        { userId, teamId: fixture.teamId },
      );
      await page.clock.install();
      await page.goto(fixture.origin);
      await page
        .locator(`[data-row-id="${target.id}"]`)
        .waitFor({ state: "visible" });
      await page.waitForFunction(
        () => document.querySelectorAll("[data-row-id]").length >= 2,
      );
      await page.clock.pauseAt(
        new Date(await page.evaluate(() => Date.now() + 100)),
      );
    }
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await Promise.all(pages.map((page) => page.clock.runFor(50)));
      await new Promise((resolve) => setTimeout(resolve, 25));
      ready = observed.every(
        (counts) =>
          counts.readyConnection > 0 &&
          counts.readyConnection === counts.eventStreams &&
          counts.pendingTasks === 0 &&
          performance.now() - counts.lastActivity > 150,
      );
      if (ready) break;
    }
    if (!ready)
      throw new Error(
        "Browser initial queries and cell SSE subscriptions did not settle: " +
          JSON.stringify(observed),
      );
    recording = true;
    await peer.api(
      "/tasks/" + target.id,
      { updatedAt: target.updatedAt, position },
      "PATCH",
    );
    await peer.app.locals.sync.get(fixture.teamId).run();
    const start = performance.now();
    await fixture.app.locals.sync
      .get(fixture.teamId)
      .run({ receiveOnly: true });
    let rendered = [];
    for (let frame = 0; frame < 20; frame++) {
      await Promise.all(pages.map((page) => page.clock.runFor(50)));
      rendered = await Promise.all(
        pages.map((page) =>
          page.locator("[data-row-id]").first().getAttribute("data-row-id"),
        ),
      );
      if (rendered.every((id) => id === target.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Allow request handlers scheduled by the same update to run before counting.
    await Promise.all(pages.map((page) => page.clock.runFor(100)));
    const result = {
      browser: "chromium",
      browserVersion: browser.version(),
      contexts: clients,
      renderedClients: rendered.filter((id) => id === target.id).length,
      taskSnapshotRequests: observed.reduce(
        (sum, counts) => sum + counts.taskRequests,
        0,
      ),
      perClientSnapshotRequests: observed.map((counts) => counts.taskRequests),
      eventBrokerStreams: observed.map((counts) => counts.eventStreams),
      readyCellStreams: observed.map((counts) => counts.readyConnection),
      receiveToAllRenderedMs: performance.now() - start,
      pageErrors: observed.flatMap((counts) => counts.pageErrors),
      periodicPolling:
        "Page timers are paused after load; after the initial query/SSE-ready barrier, at most 1.1s is advanced to isolate SSE-induced refetches from the normal 7s poll.",
    };
    if (
      result.renderedClients !== clients ||
      result.taskSnapshotRequests ||
      result.pageErrors.length
    )
      throw new Error(
        "Browser metadata convergence/refetch check failed: " +
          JSON.stringify(result),
      );
    return result;
  } finally {
    fixture.server.off("request", observeRequest);
    await Promise.all(contexts.map((context) => context.close()));
    await browser.close();
  }
}
