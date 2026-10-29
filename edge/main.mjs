import pg from "pg";
import { createEdgeHandler } from "./handler.mjs";
import { resourceBindings } from "./resources.mjs";
import setupGuide from "../docs/CLOUD_SETUP.md";
import { setupGuideHtml } from "../shared/setup-guide.js";

const settings = Deno.env.toObject();
const pool = new pg.Pool({
  connectionString: settings.GRAEBOARD_DATABASE_URL || settings.SUPABASE_DB_URL,
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 15000,
});
pool.on("error", (error) =>
  console.error("PostgreSQL pool", { code: error.code }),
);
const resources = resourceBindings(settings);
const guideHtml = setupGuideHtml(setupGuide);
const env = {
  ...settings,
  // Bound cumulative SSE CPU per invocation. Clients reconnect with their
  // existing cursor, so events and permission revocation are preserved.
  EVENT_STREAM_POLL_MS: 2000,
  EVENT_STREAM_LIFETIME_MS: 15000,
  PG_SITE: {
    connectionString:
      settings.GRAEBOARD_DATABASE_URL || settings.SUPABASE_DB_URL,
    pool,
  },
  R2_TEAM: resources.bucket,
  IMAGES: resources.images,
  ASSETS: {
    fetch: async () =>
      new Response(guideHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
  },
};
const execution = { waitUntil: (promise) => EdgeRuntime.waitUntil(promise) };
Deno.serve(createEdgeHandler({ env, execution }));
