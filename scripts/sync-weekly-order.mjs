import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { openDatabase, transaction } from "../server/db.mjs";
import { sqliteTeamStore } from "../server/storage/sqlite.mjs";
import { readEntity } from "../server/sync/node/entities.mjs";
import { project } from "../server/sync/core/reducer.mjs";
import { makeOperation } from "../server/sync/core/operations.mjs";
import { canonical, protocolVersion } from "../server/sync/core/protocol.mjs";

// One-time step of the 2026-11-04 update. Weekly to-do items shared before
// `importedAt` joined their synchronized payload have none in shared state,
// while the internal site keeps the time in `calendar_weekly_items`. One
// ordinary operation adds this site's time to each of them, so both sites and
// the shared repository list a week in the same order and later changes
// start from the same value. Run it on the internal site after updating the
// code and before starting the server; a rerun finds nothing to add.
export function backfillWeeklyOrder({ db, teamId, dryRun = false }) {
  const store = sqliteTeamStore(db, teamId),
    link = store.readLink();
  if (!link) throw new Error(`No synchronization connection for ${teamId}`);
  const state = store.readState(),
    pending = store.readPending(),
    shared = project(state, pending).entities,
    before = {},
    after = {};
  for (const [id, record] of Object.entries(shared)) {
    if (
      record.entity !== "weekly" ||
      record.deleted ||
      record.payload?.importedAt !== undefined
    )
      continue;
    const importedAt = readEntity(db, teamId, "weekly", record.key)?.payload
      .importedAt;
    if (!importedAt) continue;
    before[id] = record;
    after[id] = { ...record, payload: { ...record.payload, importedAt } };
  }
  const op = makeOperation({
    link: { ...link, protocol: protocolVersion(state) },
    actorRef:
      db
        .prepare(
          "SELECT user_id FROM memberships WHERE team_id=? ORDER BY user_id LIMIT 1",
        )
        .get(teamId)?.user_id || "weekly-order",
    before,
    after,
    prior: Object.fromEntries(
      pending.flatMap((pendingOp) =>
        pendingOp.changes.map((c) => [
          JSON.stringify([c.entity, c.key]),
          pendingOp.opId,
        ]),
      ),
    ),
  });
  if (op && !dryRun) transaction(db, () => store.enqueue(op));
  return {
    teamId,
    items: op?.changes.length || 0,
    enqueued: !!op && !dryRun,
  };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const { values } = parseArgs({
    options: {
      database: { type: "string" },
      "team-id": { type: "string" },
      apply: { type: "boolean" },
    },
  });
  const path = values.database || process.env.DB_PATH;
  if (!path)
    throw new Error(
      "Usage: npm run sync:weekly-order -- --database /absolute/file.sqlite [--team-id UUID] [--apply]",
    );
  const db = openDatabase(resolve(path));
  try {
    const teams = values["team-id"]
      ? [values["team-id"]]
      : db
          .prepare("SELECT team_id FROM team_sync_links ORDER BY team_id")
          .all()
          .map((row) => row.team_id);
    for (const teamId of teams)
      console.log(
        canonical(backfillWeeklyOrder({ db, teamId, dryRun: !values.apply })),
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
