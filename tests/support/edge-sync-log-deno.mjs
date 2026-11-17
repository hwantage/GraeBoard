// Manual runtime probe: npx deno run tests/support/edge-sync-log-deno.mjs
// Synthetic provider responses; excludes network, authentication and hosted
// isolate contention. Local wall time is not a Supabase CPU quota guarantee.
import {
  createExternalSyncLog,
  EXTERNAL_LOG_BYTES,
} from "../../worker/sync/sync-log-api.mjs";

const team = "11111111-1111-4111-8111-111111111111";
const now = Date.parse("2026-11-17T10:00:00Z");
const env = {
  SITE_TEAM_ID: team,
  GRAEBOARD_LOG_PROJECT_REF: "abcdefghijklmnopqrst",
  GRAEBOARD_LOG_FUNCTION_ID: "22222222-2222-4222-8222-222222222222",
  GRAEBOARD_LOGS_TOKEN: "sbp_fixture_log_token",
};
const request = () =>
  new Request(`https://board.pages.dev/api/teams/${team}/sync/log`, {
    headers: { "X-Requested-With": "WeeklyPlan" },
  });
for (const [name, message] of [
  ["four-byte characters", "🔎".repeat(1200)],
  ["credential-shaped words", "token".repeat(240)],
]) {
  const body = JSON.stringify({
    result: Array.from({ length: 51 }, () => ({
      id: crypto.randomUUID(),
      timestamp_text: "2026-11-17T08:34:36.867000",
      execution_id: crypto.randomUUID(),
      reason: "CPUTime",
      cpu_ms: "2000",
      status: "",
      source: "function_logs",
      message,
    })),
  });
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > EXTERNAL_LOG_BYTES)
    throw new Error("Invalid maximum-page fixture");
  const read = createExternalSyncLog({
    now: () => now,
    fetcher: async () => new Response(body),
  });
  const times = [];
  for (let index = 0; index < 50; index++) {
    const start = performance.now();
    // A fresh env bypasses the cache to measure the full bounded decode path.
    const response = await read(request(), { ...env }, team, async () => {});
    const text = await response.text();
    const elapsed = performance.now() - start;
    if (response.status !== 200 || JSON.parse(text).entries.length !== 50)
      throw new Error(`Unexpected result: ${response.status}`);
    times.push(elapsed);
  }
  const coldMs = times[0];
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      runtime: Deno.version.deno,
      name,
      bytes,
      runs: times.length,
      coldMs,
      medianMs: times[25],
      maxMs: times.at(-1),
    }),
  );
}
