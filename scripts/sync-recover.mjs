import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDatabase, transaction } from "../server/db.mjs";
import { createNodeSync } from "../server/sync/node.mjs";
import { allEntities } from "../server/sync/entities.mjs";
import { project } from "../server/sync/reducer.mjs";
import { makeOperation } from "../server/sync/operations.mjs";
import { canonical, protocolVersion } from "../server/sync/protocol.mjs";

export async function recoverSync({
  db,
  teamId,
  installationId,
  profiles,
  imagesDir,
  confirmDrained = false,
  dryRun = false,
  transports,
}) {
  const sync = createNodeSync({
    db,
    documentImagesDir: imagesDir,
    documentEvents: { invalidate() {}, notify() {} },
    cellEvents: { publish() {}, invalidateTeam() {} },
    options: { installationId, profiles, transports, schedule: false },
  });
  try {
    const store = sync.store(teamId),
      link = store.readLink();
    if (!link || !["recovery", "disconnected", "paused"].includes(link.mode))
      throw new Error("Pause or mark this connection for recovery first");
    if (!installationId)
      throw new Error("Set the new GRAEBOARD_INSTALLATION_ID before recovery");
    if (
      db
        .prepare(
          "SELECT 1 FROM site_maintenance_jobs WHERE team_id=? AND phase NOT IN ('complete','cancelled')",
        )
        .get(teamId)
    )
      throw new Error("Finish maintenance/backup before recovery");
    const canonicalState = store.readState(),
      pending = store.readPending();
    const before = project(canonicalState, pending).entities;
    const after = allEntities(db, link);
    for (const key of Object.keys(before)) if (!after[key]) after[key] = null;
    const actorRef = db
      .prepare(
        "SELECT user_id FROM memberships WHERE team_id=? ORDER BY user_id LIMIT 1",
      )
      .get(teamId)?.user_id;
    const op = makeOperation({
      link: {
        ...link,
        protocol: protocolVersion(canonicalState),
        writer_epoch: randomUUID(),
      },
      actorRef: actorRef || "recovery-operator",
      before,
      after,
      prior: Object.fromEntries(
        pending.flatMap((op) =>
          op.changes.map((c) => [JSON.stringify([c.entity, c.key]), op.opId]),
        ),
      ),
    });
    if (dryRun)
      return {
        teamId,
        mode: link.mode,
        canonicalHead: link.canonical_head,
        pending: pending.length,
        uncapturedChanges: op?.changes.length || 0,
      };
    if (!confirmDrained)
      throw new Error(
        "Stop the old and restored application writers, verify the backup, then pass --confirm-drained",
      );
    sync.capture.without(() =>
      transaction(db, () => {
        if (op) store.enqueue(op);
        if (link.installation_id !== installationId) {
          // The restored site keeps its local exclusions under its new identity.
          // Losing this mapping would rehydrate archived images on first receive.
          db.prepare(
            `INSERT INTO site_retention(team_id,site_id,kind,entity_key,generation,revision,created_at)
          SELECT team_id,?,kind,entity_key,generation,revision,created_at FROM site_retention WHERE team_id=? AND site_id=?
          ON CONFLICT(team_id,site_id,kind,entity_key,generation) DO UPDATE SET revision=MAX(revision,excluded.revision)`,
          ).run(installationId, teamId, link.installation_id);
          db.prepare(
            "DELETE FROM site_retention WHERE team_id=? AND site_id=?",
          ).run(teamId, link.installation_id);
        }
        store.writeLink({
          installation_id: installationId,
          writer_epoch: randomUUID(),
          mode: "importing",
          lease_owner: null,
          lease_until: null,
          remote_status: null,
          generation: link.generation + 1,
          last_error: null,
        });
      }),
    );
    sync.clear(teamId);
    try {
      // Keep original pending IDs/payloads, reconcile remote receipts, and never
      // publish data during recovery. Resuming is a separate explicit action.
      for (let attempt = 0; attempt < 100; attempt++) {
        await sync
          .get(teamId)
          .run({ receiveOnly: true, loadCheckpoint: attempt === 0 });
        if (
          store.readLink().canonical_head ===
          (await sync.get(teamId).transport.readHead())
        )
          break;
        if (attempt === 99)
          throw new Error("Recovery history limit reached; rerun recovery");
      }
      store.writeLink({
        mode: "paused",
        remote_status: null,
        lease_owner: null,
        lease_until: null,
        last_error: null,
      });
      await sync.get(teamId).run({ receiveOnly: true });
      return {
        teamId,
        mode: "paused",
        canonicalHead: store.readLink().canonical_head,
        pending: store.readPending().length,
      };
    } catch (error) {
      store.writeLink({
        mode: "recovery",
        remote_status: null,
        last_error: error.message,
      });
      throw error;
    }
  } finally {
    await sync.close();
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const { values } = parseArgs({
    options: {
      database: { type: "string" },
      "team-id": { type: "string" },
      "images-dir": { type: "string" },
      "dry-run": { type: "boolean" },
      "confirm-drained": { type: "boolean" },
    },
  });
  if (!values.database || !values["team-id"])
    throw new Error(
      "Usage: npm run sync:recover -- --database /absolute/file.sqlite --team-id UUID [--images-dir path] --dry-run | --confirm-drained",
    );
  const db = openDatabase(resolve(values.database));
  try {
    console.log(
      canonical(
        await recoverSync({
          db,
          teamId: values["team-id"],
          installationId: process.env.GRAEBOARD_INSTALLATION_ID,
          profiles: JSON.parse(process.env.GRAEBOARD_SYNC_PROFILES || "[]"),
          imagesDir: resolve(
            values["images-dir"] ||
              process.env.DOCUMENT_IMAGES_DIR ||
              "data/document-images",
          ),
          dryRun: values["dry-run"],
          confirmDrained: values["confirm-drained"],
        }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
