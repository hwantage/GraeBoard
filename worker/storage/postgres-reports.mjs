import { prepareReportEdits } from "../../server/storage/report-command-rules.mjs";
import { subscribePostgresEvents } from "./postgres-events.mjs";
import { z } from "zod";
import { applyReportOperation } from "../../shared/report-editing.js";
import {
  propertiesFor,
  normalizeView,
  savedFilter,
  canManageTeam,
  filteredTasks,
  defaultView,
  groupValue,
  displayValue,
} from "../../shared/domain.js";
import {
  reportNameSchema,
  dateSchema,
  yearSchema,
  viewSchema,
  validateCellValue,
  savedFilterSchema,
} from "../../shared/validation.js";
import { digestShared, equal } from "../../server/sync/protocol.mjs";
import { assert } from "../access.mjs";
import { imageReferences } from "../images.mjs";
import { settingsFor, taskList, taskView, stamp } from "../task-view.mjs";
import { documentListsUnder } from "./postgres-documents.mjs";
import { controlTransaction } from "../data.mjs";
import { userRecord } from "../control.mjs";
export const reportRevision = (data) =>
  digestShared({
    ...data,
    tasks: data.tasks.map(
      ({ documents, hasDocument, documentCount, ...task }) => task,
    ),
  });
// What the report list shows, without the data: PostgreSQL drops it, so the
// list does not transfer and unpack every report's sheet. A payload that
// jsonb cannot read (\u0000 or a lone surrogate escape) comes whole instead.
async function reportSummaries(s) {
  return (
    await s.tx.query(
      "SELECT entity_key,CASE WHEN payload ~ $2 THEN payload ELSE (payload::jsonb - 'data')::text END AS payload FROM site_entities WHERE team_id=$1 AND entity='report' AND deleted=0 ORDER BY entity_key",
      [s.teamId, "\\\\u(0000|[dD][89a-fA-F])"],
    )
  ).rows.map((row) => ({
    key: JSON.parse(row.entity_key),
    payload: JSON.parse(row.payload),
  }));
}
export async function reportView(s, row) {
  const p = row.payload,
    data = p.data;
  const lists = await documentListsUnder(s, ["report", row.key[0]], "report");
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
    revision: reportRevision(data),
  };
}
async function execute(ctx, command, body, reportId) {
  if (command === "list") {
    await ctx.team(body.teamId);
    const authors = new Map(
      (await ctx.controlStore.users()).map((row) => [row.id, row.name]),
    );
    return ctx.data(body.teamId, async (s) => {
      const rows = await reportSummaries(s);
      // Authors who left the team are named by their record; read them at once.
      await s.getMany(
        "person",
        rows
          .filter((r) => !authors.get(r.payload.createdBy))
          .map((r) => [r.payload.createdBy]),
      );
      return {
        reports: await Promise.all(
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
    // Documents copied into the copy, to name the ones whose images the
    // image store lacks: nothing was pasted, so asking to paste again misleads.
    const copied = [];
    const teamId = body.teamId,
      id = body.id || crypto.randomUUID(),
      name = reportNameSchema.parse(body.name),
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
    return ctx
      .data(
        teamId,
        async (s) => {
          const exists = await s.get("report", [id]);
          assert(
            !exists,
            409,
            "사본 생성 요청이 변경되었습니다. 새 이름으로 다시 시도하세요.",
          );
          // Names come without each copy's sheet, so the check does not grow
          // with the copies the team keeps.
          assert(
            !(await reportSummaries(s)).some((r) => r.payload.name === name),
            409,
            "같은 이름의 사본이 있습니다.",
          );
          const source = body.sourceId
            ? await s.get("report", [body.sourceId])
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
          // Only the documents being copied, grouped by task once: not every
          // document of the team (other copies hold most of them), and not a
          // scan of them per task.
          const docs = new Map();
          for (const d of await s.listChildren(
            "document",
            source ? ["report", body.sourceId] : ["task"],
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
            for (const doc of sourceDocs) {
              copied.push({
                label: `업무 「${task.cells?.title?.value || "제목 없음"}」의 문서 「${doc.payload.title}」`,
                payload: doc.payload,
              });
              await s.put(
                "document",
                ["report", id, task.id, doc.key.at(-1)],
                doc.payload,
              );
            }
          }
          for (const memo of await s.listChildren(
            "document",
            source ? ["reportMemo", body.sourceId] : ["annual", String(year)],
          )) {
            copied.push({
              label: `연간 메모 「${memo.payload.title}」`,
              payload: memo.payload,
            });
            await s.put(
              "document",
              ["reportMemo", id, memo.key.at(-1)],
              memo.payload,
            );
          }
          await s.put("report", [id], {
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
          body: { ...body, operationId: "report-create:" + id },
          action: "report",
        },
      )
      .catch((error) => {
        const missing = new Set(error.details?.missingImages || []);
        if (!missing.size) throw error;
        const holders = copied
          .filter((doc) =>
            imageReferences(doc.payload, teamId).some((url) =>
              missing.has(url),
            ),
          )
          .map((doc) => doc.label);
        assert(
          false,
          400,
          `원본 문서의 이미지 ${missing.size}개가 서버에 없어 사본을 만들 수 없습니다${holders.length ? `: ${holders.slice(0, 3).join(", ")}${holders.length > 3 ? ` 외 ${holders.length - 3}건` : ""}` : ""}. 관리자에게 문서 이미지 복구를 요청하세요.`,
          { missingImages: [...missing] },
        );
      });
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
          const row = await s.get("report", [id]);
          assert(row && !row.deleted, 404, "사본을 찾을 수 없습니다.");
          for (const doc of await s.list("document"))
            if (
              ["report", "reportMemo"].includes(doc.key[0]) &&
              doc.key[1] === id
            )
              await s.put("document", doc.key, doc.payload, { deleted: true });
          await s.put("report", row.key, row.payload, { deleted: true });
        }
        return { ok: true };
      },
      { write: true, body, action: "report-delete" },
    );
  if (["read", "rename", "edit"].includes(command)) {
    const { teamId } = await ctx.locate("report", reportId, {
      write: command !== "read",
    });
    return ctx.data(
      teamId,
      async (s) => {
        const row = await s.get("report", [reportId]);
        assert(row && !row.deleted, 404, "사본을 찾을 수 없습니다.");
        if (command === "read") return reportView(s, row);
        if (command === "rename") {
          const name = reportNameSchema.parse(body.name);
          assert(
            row.payload.name === body.expectedName || row.payload.name === name,
            409,
            "사본 이름이 변경되었습니다.",
          );
          assert(
            !(await s.list("report")).some(
              (r) => r.key[0] !== reportId && r.payload.name === name,
            ),
            409,
            "같은 이름의 사본이 있습니다.",
          );
          await s.put("report", row.key, { ...row.payload, name });
          return { id: row.key[0], name };
        }
        assert(
          body.revision === reportRevision(row.payload.data),
          409,
          "다른 사용자가 사본을 수정했습니다. 입력은 유지됩니다.",
        );
        assert(
          Array.isArray(body.operations) && body.operations.length <= 1000,
          400,
          "사본 변경 요청을 확인하세요.",
        );
        const data = structuredClone(row.payload.data),
          lists = await documentListsUnder(s, ["report", reportId], "report");
        for (const task of data.tasks)
          task.documents = await lists.list(task.id, { content: true });
        const available = (await ctx.controlStore.members(teamId)).filter(
          (row) => ["lead", "member"].includes(row.role),
        );
        const prepared = prepareReportEdits({
          report: data,
          operations: body.operations,
          teamId,
          year: body.view?.year ?? row.payload.year,
          actorId: ctx.user.id,
          available,
        });
        let { tasks } = prepared;
        data.users = [...prepared.people.values()];
        const remainingIds = new Set(tasks.map((task) => task.id));
        // Nothing was written since: the rows read above are still current.
        for (const doc of lists.rows)
          if (!remainingIds.has(doc.key[2]))
            await s.put("document", doc.key, doc.payload, { deleted: true });
        for (const task of tasks)
          for (const doc of task.documents || [])
            if (typeof doc.markdown === "string")
              await s.put("document", ["report", row.key[0], task.id, doc.id], {
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
        const saved = await s.put("report", row.key, {
          ...row.payload,
          year: body.view?.year ?? row.payload.year,
          data,
        });
        return reportView(s, saved);
      },
      { write: command !== "read", body, action: "report-edit" },
    );
  }
  throw new Error("Unsupported report command");
}

export class PostgresReportRepository {
  constructor({ context }) {
    this.context = context;
  }
  async call(user, command, body, reportId) {
    assert(
      user.id === this.context.user.id,
      403,
      "요청 사용자 정보가 일치하지 않습니다.",
    );
    const before = this.context.lastCommittedChange?.sequence || 0;
    const result = await execute(this.context, command, body, reportId);
    const change = this.context.lastCommittedChange;
    this.changes =
      change && change.sequence > before
        ? {
            teamIds: [change.teamId],
            reportIds:
              command === "remove" ? body.ids : [reportId || result.id],
          }
        : null;
    return result;
  }
  resourceChanges() {
    return this.changes;
  }
  subscribe(user, reportId, port) {
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
        const { teamId, row } = await this.context.locate("report", reportId);
        const next = `pg:report:${reportId}:${row.revision}`;
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
    const { row } = await this.context.locate("report", id);
    return { revision: row.revision };
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
  edit(user, id, input) {
    return this.call(user, "edit", input, id);
  }
  remove(user, input) {
    return this.call(user, "remove", input);
  }
}
