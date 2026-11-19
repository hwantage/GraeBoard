import {
  captureDetectors,
  defineCaptureTriggers,
} from "./capture-triggers.mjs";
import { sheetCloneSplitter } from "../core/versions.mjs";
import { createReceiptCapacityGuard } from "./receipt-capacity.mjs";
import { HttpError } from "../../../shared/validation.js";
import { LINK_METADATA_COLUMNS } from "../../../shared/sync/sync-team-store.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { readEntity, isCalendarDocument } from "./entities.mjs";
import { makeOperation, entityReferences } from "../core/operations.mjs";
import {
  entityId,
  initialToken,
  canonical,
  equal,
  validateOperation,
  PROTOCOL,
  SPLIT_PROTOCOL,
} from "../core/protocol.mjs";

// SQLite keeps the original formats without an order and reads them by rule
// ID. The reducer compares an edit's whole rules list with shared state, order
// included, and shared state may hold the same rules in another order (the
// external site appends a new rule). A base in ID order would be refused as a
// concurrent change, so the base takes the shared order. Rules shared state
// lacks follow in the order given (the ID order read); content still decides
// whether an edit conflicts.
function inSharedOrder(rules, shared) {
  if (!Array.isArray(rules) || !Array.isArray(shared)) return rules;
  const position = new Map(shared.map((rule, index) => [rule?.id, index])),
    known = [],
    added = [];
  for (const rule of rules) (position.has(rule.id) ? known : added).push(rule);
  known.sort((a, b) => position.get(a.id) - position.get(b.id));
  return [...known, ...added];
}

export function installCapture(db, { onPending = () => {} } = {}) {
  const requestActor = new AsyncLocalStorage();
  const receiptCapacity = createReceiptCapacityGuard(db);
  db.exec(
    "CREATE TEMP TABLE IF NOT EXISTS sync_capture_teams(team_id TEXT PRIMARY KEY)",
  );
  const syncTeams = () => {
    db.exec("DELETE FROM sync_capture_teams");
    const insert = db.prepare(
      "INSERT INTO sync_capture_teams(team_id) VALUES(?)",
    );
    for (const teamId of links.keys()) insert.run(teamId);
  };
  const triggerDefinitions = new Map();
  let triggersEnabled = false,
    failure = null;
  function reconcileTriggers() {
    const enabled = links.size > 0;
    if (enabled === triggersEnabled || !triggerDefinitions.size) return;
    for (const [name, sql] of triggerDefinitions)
      db.exec(enabled ? sql : `DROP TRIGGER IF EXISTS temp.${name}`);
    triggersEnabled = enabled;
  }
  let active = false,
    suppressed = 0,
    before = new Map(),
    actors = new Map(),
    links = new Map(),
    prior = new Map(),
    created = [],
    restores = new Map(),
    order = 0,
    checkedTeams = new Set(),
    people = null,
    styles = new Map(),
    beforeSheetClones = new Map(),
    afterSheetClones = new Map(),
    hintedCells = new Set(),
    afterImages = new Map(),
    documentPlaces = new Map();
  // Keep prepared reads local to capture. The shared entity reader still defines
  // payloads, while each keystroke avoids preparing the same SQLite programs.
  const statements = new Map(),
    reader = {
      prepare(sql) {
        if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
        return statements.get(sql);
      },
    };
  const prepare = (sql) => reader.prepare(sql);
  const rememberChange = (teamId, opId, index, change, position) => {
    const key = teamId + entityId(change.entity, change.key);
    const value = {
      opId,
      version: `${opId}:${index}`,
      generation: change.generation,
      order: position,
    };
    prior.set(key, value);
    if (
      change.action === "restore" &&
      ["task", "calendar"].includes(change.entity)
    )
      restores.set(key, { ...value, generation: value.version });
  };
  const rememberPending = (operation) => {
    const position = ++order;
    for (const [index, change] of operation.changes.entries())
      rememberChange(operation.teamId, operation.opId, index, change, position);
  };
  const parentRestore = (teamId, entity, key) => {
    if (entity === "cell")
      return restores.get(teamId + entityId("task", [key[0]]));
    if (entity === "document" && ["task", "calendar"].includes(key[0]))
      return restores.get(teamId + entityId(key[0], [key[1]]));
    return undefined;
  };
  const refresh = () => {
    receiptCapacity.clear();
    links = new Map(
      prepare(
        `SELECT ${LINK_METADATA_COLUMNS} FROM team_sync_links WHERE mode<>'disconnected'`,
      )
        .all()
        .map((l) => {
          const marker = prepare(
            "SELECT payload FROM sync_entities WHERE team_id=? AND entity='protocol' AND entity_key='[]'",
          ).get(l.team_id);
          return [
            l.team_id,
            {
              ...l,
              protocol: marker ? JSON.parse(marker.payload).version : PROTOCOL,
            },
          ];
        }),
    );
    prior = new Map();
    restores = new Map();
    order = 0;
    people = null;
    // JSON is decoded by SQLite; document bodies never cross into the refresh cache.
    let lastSequence;
    for (const row of prepare(`SELECT o.team_id,o.op_id,o.local_seq,j.key AS change_index,
      json_extract(j.value,'$.entity') AS entity,json_extract(j.value,'$.key') AS entity_key,
      json_extract(j.value,'$.generation') AS generation,json_extract(j.value,'$.action') AS action
      FROM sync_outbox o,json_each(o.payload,'$.changes') j
      WHERE o.status<>'acknowledged' ORDER BY o.local_seq,CAST(j.key AS INTEGER)`).all()) {
      if (lastSequence !== row.local_seq) {
        order++;
        lastSequence = row.local_seq;
      }
      rememberChange(
        row.team_id,
        row.op_id,
        row.change_index,
        {
          entity: row.entity,
          key: JSON.parse(row.entity_key),
          generation: row.generation,
          action: row.action,
        },
        order,
      );
    }
    syncTeams();
    reconcileTriggers();
  };
  refresh();
  // The rules the reducer will compare a formats edit's base with: those of
  // the newest pending formats edit, or else those of shared state. Only the
  // order is taken, so a missing outbox row falls back to shared state.
  const sharedFormatRules = (teamId, pending) => {
    let rules;
    if (pending) {
      const index = Number(pending.version.slice(pending.opId.length + 1));
      if (Number.isInteger(index))
        rules = prepare(
          "SELECT json_extract(payload,?) AS rules FROM sync_outbox WHERE op_id=? AND team_id=?",
        ).get(`$.changes[${index}].desired.rules`, pending.opId, teamId)?.rules;
    }
    rules ??= prepare(
      "SELECT json_extract(payload,'$.rules') AS rules FROM sync_entities WHERE team_id=? AND entity='formats' AND entity_key='[]' AND deleted=0",
    ).get(teamId)?.rules;
    return typeof rules === "string" ? JSON.parse(rules) : null;
  };
  // A copy's document keeps its title and order inside the copy, so the local
  // reader numbers it by its place in the copy's list. Shared state keeps the
  // title and position the writing site sent, which can differ: an external
  // copy has held position 2 for the first document of a row. The reducer
  // compares a delete's whole base, so take these two fields as the reducer
  // has them: from the newest pending change, or else from shared state.
  const sharedDocumentPlace = (teamId, key, pending) => {
    let place;
    if (pending) {
      const index = Number(pending.version.slice(pending.opId.length + 1));
      if (Number.isInteger(index))
        place = prepare(
          "SELECT json_extract(payload,?) AS title,json_extract(payload,?) AS position FROM sync_outbox WHERE op_id=? AND team_id=?",
        ).get(
          `$.changes[${index}].desired.title`,
          `$.changes[${index}].desired.position`,
          pending.opId,
          teamId,
        );
    }
    if (typeof place?.position !== "number")
      place = prepare(
        "SELECT json_extract(payload,'$.title') AS title,json_extract(payload,'$.position') AS position FROM sync_entities WHERE team_id=? AND entity='document' AND entity_key=? AND deleted=0",
      ).get(teamId, canonical(key));
    return typeof place?.position === "number" &&
      typeof place.title === "string"
      ? { title: place.title, position: place.position }
      : null;
  };
  // A weekly item removed from a person's week has no row here, while shared
  // state keeps it as a deleted record under the same key (person, week,
  // task). Adding it again restores that record: sent as a new one it would be
  // refused as one that already exists. The newest pending change of the item
  // decides before shared state does.
  const removedRecord = (teamId, entity, key, pending) => {
    let payload;
    if (pending) {
      const index = Number(pending.version.slice(pending.opId.length + 1));
      const row = Number.isInteger(index)
        ? prepare(
            "SELECT json_extract(payload,?) AS change FROM sync_outbox WHERE op_id=? AND team_id=?",
          ).get(`$.changes[${index}]`, pending.opId, teamId)
        : null;
      const change = row?.change ? JSON.parse(row.change) : null;
      if (change?.action !== "delete") return null;
      payload = change.base;
    } else {
      const stored = prepare(
        "SELECT payload FROM sync_entities WHERE team_id=? AND entity=? AND entity_key=? AND deleted=1",
      ).get(teamId, entity, canonical(key));
      if (!stored) return null;
      payload = JSON.parse(stored.payload);
    }
    return { entity, key, payload, deleted: true };
  };
  const record = (teamId, entity, key, beforeImage = undefined) => {
    if (!active || suppressed || !links.has(teamId)) return;
    const mapKey = teamId + entityId(entity, key);
    if (before.has(mapKey)) return;
    if (!checkedTeams.has(teamId)) {
      const boundary = prepare(`SELECT
        EXISTS(SELECT 1 FROM site_maintenance_jobs WHERE team_id=? AND kind<>'backup' AND phase NOT IN ('complete','cancelled')) AS maintenance,
        EXISTS(SELECT 1 FROM team_sync_links WHERE team_id=? AND lease_owner LIKE 'upgrade:%' AND lease_until>?) AS upgrading`).get(
        teamId,
        teamId,
        Date.now(),
      );
      if (boundary.maintenance || boundary.upgrading)
        throw (failure = new HttpError(
          409,
          boundary.upgrading
            ? "동기화 형식 전환 중입니다. 입력을 보존하고 잠시 후 저장하세요."
            : "팀 데이터 정리가 진행 중입니다. 입력을 보존하고 잠시 후 저장하세요.",
        ));
      checkedTeams.add(teamId);
    }
    let value =
        beforeImage !== undefined
          ? beforeImage
          : readEntity(reader, teamId, entity, key, {
              styles,
              sheetClones: beforeSheetClones,
            }),
      body = null;
    // SQLite reads every calendar entry's document, saved or not. Shared state
    // decides whether it exists: P or C has it, or, before the first shared
    // head, genesis will (it holds the documents with a saved body). A
    // document it does not have is created by the first body save.
    if (value && isCalendarDocument(entity, key) && !prior.has(mapKey)) {
      const local = prepare(
        "SELECT e.version_id,l.canonical_head,EXISTS(SELECT 1 FROM sync_entities s WHERE s.team_id=e.team_id AND s.entity='document' AND s.entity_key=?) AS shared FROM calendar_entries e JOIN team_sync_links l ON l.team_id=e.team_id WHERE e.team_id=? AND e.id=?",
      ).get(canonical(key), teamId, key[1]);
      if (
        !local.shared &&
        (local.canonical_head !== null || local.version_id === null)
      ) {
        body = local.version_id;
        value = null;
      }
    }
    if (!value && entity === "weekly")
      value = removedRecord(teamId, entity, key, prior.get(mapKey));
    if (value) {
      let pending = prior.get(mapKey);
      const restored = parentRestore(teamId, entity, key);
      if (restored && (!pending || restored.order > pending.order))
        pending = restored;
      const row =
        pending ||
        prepare(
          "SELECT generation,version FROM sync_entities WHERE team_id=? AND entity=? AND entity_key=?",
        ).get(teamId, entity, canonical(key));
      const token = row
        ? null
        : initialToken(links.get(teamId).bootstrap_id, entity, key);
      value.generation = row?.generation || token;
      value.version = row?.version || token;
      if (entity === "formats" && row)
        value.payload = {
          ...value.payload,
          rules: inSharedOrder(
            value.payload.rules,
            sharedFormatRules(teamId, pending),
          ),
        };
      if (entity === "document" && key[0] === "sheetClone" && row) {
        const shared = sharedDocumentPlace(teamId, key, pending);
        if (
          shared &&
          (shared.title !== value.payload.title ||
            shared.position !== value.payload.position)
        ) {
          documentPlaces.set(mapKey, {
            local: {
              title: value.payload.title,
              position: value.payload.position,
            },
            shared,
          });
          value.payload = { ...value.payload, ...shared };
        }
      }
    }
    before.set(mapKey, { teamId, entity, key, value, body });
  };
  // Whether this transaction saved the body of a calendar document that shared
  // state does not have: its version differs from the one read before.
  const calendarBodySaved = (item) => {
    const version =
      prepare(
        "SELECT version_id FROM calendar_entries WHERE team_id=? AND id=?",
      ).get(item.teamId, item.key[1])?.version_id ?? null;
    return version !== null && version !== item.body;
  };
  db.function("graeboard_sync_before", (table, data) => {
    if (!active || suppressed || !links.size) return 0;
    const row = JSON.parse(data);
    if (
      table === "cells" &&
      hintedCells.has(entityId("cell", [row.task_id, row.key]))
    )
      return 0;
    if (table === "audit") {
      if (row.team_id) actors.set(row.team_id, row.actor_id);
      return 0;
    }
    const target = captureDetectors[table]?.(row);
    if (!target) return 0;
    const [entity, key, direct, owner, ownerId] = target,
      teamId =
        direct ||
        prepare(`SELECT team_id FROM ${owner} WHERE id=?`).get(ownerId)
          ?.team_id;
    if (teamId) {
      record(teamId, entity, key);
      // SheetClone edits replace the parent JSON before rebuilding document rows.
      // Capture child titles/order/body while their original parent still exists;
      // a later document DELETE trigger can no longer read that before-image.
      if (table === "sheet_clones")
        for (const child of prepare(
          "SELECT task_id,document_id FROM sheet_clone_documents WHERE sheet_clone_id=?",
        ).all(row.id))
          record(teamId, "document", [
            "sheetClone",
            row.id,
            child.task_id,
            child.document_id,
          ]);
      if (table === "calendar_entries")
        record(teamId, "document", ["calendar", row.id, "main"]);
    }
    return 0;
  });
  // User accounts stay local. Invalidate only the display-reference lookup, even
  // when a control transaction or a received person changes the users table.
  db.function("graeboard_sync_people_changed", () => {
    people = null;
    return 0;
  });
  for (const event of ["INSERT", "UPDATE", "DELETE"])
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS sync_people_${event} AFTER ${event} ON main.users BEGIN SELECT graeboard_sync_people_changed(); END`,
    );
  defineCaptureTriggers(db, triggerDefinitions);
  reconcileTriggers();
  const capture = {
    get failure() {
      return failure;
    },
    withActor(actorId, work) {
      return requestActor.run(actorId, work);
    },
    begin() {
      failure = null;
      active = links.size > 0;
      if (!active) return;
      before = new Map();
      styles = new Map();
      beforeSheetClones = new Map();
      afterSheetClones = new Map();
      hintedCells = new Set();
      afterImages = new Map();
      documentPlaces = new Map();
      actors = new Map();
      created = [];
      checkedTeams = new Set();
    },
    cellSaving(teamId, taskId, cellKey, cell) {
      if (!active || suppressed || !links.has(teamId)) return;
      const key = [taskId, cellKey];
      // saveBatch already read this immutable before-image under the same
      // writer transaction. Other SQL paths continue through the TEMP trigger.
      record(
        teamId,
        "cell",
        key,
        cell
          ? {
              entity: "cell",
              key,
              payload: { value: cell.value, style: cell.style },
              deleted: false,
            }
          : null,
      );
      hintedCells.add(entityId("cell", key));
    },
    cellsSaved(teamId, cells) {
      if (!active || suppressed || !links.has(teamId)) return;
      for (const cell of cells) {
        const key = [cell.taskId, cell.key];
        afterImages.set(teamId + entityId("cell", key), {
          entity: "cell",
          key,
          payload: { value: cell.value, style: cell.style },
          deleted: false,
        });
      }
    },
    flush() {
      if (suppressed || !before.size) return;
      const teams = new Map();
      for (const item of before.values()) {
        if (!teams.has(item.teamId))
          teams.set(item.teamId, { before: {}, after: {} });
        const group = teams.get(item.teamId),
          key = entityId(item.entity, item.key);
        group.before[key] = item.value;
        let after =
          afterImages.get(item.teamId + key) ??
          readEntity(reader, item.teamId, item.entity, item.key, {
            styles,
            sheetClones: afterSheetClones,
          });
        // A calendar document is created only by saving its body, and only its
        // body changes: renaming the entry leaves the document's title alone,
        // as on the external site.
        if (after && isCalendarDocument(item.entity, item.key)) {
          if (item.value)
            after = {
              ...after,
              payload: {
                ...after.payload,
                title: item.value.payload.title,
                position: item.value.payload.position,
              },
            };
          else if (!calendarBodySaved(item)) after = null;
        }
        // A copy document whose title or place in the list did not change
        // keeps the shared value its base carries (see sharedDocumentPlace);
        // a renamed or moved one sends its new local value.
        const place = documentPlaces.get(item.teamId + key);
        if (after && place)
          after = {
            ...after,
            payload: {
              ...after.payload,
              title:
                after.payload.title === place.local.title
                  ? place.shared.title
                  : after.payload.title,
              position:
                after.payload.position === place.local.position
                  ? place.shared.position
                  : after.payload.position,
            },
          };
        // Formats written with the same rules change nothing: the ID order
        // read back is not an edit of the shared order kept in the base.
        if (
          after &&
          item.value &&
          item.entity === "formats" &&
          equal(
            {
              ...after.payload,
              rules: inSharedOrder(
                after.payload.rules,
                item.value.payload.rules,
              ),
            },
            item.value.payload,
          )
        )
          after = { ...after, payload: item.value.payload };
        group.after[key] = after;
      }
      for (const [teamId, group] of teams) {
        const link = links.get(teamId);
        let referenceRecords = Object.values(group.after);
        const split = sheetCloneSplitter(link.protocol);
        if (split) {
          referenceRecords = [];
          const beforeExpanded = {},
            afterExpanded = {};
          for (const key of new Set([
            ...Object.keys(group.before),
            ...Object.keys(group.after),
          ])) {
            const previous = group.before[key],
              next = group.after[key];
            if ((previous || next)?.entity !== "sheetClone") {
              beforeExpanded[key] = previous;
              afterExpanded[key] = next;
              referenceRecords.push(next);
              continue;
            }
            const old = new Map(
                split(previous).map((record) => [
                  entityId(record.entity, record.key),
                  record,
                ]),
              ),
              current = new Map(
                split(next).map((record) => [
                  entityId(record.entity, record.key),
                  record,
                ]),
              );
            // Only changed copy rows need canonical metadata and dependencies.
            // Keep display references from the complete after-image as before.
            // Structural equality is a conservative fast
            // filter; makeOperation still owns the final canonical comparison.
            const candidates = [...new Set([...old.keys(), ...current.keys()])];
            referenceRecords.push(...candidates.map((id) => current.get(id)));
            const changed = candidates.filter((id) => {
              const before = old.get(id),
                after = current.get(id);
              // Format and rule records stay while their copy lives, as on
              // the external site: the other site may be naming them.
              if (
                ["sheetCloneFormat", "sheetCloneRule"].includes(
                  before?.entity,
                ) &&
                !after &&
                next &&
                !next.deleted
              )
                return false;
              return (
                !before ||
                !after ||
                before.deleted !== after.deleted ||
                !isDeepStrictEqual(before.payload, after.payload)
              );
            });
            const storedRows = new Map(
              prepare(
                "SELECT s.entity,s.entity_key,s.generation,s.version,s.deleted,s.payload FROM json_each(?) AS wanted CROSS JOIN sync_entities s ON s.team_id=? AND s.entity=json_extract(wanted.value,'$[0]') AND s.entity_key=json_extract(wanted.value,'$[1]')",
              )
                .all(
                  JSON.stringify(
                    changed.map((id) => {
                      const record = old.get(id) || current.get(id);
                      return [record.entity, canonical(record.key)];
                    }),
                  ),
                  teamId,
                )
                .map((row) => [
                  entityId(row.entity, JSON.parse(row.entity_key)),
                  row,
                ]),
            );
            for (const id of changed) {
              const sample = old.get(id) || current.get(id),
                pending = prior.get(teamId + id),
                stored = storedRows.get(id);
              // A format or rule the copy stopped using stays in C (see
              // above). Using it again, as an undo does, changes nothing: its
              // ID is its content's hash. Sending it as a new record would be
              // refused as one that already exists.
              if (
                !old.get(id) &&
                stored &&
                !stored.deleted &&
                ["sheetCloneFormat", "sheetCloneRule"].includes(sample.entity)
              )
                continue;
              let base =
                old.get(id) ||
                (stored?.deleted
                  ? {
                      ...sample,
                      payload: JSON.parse(stored.payload),
                      deleted: true,
                    }
                  : null);
              if (!base && pending) {
                const row = prepare(
                    "SELECT payload FROM sync_outbox WHERE op_id=? AND team_id=?",
                  ).get(pending.opId, teamId),
                  change =
                    row &&
                    JSON.parse(row.payload).changes.find(
                      (change) => entityId(change.entity, change.key) === id,
                    );
                if (change?.action === "delete")
                  base = {
                    ...sample,
                    payload: change.desired || change.base,
                    deleted: true,
                  };
              }
              if (base)
                base = {
                  ...base,
                  generation:
                    pending?.generation ||
                    stored?.generation ||
                    initialToken(link.bootstrap_id, sample.entity, sample.key),
                  version:
                    pending?.version ||
                    stored?.version ||
                    initialToken(link.bootstrap_id, sample.entity, sample.key),
                };
              beforeExpanded[id] = base;
              afterExpanded[id] = current.get(id) || null;
            }
          }
          group.before = beforeExpanded;
          group.after = afterExpanded;
        }
        const actorRef =
          requestActor.getStore() ||
          actors.get(teamId) ||
          `system:${link.installation_id}`;
        // Referenced people are display-only and are captured in the same command
        // before content can reference a newly registered local person.
        people ||= new Map(
          prepare("SELECT id,name FROM users")
            .all()
            .map((person) => [person.id, person]),
        );
        const references = new Set([actorRef]);
        const collect = (value) => {
          if (typeof value === "string") {
            references.add(value);
            for (const match of value.matchAll(
              /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/gi,
            ))
              references.add(match[0]);
          } else if (Array.isArray(value)) value.forEach(collect);
          else if (value && typeof value === "object")
            Object.values(value).forEach(collect);
        };
        for (const record of referenceRecords) {
          if (!record) continue;
          for (const [entity, key] of entityReferences(
            record.entity,
            record.key,
            record.payload,
          ))
            if (entity === "person") references.add(key[0]);
          // Member cells and snapshot/filter data can contain historical display IDs.
          // Markdown and style payloads cannot contain person references.
          if (record.entity === "cell") collect(record.payload.value);
          if (record.entity === "sheetCloneCell")
            collect(record.payload.data.value);
          if (record.entity === "sheetCloneTask") {
            collect(record.payload.data);
            // Protocol 5 rows hold their cells.
            for (const cell of Object.values(record.payload.cells || {}))
              collect(cell.value);
          }
          if (["sheetClone", "filter"].includes(record.entity))
            collect(record.payload.data);
          if (record.entity === "rule") collect(record.payload.values);
        }
        for (const id of references) {
          const person = people.get(id);
          if (person) {
            const key = entityId("person", [person.id]);
            if (
              !prior.has(teamId + key) &&
              !prepare(
                "SELECT 1 FROM sync_entities WHERE team_id=? AND entity='person' AND entity_key=?",
              ).get(teamId, canonical([person.id]))
            ) {
              group.before[key] = null;
              group.after[key] = {
                entity: "person",
                key: [person.id],
                payload: { name: person.name },
                deleted: false,
              };
            }
          }
        }
        const operation = makeOperation({
          link,
          actorRef,
          ...group,
          getPrior: (key) => prior.get(teamId + key)?.opId,
        });
        if (operation) {
          let serialized;
          try {
            validateOperation(
              operation,
              { teamId, repoId: link.repo_id },
              undefined,
              {
                onSerialized(value) {
                  serialized = value;
                },
              },
            );
          } catch (error) {
            throw new HttpError(
              400,
              "동기화할 자료 형식을 확인하세요. " + error.message,
            );
          }
          receiptCapacity.check(link, operation);
          // Hashing and Git preparation happen in the background. The immutable
          // JSON and ID are already durable with the business transaction.
          prepare(
            "INSERT INTO sync_outbox(op_id,team_id,payload,status,created_at) VALUES(?,?,?,'pending',?)",
          ).run(operation.opId, teamId, serialized, operation.createdAt);
          created.push(operation);
        }
      }
    },
    committed() {
      active = false;
      for (const op of created) {
        rememberPending(op);
        // The local transaction has committed; a scheduling failure must not
        // turn a durable save into a misleading HTTP failure. P remains durable.
        try {
          onPending(op.teamId);
        } catch (error) {
          console.error("Sync scheduling failed:", error.message);
        }
      }
      before.clear();
      created = [];
    },
    // The caller has already committed its explicit operation. Update only the
    // dependency cache; transaction rollback and scheduling remain its owner's.
    enqueued(operation) {
      rememberPending(operation);
    },
    rollback() {
      active = false;
      before.clear();
      created = [];
      people = null;
    },
    refresh,
    acknowledged(teamId, opIds) {
      const link = prepare(
        `SELECT ${LINK_METADATA_COLUMNS} FROM team_sync_links WHERE team_id=?`,
      ).get(teamId);
      if (link && link.mode !== "disconnected") {
        const marker = prepare(
          "SELECT payload FROM sync_entities WHERE team_id=? AND entity='protocol' AND entity_key='[]'",
        ).get(teamId);
        links.set(teamId, {
          ...link,
          protocol: marker ? JSON.parse(marker.payload).version : PROTOCOL,
        });
      } else links.delete(teamId);
      syncTeams();
      const ids = new Set(opIds);
      for (const map of [prior, restores])
        for (const [key, value] of map)
          if (key.startsWith(teamId) && ids.has(value.opId)) map.delete(key);
    },
    without(work) {
      suppressed++;
      try {
        return work();
      } finally {
        suppressed--;
      }
    },
  };
  db.syncCapture = capture;
  return capture;
}
