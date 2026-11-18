import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { openDatabase, transaction } from "../../server/db.mjs";
import { sqliteTeamStore } from "../../server/storage/sqlite.mjs";
import { project } from "../../server/sync/core/reducer.mjs";
import { makeOperation } from "../../server/sync/core/operations.mjs";
import {
  canonical,
  protocolVersion,
  SPLIT_PROTOCOL,
} from "../../server/sync/core/protocol.mjs";
import {
  decodeSheetClone,
  encodeSheetClone,
} from "../../server/sheet-clones/sheet-clones.mjs";

// One-time step of the 2026-11-18 update (PR #201). Until then the external
// site copied a row's documents in ID order and kept each source document's
// position, so a copy's list and its documents' positions could disagree:
// the internal site showed the list order and the external site the position
// order, and the internal site's deletes carried a base the reducer refused.
// This takes the shared tab order (position, then document ID, as the
// external site shows a row) as the order. For each copy it sends one
// ordinary operation that lists the row's documents in that order and
// numbers them 0, 1, …, and rearranges the internal copy the same way in the
// same transaction. Titles and bodies stay as they are; a rerun finds nothing.
//
// Run it on the internal site with the server stopped, as
// sync:weekly-order: the server reads the queued operation when it starts, so
// later edits of these documents start from it, and no running server writes
// the copies meanwhile.
//
// It runs only under protocol 4 and later, where each copy row is its own
// record. Under protocol 3 the list lives in the whole copy's record, so
// reordering one row would send the whole copy.

const tabOrder = (a, b) => a.position - b.position || a.id.localeCompare(b.id);
const rowKey = (sheetCloneId, taskId) => JSON.stringify([sheetCloneId, taskId]);

export function normalizeSheetCloneDocumentOrder({
  db,
  teamId,
  dryRun = false,
}) {
  const store = sqliteTeamStore(db, teamId),
    link = store.readLink();
  if (!link) throw new Error(`No synchronization connection for ${teamId}`);
  const state = store.readState(),
    protocol = protocolVersion(state);
  if (protocol < SPLIT_PROTOCOL)
    throw new Error(
      `Team ${teamId} uses protocol ${protocol}; run this after protocol 4`,
    );
  const pending = store.readPending(),
    shared = project(state, pending).entities;
  // Each copy row's live documents and its list, as shared state has them.
  const documents = new Map(),
    rows = new Map();
  for (const [id, record] of Object.entries(shared)) {
    if (record.deleted) continue;
    if (record.entity === "document" && record.key[0] === "sheetClone") {
      const [, sheetCloneId, taskId, documentId] = record.key,
        row = rowKey(sheetCloneId, taskId);
      if (!documents.has(row)) documents.set(row, []);
      documents.get(row).push({
        id: documentId,
        position: record.payload?.position,
        entityId: id,
        record,
      });
    } else if (record.entity === "sheetCloneTask")
      rows.set(rowKey(record.key[0], record.key[1]), { entityId: id, record });
  }
  // The internal copies, read once each.
  const local = new Map(),
    localCopy = (sheetCloneId) => {
      if (!local.has(sheetCloneId)) {
        const row = db
          .prepare("SELECT data FROM sheet_clones WHERE id=? AND team_id=?")
          .get(sheetCloneId, teamId);
        local.set(
          sheetCloneId,
          row ? { data: decodeSheetClone(row.data), changed: false } : null,
        );
      }
      return local.get(sheetCloneId);
    };
  const copies = new Map(),
    skipped = [];
  let rowCount = 0,
    documentCount = 0,
    listCount = 0;
  for (const [row, placed] of documents) {
    const [sheetCloneId, taskId] = JSON.parse(row),
      holder = rows.get(row),
      list = holder?.record.payload?.data?.documents;
    const skip = (reason) => skipped.push({ sheetCloneId, taskId, reason });
    if (!Array.isArray(list)) {
      skip("no row record");
      continue;
    }
    if (!placed.every((doc) => Number.isFinite(doc.position))) {
      skip("position is not a number");
      continue;
    }
    const listed = list.map((doc) => doc?.id),
      order = [...placed].sort(tabOrder),
      renumbered = order.filter((doc, index) => doc.position !== index),
      // Compared over the documents both hold: a row that never had a
      // document lists none while its empty main document is stored.
      inList = order.map((doc) => doc.id).filter((id) => listed.includes(id)),
      moved =
        inList.join() !==
        listed.filter((id) => placed.some((doc) => doc.id === id)).join();
    if (!moved && !renumbered.length) continue;
    if (
      listed.length !== placed.length ||
      !placed.every((doc) => listed.includes(doc.id))
    ) {
      skip("list and documents differ");
      continue;
    }
    const copy = localCopy(sheetCloneId),
      localTask = copy?.data.tasks.find((task) => task.id === taskId),
      localIds = (localTask?.documents || []).map((doc) => doc.id);
    if (!localTask || localIds.join() !== listed.join()) {
      skip("internal copy differs from shared state");
      continue;
    }
    if (!copies.has(sheetCloneId))
      copies.set(sheetCloneId, { before: {}, after: {} });
    const change = copies.get(sheetCloneId);
    for (const doc of renumbered) {
      change.before[doc.entityId] = doc.record;
      change.after[doc.entityId] = {
        ...doc.record,
        payload: { ...doc.record.payload, position: order.indexOf(doc) },
      };
    }
    if (moved) {
      const byId = new Map(list.map((doc) => [doc.id, doc]));
      change.before[holder.entityId] = holder.record;
      change.after[holder.entityId] = {
        ...holder.record,
        payload: {
          ...holder.record.payload,
          data: {
            ...holder.record.payload.data,
            documents: order.map((doc) => byId.get(doc.id)),
          },
        },
      };
      const localById = new Map(
        localTask.documents.map((doc) => [doc.id, doc]),
      );
      localTask.documents = order.map((doc) => localById.get(doc.id));
      copy.changed = true;
      listCount++;
    }
    rowCount++;
    documentCount += renumbered.length;
  }
  const prior = Object.fromEntries(
      pending.flatMap((operation) =>
        operation.changes.map((c) => [
          JSON.stringify([c.entity, c.key]),
          operation.opId,
        ]),
      ),
    ),
    actorRef =
      db
        .prepare(
          "SELECT user_id FROM memberships WHERE team_id=? ORDER BY user_id LIMIT 1",
        )
        .get(teamId)?.user_id || "sheet-clone-document-order",
    operations = [...copies.values()]
      .map(({ before, after }) =>
        makeOperation({
          link: { ...link, protocol },
          actorRef,
          before,
          after,
          prior,
        }),
      )
      .filter(Boolean);
  if (operations.length && !dryRun) {
    const write = () =>
      transaction(db, () => {
        for (const [sheetCloneId, copy] of local)
          if (copy?.changed)
            db.prepare("UPDATE sheet_clones SET data=? WHERE id=?").run(
              encodeSheetClone(copy.data),
              sheetCloneId,
            );
        for (const operation of operations) store.enqueue(operation);
      });
    // The internal copy already matches what these operations send; it is
    // not a change of its own to capture.
    if (db.syncCapture) db.syncCapture.without(write);
    else write();
  }
  return {
    teamId,
    sheetClones: copies.size,
    rows: rowCount,
    documents: documentCount,
    lists: listCount,
    skipped,
    enqueued: operations.length > 0 && !dryRun,
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
      "Usage: npm run sync:sheet-clone-document-order -- --database /absolute/file.sqlite [--team-id UUID] [--apply]",
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
        canonical(
          normalizeSheetCloneDocumentOrder({
            db,
            teamId,
            dryRun: !values.apply,
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
