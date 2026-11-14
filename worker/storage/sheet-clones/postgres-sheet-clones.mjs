import { prepareSheetCloneEdits } from "../../../server/storage/sheet-clones/sheet-clone-command-rules.mjs";
import { subscribePostgresEvents } from "../events/postgres-events.mjs";
import { z } from "zod";
import {
  DEFAULT_DOCUMENT_ID,
  DEFAULT_DOCUMENT_TITLE,
} from "../../../shared/documents/task-documents.js";
import { applySheetCloneOperation } from "../../../shared/sheet-clones/sheet-clone-editing.js";
import {
  propertiesFor,
  normalizeView,
  savedFilter,
  canManageTeam,
  filteredTasks,
  defaultView,
  groupValue,
  displayValue,
} from "../../../shared/domain.js";
import {
  sheetCloneNameSchema,
  dateSchema,
  yearSchema,
  viewSchema,
  validateCellValue,
  savedFilterSchema,
} from "../../../shared/validation.js";
import { digestShared, equal } from "../../../server/sync/core/protocol.mjs";
import { requireFreeSheetCloneName } from "../../../shared/sheet-clones/sheet-clone-names.js";
import { assert } from "../../control/access.mjs";
import {
  settingsFor,
  taskList,
  taskView,
  stamp,
} from "../../sheet/task-view.mjs";
import { documentListsUnder } from "../documents/postgres-documents.mjs";
import { controlTransaction } from "../data.mjs";
import { userRecord } from "../../control/control.mjs";
export const sheetCloneRevision = (data) =>
  digestShared({
    ...data,
    tasks: data.tasks.map(
      ({ documents, hasDocument, documentCount, ...task }) => task,
    ),
  });
// The revision an editor sends back. A copy stored as row records answers it
// from the rows' site revisions, without reading the rows (see copyRevision).
export const copyRevision = async (s, row) =>
  (await s.rowRecords())
    ? s.copyRevision(row.key)
    : sheetCloneRevision(row.payload.data);
// What the sheetClone list shows, without the data: PostgreSQL drops it, so the
// list does not transfer and unpack every sheetClone's sheet. A payload that
// jsonb cannot read (\u0000 or a lone surrogate escape) comes whole instead.
// The team's copies without their sheets: names and metadata only. A copy
// stored as row records also drops its format assignment.
export async function sheetCloneSummaries(s) {
  return (
    await s.tx.query(
      "SELECT entity_key,CASE WHEN payload ~ $2 THEN payload ELSE (payload::jsonb - 'data' - 'formats')::text END AS payload FROM site_entities WHERE team_id=$1 AND entity='sheetClone' AND deleted=0 ORDER BY entity_key",
      [s.teamId, "\\\\u(0000|[dD][89a-fA-F])"],
    )
  ).rows.map((row) => ({
    key: JSON.parse(row.entity_key),
    payload: JSON.parse(row.payload),
  }));
}
export async function sheetCloneView(s, row) {
  const p = row.payload,
    data = p.data;
  const lists = await documentListsUnder(
    s,
    ["sheetClone", row.key[0]],
    "sheetClone",
  );
  const tasks = [];
  for (const task of data.tasks) {
    const documents = await lists.list(task.id);
    tasks.push({
      ...task,
      documentCount: documents.length,
      hasDocument: documents.some((d) => d.hasContent),
    });
  }
  return {
    id: row.key[0],
    name: p.name,
    year: p.year,
    referenceDate: p.referenceDate,
    createdAt: p.createdAt,
    ...data,
    tasks,
    revision: await copyRevision(s, row),
  };
}
// The rows an edit names. `wide` when it reaches every row of the copy;
// `ordered` when placing a row needs the position of the copy's other rows.
function editedRows(operations) {
  const ids = new Set(),
    add = (id) => id && ids.add(id);
  let wide = false,
    ordered = false;
  for (const operation of operations) {
    if (operation.kind === "cells")
      for (const change of operation.changes) add(change.taskId);
    else if (operation.kind === "format")
      for (const scope of operation.scopes)
        if (scope.rows) scope.rows.forEach(add);
        else wide = true;
    else if (operation.kind === "delete") operation.taskIds.forEach(add);
    else if (operation.kind === "restore") {
      for (const task of operation.tasks) add(task.id);
      (operation.removeIds || []).forEach(add);
    } else if (operation.kind === "create") {
      ordered = true;
      [
        operation.taskId,
        operation.sourceId,
        operation.insertAt?.taskId,
      ].forEach(add);
    } else if (operation.kind === "reorder") {
      ordered = true;
      operation.taskIds.forEach(add);
      add(operation.targetId);
    } else wide = true;
  }
  return { ids, wide, ordered };
}
// One edit request. A copy stored as row records reads the rows the request
// names, not the copy: the other rows stand in by ID and position where a row
// is placed among them. `all` reads every row: a copy stored whole, a format
// over every row, or an edit that turned out to change a row it did not name.
async function edit(ctx, s, teamId, sheetCloneId, body, changesOnly, all) {
  const key = [sheetCloneId],
    named = editedRows(body.operations),
    rowRecords = await s.rowRecords();
  all ||= !rowRecords || named.wide;
  const row = all
    ? await s.get("sheetClone", key)
    : await s.getCopyRows(key, named.ids);
  // Not stored as row records after all: read it whole.
  if (!row && !all)
    return edit(ctx, s, teamId, sheetCloneId, body, changesOnly, true);
  assert(row && !row.deleted, 404, "사본을 찾을 수 없습니다.");
  assert(
    body.revision === (await copyRevision(s, row)),
    409,
    "다른 사용자가 사본을 수정했습니다. 입력은 유지됩니다.",
  );
  const data = structuredClone(row.payload.data),
    lists = await documentListsUnder(
      s,
      ["sheetClone", sheetCloneId],
      "sheetClone",
      all ? {} : { owners: data.tasks.map((task) => task.id) },
    );
  for (const task of data.tasks)
    task.documents = await lists.list(task.id, { content: true });
  // The rows not read: enough of each to place a row among them.
  const standIns = new Map();
  if (!all && named.ordered) {
    const read = new Set(data.tasks.map((task) => task.id));
    for (const { id, position, createdAt } of await s.copyRowIndex(key, {
      positions: true,
    }))
      if (!read.has(id)) standIns.set(id, { id, position, createdAt });
  }
  const before = new Map(
    [...data.tasks, ...standIns.values()].map((task) => [task.id, task]),
  );
  const available = (await ctx.controlStore.members(teamId)).filter((row) =>
    ["lead", "member"].includes(row.role),
  );
  const prepared = prepareSheetCloneEdits({
    sheetClone: { ...data, tasks: [...before.values()] },
    operations: body.operations,
    teamId,
    year: body.view?.year ?? row.payload.year,
    actorId: ctx.user.id,
    available,
  });
  const remaining = new Map(prepared.tasks.map((task) => [task.id, task])),
    remainingIds = new Set(remaining.keys());
  // Nothing was written yet, so reading every row and applying again is safe.
  if ([...standIns].some(([id, standIn]) => remaining.get(id) !== standIn))
    return edit(ctx, s, teamId, sheetCloneId, body, changesOnly, true);
  const tasks = prepared.tasks.filter((task) => !standIns.has(task.id)),
    changed = new Set(
      tasks.filter((task) => before.get(task.id) !== task).map((t) => t.id),
    ),
    removed = [...before.keys()].filter((id) => !remainingIds.has(id));
  data.users = [...prepared.people.values()];
  // Nothing was written since: the rows read above are still current.
  for (const doc of lists.rows)
    if (!remainingIds.has(doc.key[2]))
      await s.put("document", doc.key, doc.payload, { deleted: true });
  // A row that never had a document lists the empty main document
  // (see listView). It is shown, not stored: saving it would write a
  // document and rewrite the row for every row of the copy on the
  // copy's first edit.
  const shownOnly = (doc) =>
    doc.id === DEFAULT_DOCUMENT_ID &&
    doc.revision === 0 &&
    doc.hasContent === false &&
    doc.markdown === "" &&
    doc.title === DEFAULT_DOCUMENT_TITLE;
  for (const task of tasks)
    task.documents = (task.documents || []).filter((doc) => !shownOnly(doc));
  for (const task of tasks)
    for (const doc of task.documents || [])
      if (typeof doc.markdown === "string")
        await s.put("document", ["sheetClone", row.key[0], task.id, doc.id], {
          title: doc.title,
          position: (task.documents || []).indexOf(doc),
          markdown: doc.markdown,
        });
  data.tasks = tasks.map((t) => ({
    ...t,
    documents: (t.documents || []).map((d) => ({
      id: d.id,
      title: d.title,
    })),
  }));
  if (body.view) data.view = viewSchema.parse(body.view);
  const payload = {
      ...row.payload,
      year: body.view?.year ?? row.payload.year,
      data,
    },
    saved = all
      ? await s.put("sheetClone", row.key, payload)
      : await s.putCopyRows(row.key, payload);
  if (!changesOnly)
    return sheetCloneView(s, all ? saved : await s.get("sheetClone", row.key));
  // The editor holds the copy it sent the revision of: it needs the rows this
  // request changed, not the copy again.
  const documents = await documentListsUnder(
      s,
      ["sheetClone", sheetCloneId],
      "sheetClone",
      { owners: changed },
    ),
    rows = [];
  for (const task of data.tasks) {
    if (!changed.has(task.id)) continue;
    const list = await documents.list(task.id);
    rows.push({
      ...task,
      documentCount: list.length,
      hasDocument: list.some((d) => d.hasContent),
    });
  }
  return {
    id: sheetCloneId,
    name: payload.name,
    year: payload.year,
    referenceDate: payload.referenceDate,
    createdAt: payload.createdAt,
    users: data.users,
    view: data.view,
    revision: await copyRevision(s, saved),
    changes: { tasks: rows, removed },
  };
}
async function execute(ctx, command, body, sheetCloneId, options) {
  if (command === "list") {
    await ctx.team(body.teamId);
    const authors = new Map(
      (await ctx.controlStore.users()).map((row) => [row.id, row.name]),
    );
    return ctx.data(body.teamId, async (s) => {
      const rows = await sheetCloneSummaries(s);
      // Authors who left the team are named by their record; read them at once.
      await s.getMany(
        "person",
        rows
          .filter((r) => !authors.get(r.payload.createdBy))
          .map((r) => [r.payload.createdBy]),
      );
      return {
        sheetClones: await Promise.all(
          rows
            .sort((a, b) =>
              b.payload.createdAt.localeCompare(a.payload.createdAt),
            )
            .map(async (r) => ({
              id: r.key[0],
              name: r.payload.name,
              year: r.payload.year,
              referenceDate: r.payload.referenceDate,
              createdAt: r.payload.createdAt,
              author:
                authors.get(r.payload.createdBy) ||
                (await s.get("person", [r.payload.createdBy]))?.payload.name ||
                r.payload.createdBy,
            })),
        ),
      };
    });
  }
  if (command === "create") {
    const teamId = body.teamId,
      id = body.id || crypto.randomUUID(),
      name = sheetCloneNameSchema.parse(body.name),
      year = yearSchema.parse(body.year),
      referenced = new Set(
        (await ctx.data(teamId, (s) => s.list("person"))).map(
          (row) => row.key[0],
        ),
      ),
      people = (await ctx.bootstrap()).users
        .filter(
          (u) =>
            referenced.has(u.id) ||
            u.teamIds?.includes(teamId) ||
            u.id === ctx.user.id,
        )
        .map(({ id, name }) => ({ id, name }));
    dateSchema.parse(body.referenceDate);
    viewSchema.parse(body.view);
    return ctx.data(
      teamId,
      async (s) => {
        const exists = await s.get("sheetClone", [id]);
        assert(
          !exists,
          409,
          "사본 생성 요청이 변경되었습니다. 새 이름으로 다시 시도하세요.",
        );
        // Names come without each copy's sheet, so the check does not grow
        // with the copies the team keeps.
        requireFreeSheetCloneName(
          (await sheetCloneSummaries(s)).map((r) => r.payload.name),
          name,
        );
        const source = body.sourceId
          ? await s.get("sheetClone", [body.sourceId])
          : null;
        assert(
          !body.sourceId || (source && !source.deleted),
          404,
          "사본을 찾을 수 없습니다.",
        );
        let data;
        if (source) data = structuredClone(source.payload.data);
        else {
          const selected = new Set(body.taskIds || []),
            tasks = (
              await taskList(s, { year, startMonth: body.view.startMonth })
            ).filter((t) => selected.has(t.id));
          assert(
            tasks.length === selected.size,
            409,
            "일부 업무가 변경되었습니다.",
          );
          data = {
            tasks,
            users: [
              ...new Map(
                [
                  ...(await s.list("person")).map((r) => ({
                    id: r.key[0],
                    name: r.payload.name,
                  })),
                  ...people,
                ].map((u) => [u.id, u]),
              ).values(),
            ],
            view: body.view,
            settings: await settingsFor(s),
          };
        }
        // Insights belongs to the live team, never to a frozen sheet snapshot.
        if (data.settings) delete data.settings.insights;
        // Only the documents being copied, grouped by task once: not every
        // document of the team (other copies hold most of them), and not a
        // scan of them per task.
        const docs = new Map();
        for (const d of await s.listChildren(
          "document",
          source ? ["sheetClone", body.sourceId] : ["task"],
        )) {
          const taskId = d.key.at(-2);
          if (!docs.has(taskId)) docs.set(taskId, []);
          docs.get(taskId).push(d);
        }
        for (const task of data.tasks) {
          const sourceDocs = docs.get(task.id) || [];
          task.documents = sourceDocs.map((d) => ({
            id: d.key.at(-1),
            title: d.payload.title,
          }));
          for (const doc of sourceDocs)
            await s.put(
              "document",
              ["sheetClone", id, task.id, doc.key.at(-1)],
              doc.payload,
            );
        }
        for (const memo of await s.listChildren(
          "document",
          source ? ["sheetCloneMemo", body.sourceId] : ["annual", String(year)],
        ))
          await s.put(
            "document",
            ["sheetCloneMemo", id, memo.key.at(-1)],
            memo.payload,
          );
        await s.put("sheetClone", [id], {
          year: source?.payload.year || year,
          name,
          referenceDate: body.referenceDate,
          createdBy: ctx.user.id,
          createdAt: new Date().toISOString(),
          data,
        });
        return { id };
      },
      {
        write: true,
        body: { ...body, operationId: "sheet-clone-create:" + id },
        action: "sheet-clone",
      },
    );
  }
  if (command === "remove")
    return ctx.data(
      body.teamId,
      async (s) => {
        assert(
          Array.isArray(body.ids) &&
            body.ids.length > 0 &&
            body.ids.length <= 20000,
          400,
          "사본 목록을 확인하세요.",
        );
        for (const id of body.ids) {
          const row = await s.get("sheetClone", [id]);
          assert(row && !row.deleted, 404, "사본을 찾을 수 없습니다.");
          for (const doc of await s.list("document"))
            if (
              ["sheetClone", "sheetCloneMemo"].includes(doc.key[0]) &&
              doc.key[1] === id
            )
              await s.put("document", doc.key, doc.payload, { deleted: true });
          await s.put("sheetClone", row.key, row.payload, { deleted: true });
        }
        return { ok: true };
      },
      { write: true, body, action: "sheet-clone-delete" },
    );
  if (command === "edit") {
    const teamId = await ctx.locateTeam("sheetClone", sheetCloneId, {
      write: true,
    });
    assert(
      Array.isArray(body.operations) && body.operations.length <= 1000,
      400,
      "사본 변경 요청을 확인하세요.",
    );
    return ctx.data(
      teamId,
      (s) => edit(ctx, s, teamId, sheetCloneId, body, options?.changes),
      { write: true, body, action: "sheet-clone-edit" },
    );
  }
  if (["read", "rename"].includes(command)) {
    const teamId = await ctx.locateTeam("sheetClone", sheetCloneId, {
      write: command !== "read",
    });
    return ctx.data(
      teamId,
      async (s) => {
        // A name is on the copy's own record: its rows are not read.
        const named =
            command === "rename" && (await s.rowRecords())
              ? await s.getCopyRows([sheetCloneId], [])
              : null,
          row = named || (await s.get("sheetClone", [sheetCloneId]));
        assert(row && !row.deleted, 404, "사본을 찾을 수 없습니다.");
        if (command === "read") return sheetCloneView(s, row);
        const name = sheetCloneNameSchema.parse(body.name);
        assert(
          row.payload.name === body.expectedName || row.payload.name === name,
          409,
          "사본 이름이 변경되었습니다.",
        );
        if (row.payload.name !== name)
          requireFreeSheetCloneName(
            (await sheetCloneSummaries(s))
              .filter((r) => r.key[0] !== sheetCloneId)
              .map((r) => r.payload.name),
            name,
          );
        if (named) await s.putCopyRows(row.key, { ...row.payload, name });
        else await s.put("sheetClone", row.key, { ...row.payload, name });
        return { id: row.key[0], name };
      },
      { write: command !== "read", body, action: "sheet-clone-edit" },
    );
  }
  throw new Error("Unsupported sheetClone command");
}

export class PostgresSheetCloneRepository {
  constructor({ context }) {
    this.context = context;
  }
  async call(user, command, body, sheetCloneId, options) {
    assert(
      user.id === this.context.user.id,
      403,
      "요청 사용자 정보가 일치하지 않습니다.",
    );
    const before = this.context.lastCommittedChange?.sequence || 0;
    const result = await execute(
      this.context,
      command,
      body,
      sheetCloneId,
      options,
    );
    const change = this.context.lastCommittedChange;
    this.changes =
      change && change.sequence > before
        ? {
            teamIds: [change.teamId],
            sheetCloneIds:
              command === "remove" ? body.ids : [sheetCloneId || result.id],
          }
        : null;
    return result;
  }
  resourceChanges() {
    return this.changes;
  }
  subscribe(user, sheetCloneId, port) {
    return subscribePostgresEvents({
      user,
      ...port,
      read: async (currentUser, cursor) => {
        assert(
          currentUser.id === user.id,
          403,
          "요청 사용자 정보가 일치하지 않습니다.",
        );
        this.context.user = currentUser;
        this.context.teamCache.clear();
        this.context.controlStore.forget?.();
        const { teamId, row } = await this.located(sheetCloneId);
        const next = `pg:sheet-clone:${sheetCloneId}:${row.revision}`;
        return {
          cursor: next,
          events:
            next === cursor
              ? []
              : [
                  {
                    event: "document",
                    cursor: next,
                    payload: {
                      revision: row.revision,
                      sync: { session: "pg:" + teamId, sequence: row.revision },
                    },
                  },
                ],
        };
      },
    });
  }
  async watchRevision(user, id) {
    assert(
      user.id === this.context.user.id,
      403,
      "요청 사용자 정보가 일치하지 않습니다.",
    );
    const { row } = await this.located(id);
    return { revision: row.revision };
  }
  // The copy's team and site revision. Viewers ask this every few seconds,
  // so the copy itself is not read.
  async located(id) {
    const teamId = await this.context.locateTeam("sheetClone", id),
      revision = await this.context.data(teamId, (s) =>
        s.revisionOf("sheetClone", [id]),
      );
    assert(revision !== null, 404, "자료를 찾을 수 없습니다.");
    return { teamId, row: { revision } };
  }
  list(user, query) {
    return this.call(user, "list", query);
  }
  create(user, input) {
    return this.call(user, "create", input);
  }
  read(user, id) {
    return this.call(user, "read", {}, id);
  }
  rename(user, id, input) {
    return this.call(user, "rename", input, id);
  }
  edit(user, id, input, options) {
    return this.call(user, "edit", input, id, options);
  }
  remove(user, input) {
    return this.call(user, "remove", input);
  }
}
