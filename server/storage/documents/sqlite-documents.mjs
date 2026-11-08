import { withPreparedDocumentImageReferences } from "../../../shared/documents/document-image-references.js";
import { z } from "zod";
import { calendarPreview } from "../calendar/calendar-service.mjs";
import { createHash } from "node:crypto";
import {
  audit,
  now,
  parse,
  transaction,
  touchTasks,
  userWithTeams,
} from "../../db.mjs";
import { requireThat } from "../../../shared/validation.js";
import { canContribute } from "../../../shared/domain.js";
import {
  DEFAULT_DOCUMENT_ID,
  DEFAULT_DOCUMENT_TITLE,
  MAX_TASK_DOCUMENTS,
  hasDocumentContent,
} from "../../../shared/documents/task-documents.js";
import { retentionView } from "../../sync/node/visibility.mjs";
import {
  getTaskDocument,
  listTaskDocuments,
  withTaskDocuments,
} from "../../documents/task-documents.mjs";
import { sheetCloneTaskDocument } from "../../sheet-clones/sheet-clone-documents.mjs";
import {
  readDocumentVersion,
  storeDocumentVersion,
  storeSheetCloneDocuments,
  syncSheetCloneDocuments,
  pruneDocumentVersions,
  readSheetClone,
  sheetCloneDocumentTasks,
} from "../../documents/document-storage.mjs";
import { encodeSheetClone } from "../../sheet-clones/sheet-clones.mjs";
import {
  validateDocumentImages,
  writeDocumentImage,
  readDocumentImage,
} from "../../documents/document-images.mjs";
import {
  nextDocumentTitle,
  requireDocumentRevision,
  requireDocumentTitle,
  requireDocumentOrder,
  documentEventKey,
  documentCollectionKey,
  documentImageUrl,
} from "./document-service.mjs";

// Relational document storage. Ordinary writes use the application transaction,
// including capture before COMMIT; no synchronization replay transaction is used.
export class SqliteDocumentRepository {
  constructor({
    db,
    control,
    documentImagesDir,
    documentEvents,
    documentPreparation,
  }) {
    Object.assign(this, {
      db,
      control,
      documentImagesDir,
      documentEvents,
      documentPreparation,
    });
  }
  validateRevision(scope, value) {
    (scope.kind === "sheetClone"
      ? z.union([z.literal(0), z.string().uuid()])
      : z.number().int().nonnegative()
    ).parse(value);
  }
  access(
    user,
    scope,
    write = false,
    { image = false, taskIds, previous } = {},
  ) {
    const db = this.db;
    let context;
    if (scope.kind === "task") {
      const task = this.control.taskAccess(user, scope.taskId, write);
      context = { task, teamId: task.teamId, prefix: ["task", task.id] };
    } else if (["sheetClone", "sheetCloneMemo"].includes(scope.kind)) {
      const row = db
        .prepare("SELECT * FROM sheet_clones WHERE id=?")
        .get(scope.sheetCloneId);
      requireThat(row, 404, "사본을 찾을 수 없습니다.");
      this.control.teamAccess(user, row.team_id);
      if (write)
        requireThat(
          canContribute(user, row.team_id),
          403,
          scope.kind === "sheetCloneMemo"
            ? "메모 편집 권한이 없습니다."
            : image
              ? "사본에 이미지를 추가할 권한이 없습니다."
              : "사본을 편집할 권한이 없습니다.",
        );
      retentionView(db, row.team_id).requireVisible("sheetClone", [row.id]);
      context = {
        row,
        sheetCloneId: row.id,
        teamId: row.team_id,
        year: row.year,
      };
      if (scope.kind === "sheetClone") {
        // Reuse the decoded BLOB index when only document references changed.
        // Fresh references, membership and retention checks still run below.
        if (
          previous?.row?.id === row.id &&
          Buffer.from(row.data).equals(Buffer.from(previous.row.data))
        )
          row.data = previous.row.data;
        const tasks = sheetCloneDocumentTasks(
          db,
          row,
          taskIds || [scope.taskId],
        );
        requireThat(
          tasks?.length,
          404,
          "사본에서 해당 업무를 찾지 못했습니다.",
        );
        Object.assign(context, {
          task: tasks[0],
          tasks,
          prefix: ["sheetClone", row.id, scope.taskId],
        });
      } else
        Object.assign(context, {
          prefix: ["sheetCloneMemo", row.id],
          table: "sheet_clone_memos",
          where: "sheet_clone_id=?",
          args: [row.id],
        });
    } else if (scope.kind === "annual") {
      this.control.teamAccess(user, scope.teamId);
      if (write)
        requireThat(
          canContribute(user, scope.teamId),
          403,
          "메모 편집 권한이 없습니다.",
        );
      context = {
        teamId: scope.teamId,
        year: scope.year,
        prefix: ["annual", String(scope.year)],
        table: "annual_memos",
        where: "team_id=? AND year=?",
        args: [scope.teamId, scope.year],
      };
    } else {
      const port = this.control.calendarDocuments;
      requireThat(port, 503, "일정 문서 저장소를 확인하세요.");
      const row = port.entryAccess(user, scope.entryId, write);
      context = {
        row,
        teamId: row.team_id,
        prefix: ["calendar", row.id],
        port,
      };
    }
    context.scope = scope;
    context.visibility = retentionView(db, context.teamId);
    if (
      scope.kind === "annual" &&
      context.visibility.years.has(String(scope.year))
    ) {
      requireThat(
        !write && !scope.documentId,
        409,
        "이 사이트에서 정리한 연도입니다. 설정에서 복원한 뒤 사용하세요.",
      );
      context.excluded = true;
    }
    if (scope.documentId)
      context.visibility.requireVisible("document", [
        ...context.prefix,
        scope.documentId,
      ]);
    return context;
  }
  rows(context, { content = false, visible = true } = {}) {
    const { db } = this,
      { scope, task } = context;
    let documents;
    if (scope.kind === "task")
      documents = content
        ? withTaskDocuments(db, [task])[0].documents
        : listTaskDocuments(db, task.id);
    else if (scope.kind === "sheetClone") {
      documents = (task.documents || []).map((doc) => ({
        id: doc.id,
        title: doc.title,
        ...(content
          ? { markdown: readDocumentVersion(db, doc.versionId).markdown }
          : {
              hasContent: !!doc.hasContent,
              revision: doc.versionId,
              updatedAt: null,
            }),
      }));
      if (!content && !documents.length)
        documents = [
          {
            id: DEFAULT_DOCUMENT_ID,
            title: DEFAULT_DOCUMENT_TITLE,
            hasContent: false,
            revision: 0,
            updatedAt: null,
          },
        ];
    } else if (context.table)
      documents = db
        .prepare(
          `SELECT id,title,revision,has_content AS hasContent,updated_at AS updatedAt${content ? ",version_id" : ""} FROM ${context.table} WHERE ${context.where} ORDER BY position,id`,
        )
        .all(...context.args)
        .map((doc) => {
          if (!content) return doc;
          const { version_id, ...metadata } = doc;
          return {
            ...metadata,
            markdown: readDocumentVersion(db, version_id).markdown,
          };
        });
    else documents = [];
    return visible
      ? context.excluded
        ? []
        : context.visibility.documents(documents, context.prefix)
      : documents;
  }
  summary(context) {
    const { scope, task } = context;
    if (scope.kind === "task") {
      // Preserve the empty virtual document's old count of zero.
      const rows = this.db
        .prepare(
          "SELECT id,has_content AS hasContent FROM task_documents WHERE task_id=?",
        )
        .all(task.id);
      const documents = context.visibility.documents(rows, context.prefix);
      return {
        hasDocument: documents.some((d) => d.hasContent),
        documentCount: documents.length,
        taskUpdatedAt: this.db
          .prepare("SELECT updated_at FROM tasks WHERE id=?")
          .get(task.id).updated_at,
      };
    }
    if (scope.kind === "sheetClone") {
      const documents = context.visibility.documents(
        task.documents || [],
        context.prefix,
      );
      return {
        hasDocument: documents.some((d) => d.hasContent),
        documentCount: documents.length,
        taskUpdatedAt: task.updatedAt,
      };
    }
    return {};
  }
  result(context) {
    return { documents: this.rows(context), ...this.summary(context) };
  }
  memo(context, id) {
    const memo = this.db
      .prepare(
        `SELECT m.*,v.document_id AS document_identity FROM ${context.table} m JOIN document_versions v ON v.id=m.version_id WHERE ${context.where
          .split(" AND ")
          .map((x) => "m." + x)
          .join(" AND ")} AND m.id=?`,
      )
      .get(...context.args, id);
    requireThat(memo, 404, "메모를 찾을 수 없습니다.");
    return memo;
  }
  body(context, { summary = true } = {}) {
    const { scope } = context;
    if (scope.kind === "task")
      return {
        ...getTaskDocument(this.db, scope.taskId, scope.documentId),
        ...(summary ? this.summary(context) : {}),
      };
    if (scope.kind === "sheetClone")
      return {
        ...sheetCloneTaskDocument(this.db, context.task, scope.documentId),
        ...this.summary(context),
      };
    if (scope.kind === "calendar")
      return {
        ...context.port.read(context.row),
        ...(summary ? { entry: context.port.summary(scope.entryId) } : {}),
      };
    const memo = this.memo(context, scope.documentId);
    return {
      id: memo.id,
      title: memo.title,
      markdown: readDocumentVersion(this.db, memo.version_id).markdown,
      revision: memo.revision,
      updatedAt: memo.updated_at,
    };
  }
  imageAccess(user, scope) {
    const context = this.access(user, scope, true, { image: true });
    requireThat(
      !this.db
        .prepare(
          "SELECT 1 FROM site_maintenance_jobs WHERE team_id=? AND phase NOT IN ('complete','cancelled') AND kind<>'backup'",
        )
        .get(context.teamId),
      409,
      "팀 자료 정리 중입니다. 잠시 후 다시 저장하세요.",
    );
    this.body(context, { summary: false });
    return context.teamId;
  }
  putImage(user, scope, bytes) {
    const teamId = this.imageAccess(user, scope),
      url = documentImageUrl(teamId, bytes);
    writeDocumentImage(this.documentImagesDir, url, bytes);
    return { url };
  }
  readImage(user, teamId, url, { stream = false } = {}) {
    this.control.teamAccess(user, teamId);
    try {
      const bytes = readDocumentImage(this.documentImagesDir, url);
      return stream ? new Blob([bytes]).stream() : bytes;
    } catch (error) {
      requireThat(
        error.code !== "ENOENT",
        404,
        "문서 이미지를 찾을 수 없습니다.",
      );
      throw error;
    }
  }
  list(user, scope, options) {
    return { documents: this.rows(this.access(user, scope), options) };
  }
  read(user, scope, { summary = false } = {}) {
    const context = this.access(user, scope);
    return scope.kind === "sheetClone"
      ? { ...this.body(context), ...this.result(context) }
      : this.body(context, { summary });
  }
  run(user, work) {
    const perform = () => transaction(this.db, work);
    return this.db.syncCapture
      ? this.db.syncCapture.withActor(user.id, perform)
      : perform();
  }
  invalidate(context, { body = false, presence = true, clientId } = {}) {
    const events = this.documentEvents;
    if (!events) return;
    if (presence) {
      events.invalidate(
        context.scope.kind.startsWith("sheetClone")
          ? `sheet-clone:${context.scope.sheetCloneId}`
          : `team:${context.teamId}`,
        clientId,
      );
      const key = documentCollectionKey(context.scope);
      if (key) events.invalidate(key, clientId);
    }
    if (body) events.notify(documentEventKey(context.scope));
  }
  insertTask(context, id, title, position, actorId) {
    this.db
      .prepare(
        "INSERT INTO task_documents(task_id,id,title,position,version_id,has_content,revision,updated_at,actor_id) VALUES(?,?,?,?,?,0,0,?,?)",
      )
      .run(
        context.task.id,
        id,
        title,
        position,
        storeDocumentVersion(this.db, {
          teamId: context.teamId,
          documentId: `${context.task.id}:${id}`,
          markdown: "",
          actorId,
        }),
        now(),
        actorId,
      );
  }
  persistSheetClone(context, documents, actorId, bodyOnly) {
    const { db } = this,
      { row, task } = context;
    if (bodyOnly) {
      const [saved] = storeSheetCloneDocuments(
        db,
        [
          {
            ...task,
            documents: task.documents.map((doc) =>
              doc.id === bodyOnly.id ? bodyOnly : doc,
            ),
          },
        ],
        row.team_id,
        actorId,
      );
      const version = saved.documents.find((doc) => doc.id === bodyOnly.id);
      db.prepare(
        "UPDATE sheet_clone_documents SET version_id=? WHERE sheet_clone_id=? AND task_id=? AND document_id=?",
      ).run(version.versionId, row.id, task.id, bodyOnly.id);
      pruneDocumentVersions(db, row.team_id, [bodyOnly.versionId]);
      context.task = saved;
    } else {
      const sheetClone = readSheetClone(db, row),
        original = sheetClone.tasks.find((item) => item.id === task.id);
      const [saved] = storeSheetCloneDocuments(
        db,
        [{ ...original, documents }],
        row.team_id,
        actorId,
      );
      const tasks = sheetClone.tasks.map((item) =>
        item.id === task.id ? saved : item,
      );
      db.prepare("UPDATE sheet_clones SET data=? WHERE id=?").run(
        encodeSheetClone({ ...sheetClone, tasks }),
        row.id,
      );
      syncSheetCloneDocuments(db, row.id, tasks);
      pruneDocumentVersions(db, row.team_id);
      context.task = saved;
    }
  }
  memoAudit(user, context, action, target, before, after) {
    audit(
      this.db,
      user.id,
      context.teamId,
      context.scope.kind === "sheetCloneMemo"
        ? `sheet-clone-${action}`
        : action,
      target,
      before,
      {
        ...after,
        ...(context.sheetCloneId ? { sheetCloneId: context.sheetCloneId } : {}),
      },
    );
  }
  create(user, scope, data, { clientId } = {}) {
    let context;
    const result = this.run(user, () => {
      context = this.access(user, scope, true);
      context.visibility.requireVisible("document", [
        ...context.prefix,
        data.id,
      ]);
      requireThat(
        scope.kind !== "calendar",
        400,
        "일정 문서는 추가할 수 없습니다.",
      );
      const documents = this.rows(context, { visible: false });
      if (documents.some((doc) => doc.id === data.id))
        return this.result(context);
      requireThat(
        documents.length < MAX_TASK_DOCUMENTS,
        400,
        ["annual", "sheetCloneMemo"].includes(scope.kind)
          ? `메모는 ${MAX_TASK_DOCUMENTS}개까지 추가할 수 있습니다.`
          : `업무마다 문서를 ${MAX_TASK_DOCUMENTS}개까지 추가할 수 있습니다.`,
      );
      const title = data.title || nextDocumentTitle(documents, scope.kind);
      if (scope.kind === "task") {
        if (
          !this.db
            .prepare("SELECT 1 FROM task_documents WHERE task_id=? LIMIT 1")
            .get(scope.taskId)
        )
          this.insertTask(context, "main", DEFAULT_DOCUMENT_TITLE, 0, user.id);
        const position =
          this.db
            .prepare(
              "SELECT MAX(position) AS value FROM task_documents WHERE task_id=?",
            )
            .get(scope.taskId).value + 1;
        this.insertTask(context, data.id, title, position, user.id);
        touchTasks(this.db, [context.task]);
        audit(
          this.db,
          user.id,
          context.teamId,
          "document-create",
          scope.taskId,
          undefined,
          { documentId: data.id },
        );
      } else if (scope.kind === "sheetClone") {
        const docs = context.task.documents?.length
          ? context.task.documents
          : [{ id: "main", title: DEFAULT_DOCUMENT_TITLE, markdown: "" }];
        this.persistSheetClone(
          context,
          [...docs, { id: data.id, title, markdown: "" }],
          user.id,
        );
        audit(
          this.db,
          user.id,
          context.teamId,
          "document-create",
          `${scope.sheetCloneId}:${scope.taskId}`,
          undefined,
          { documentId: data.id },
        );
      } else {
        const position = this.db
          .prepare(
            `SELECT COALESCE(MAX(position),-1)+1 AS value FROM ${context.table} WHERE ${context.where}`,
          )
          .get(...context.args).value;
        const versionId = storeDocumentVersion(this.db, {
          teamId: context.teamId,
          documentId: `memo:${context.sheetCloneId || context.year}:${data.id}`,
          markdown: "",
          actorId: user.id,
        });
        this.db
          .prepare(
            `INSERT INTO ${context.table}(${context.sheetCloneId ? "sheet_clone_id" : "team_id,year"},id,title,position,version_id,has_content,revision,updated_at,actor_id) VALUES(${context.sheetCloneId ? "?" : "?,?"},?,?,?,?,0,0,?,?)`,
          )
          .run(
            ...context.args,
            data.id,
            title,
            position,
            versionId,
            now(),
            user.id,
          );
        this.memoAudit(user, context, "memo-create", data.id, undefined, {
          year: context.year,
        });
      }
      return this.result(context);
    });
    this.invalidate(context, { clientId });
    return result;
  }
  rename(user, scope, data, { clientId } = {}) {
    let context;
    const result = this.run(user, () => {
      context = this.access(user, scope, true);
      const current = this.body(context);
      requireDocumentTitle(current, data);
      if (scope.kind === "task") {
        if (
          !this.db
            .prepare("SELECT 1 FROM task_documents WHERE task_id=? AND id=?")
            .get(scope.taskId, scope.documentId)
        )
          this.insertTask(context, scope.documentId, current.title, 0, user.id);
        this.db
          .prepare("UPDATE task_documents SET title=? WHERE task_id=? AND id=?")
          .run(data.title, scope.taskId, scope.documentId);
        touchTasks(this.db, [context.task]);
      } else if (scope.kind === "sheetClone") {
        const docs = context.task.documents?.length
          ? context.task.documents
          : [{ id: "main", title: DEFAULT_DOCUMENT_TITLE, markdown: "" }];
        this.persistSheetClone(
          context,
          docs.map((doc) =>
            doc.id === scope.documentId ? { ...doc, title: data.title } : doc,
          ),
          user.id,
        );
      } else {
        requireThat(
          context.table,
          400,
          "일정 문서의 이름은 일정에서 변경하세요.",
        );
        this.db
          .prepare(
            `UPDATE ${context.table} SET title=? WHERE ${context.where} AND id=?`,
          )
          .run(data.title, ...context.args, scope.documentId);
      }
      return this.result(context);
    });
    this.invalidate(context, { clientId });
    return result;
  }
  remove(user, scope, data, { clientId } = {}) {
    let context;
    const result = this.run(user, () => {
      context = this.access(user, scope, true);
      const current = this.body(context);
      requireThat(
        current.revision === data.expectedRevision,
        409,
        "문서가 변경되었습니다. 최신 문서를 확인한 뒤 삭제하세요.",
      );
      if (scope.kind === "task") {
        this.db
          .prepare("DELETE FROM task_documents WHERE task_id=? AND id=?")
          .run(scope.taskId, scope.documentId);
        touchTasks(this.db, [context.task]);
        pruneDocumentVersions(this.db, context.teamId);
        audit(
          this.db,
          user.id,
          context.teamId,
          "document-delete",
          scope.taskId,
          { documentId: scope.documentId, title: current.title },
        );
      } else if (scope.kind === "sheetClone") {
        this.persistSheetClone(
          context,
          (context.task.documents || []).filter(
            (doc) => doc.id !== scope.documentId,
          ),
          user.id,
        );
        audit(
          this.db,
          user.id,
          context.teamId,
          "document-delete",
          `${scope.sheetCloneId}:${scope.taskId}`,
          { documentId: scope.documentId, title: current.title },
        );
      } else {
        requireThat(
          context.table,
          400,
          "일정 문서는 일정을 삭제할 때 함께 삭제됩니다.",
        );
        const memo = this.memo(context, scope.documentId);
        this.db
          .prepare(
            `DELETE FROM ${context.table} WHERE ${context.where} AND id=?`,
          )
          .run(...context.args, scope.documentId);
        pruneDocumentVersions(this.db, context.teamId, [memo.version_id]);
        this.memoAudit(user, context, "memo-delete", scope.documentId, {
          year: context.year,
          title: memo.title,
        });
      }
      return this.result(context);
    });
    this.invalidate(context, { body: true, clientId });
    return result;
  }
  reorder(user, scope, data, { clientId } = {}) {
    let context;
    const result = this.run(user, () => {
      context = this.access(user, scope, true);
      const documents = this.rows(context, { visible: false }),
        currentIds = documents.map((doc) => doc.id);
      const hidden = new Set(
        documents
          .filter((doc) =>
            context.visibility.hidden("document", [...context.prefix, doc.id]),
          )
          .map((doc) => doc.id),
      );
      const includeHidden = (values) => {
        const visible = [...values];
        return currentIds
          .map((id) => (hidden.has(id) ? id : visible.shift()))
          .concat(visible)
          .filter(Boolean);
      };
      const ids = includeHidden(data.ids),
        expectedIds = includeHidden(data.expectedIds);
      const replay = requireDocumentOrder(
        currentIds,
        { ids, expectedIds },
        this.rows(context),
      );
      if (!replay) {
        const put = this.db.prepare(
          `UPDATE ${context.table} SET position=? WHERE ${context.where} AND id=?`,
        );
        ids.forEach((id, index) => put.run(index, ...context.args, id));
        this.memoAudit(
          user,
          context,
          "memo-reorder",
          String(context.year),
          { ids: currentIds },
          { ids },
        );
      }
      return this.result(context);
    });
    this.invalidate(context, { clientId });
    return result;
  }
  async save(user, scope, data, { clientId, refreshUser } = {}) {
    // Parse both exact bodies off the main event loop, before the single writer.
    // Include base even while unlinked: linking may change during preparation.
    const preparedContext = this.access(user, scope, true);
    const actorId = user.id;
    const prepared = this.body(preparedContext, {
      summary: false,
    });
    const preparedRevision = {
      changes: this.db.prepare("SELECT total_changes() n").get().n,
      dataVersion: this.db.prepare("PRAGMA data_version").get().data_version,
    };
    const references = await this.documentPreparation.prepare([
      prepared.markdown,
      data.markdown,
    ]);
    // Request authentication/membership may have changed while the worker ran.
    // Direct repository callers have no session, but still reload active role
    // and memberships from the control database immediately before commit.
    const identity = refreshUser
      ? refreshUser()
      : userWithTeams(
          this.db,
          this.db
            .prepare("SELECT * FROM users WHERE id=? AND active=1")
            .get(user.id),
        );
    user = identity?.then ? await identity : identity;
    requireThat(user && user.id === actorId, 401, "로그인이 필요합니다.");
    let context,
      presence = false,
      changed = false;
    const result = withPreparedDocumentImageReferences(references, () =>
      this.run(user, () => {
        // BEGIN IMMEDIATE has excluded concurrent writers. Both counters must
        // match before reusing the already-read body: total_changes catches this
        // connection and data_version catches commits from other connections.
        const unchanged =
          preparedRevision.changes ===
            this.db.prepare("SELECT total_changes() n").get().n &&
          preparedRevision.dataVersion ===
            this.db.prepare("PRAGMA data_version").get().data_version;
        context = this.access(user, scope, true, { previous: preparedContext });
        const current = unchanged
            ? { ...prepared }
            : this.body(context, { summary: false }),
          hash = createHash("sha256")
            .update(JSON.stringify(data))
            .digest("hex");
        let previous, replay;
        if (scope.kind === "task")
          previous = this.db
            .prepare(
              "SELECT operation_id,request_hash,actor_id,version_id FROM task_documents WHERE task_id=? AND id=?",
            )
            .get(scope.taskId, scope.documentId);
        else if (scope.kind === "calendar") previous = context.row;
        else if (scope.kind === "sheetClone") {
          const last = this.db
            .prepare(
              "SELECT after_json FROM audit WHERE team_id=? AND action='sheet-clone-document' AND target=? AND actor_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
            )
            .get(
              context.teamId,
              `${scope.sheetCloneId}:${scope.taskId}:${scope.documentId}`,
              user.id,
            );
          const value = last && parse(last.after_json);
          replay =
            value?.operationId === data.operationId &&
            value.requestHash === hash &&
            value.revision === current.revision;
        } else previous = this.memo(context, scope.documentId);
        if (scope.kind !== "sheetClone")
          replay =
            previous?.operation_id === data.operationId &&
            previous.actor_id === user.id &&
            previous.request_hash === hash;
        if (scope.kind === "calendar") {
          if (this.documentEvents)
            Object.assign(current, this.documentEvents.stamp(current));
          requireThat(
            replay || current.revision === data.expectedRevision,
            409,
            "다른 사용자가 일정을 수정했습니다. 입력은 보존됩니다. 최신 문서를 확인하세요.",
            { current },
          );
        } else requireDocumentRevision(current, data, replay);
        // A concurrent identical command may already have committed while this
        // request prepared. Preserve exact actor/operation/hash replay; only a
        // new write must still match the body whose extraction we pinned.
        requireThat(
          replay ||
            (context.teamId === preparedContext.teamId &&
              current.revision === prepared.revision &&
              current.markdown === prepared.markdown),
          409,
          scope.kind === "calendar"
            ? "다른 사용자가 일정을 수정했습니다. 입력은 보존됩니다. 최신 문서를 확인하세요."
            : "다른 사용자가 문서를 수정했습니다. 입력은 보존되었습니다. 최신 문서를 확인한 뒤 다시 저장하세요.",
          { current },
        );
        if (!replay && current.markdown !== data.markdown) {
          changed = true;
          validateDocumentImages(data.markdown, context.teamId);
          presence =
            hasDocumentContent(current.markdown) !==
            hasDocumentContent(data.markdown);
          if (scope.kind === "sheetClone") {
            const docs = context.task.documents || [],
              existing = docs.find((doc) => doc.id === scope.documentId),
              document = {
                ...existing,
                id: scope.documentId,
                title: current.title,
                markdown: data.markdown,
              };
            this.persistSheetClone(
              context,
              [...docs, document],
              user.id,
              existing ? document : undefined,
            );
            audit(
              this.db,
              user.id,
              context.teamId,
              "sheet-clone-document",
              `${scope.sheetCloneId}:${scope.taskId}:${scope.documentId}`,
              { revision: current.revision },
              {
                revision: sheetCloneTaskDocument(
                  this.db,
                  context.task,
                  scope.documentId,
                ).revision,
                operationId: data.operationId,
                requestHash: hash,
              },
            );
          } else {
            const version = storeDocumentVersion(this.db, {
              teamId: context.teamId,
              documentId:
                scope.kind === "calendar"
                  ? `calendar:${scope.entryId}`
                  : previous?.document_identity ||
                    readDocumentVersion(this.db, previous?.version_id)
                      ?.documentId ||
                    `${scope.taskId}:${scope.documentId}`,
              markdown: data.markdown,
              actorId: user.id,
            });
            if (scope.kind === "task") {
              const updatedAt = now();
              this.db
                .prepare(
                  `INSERT INTO task_documents(task_id,id,title,version_id,has_content,revision,updated_at,actor_id,operation_id,request_hash) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,id) DO UPDATE SET version_id=excluded.version_id,has_content=excluded.has_content,revision=excluded.revision,updated_at=excluded.updated_at,actor_id=excluded.actor_id,operation_id=excluded.operation_id,request_hash=excluded.request_hash`,
                )
                .run(
                  scope.taskId,
                  scope.documentId,
                  current.title,
                  version,
                  Number(hasDocumentContent(data.markdown)),
                  current.revision + 1,
                  updatedAt,
                  user.id,
                  data.operationId,
                  hash,
                );
              touchTasks(this.db, [context.task]);
              audit(
                this.db,
                user.id,
                context.teamId,
                "document",
                scope.taskId,
                {
                  documentId: scope.documentId,
                  revision: current.revision,
                  bytes: Buffer.byteLength(current.markdown),
                },
                {
                  documentId: scope.documentId,
                  revision: current.revision + 1,
                  bytes: Buffer.byteLength(data.markdown),
                  updatedAt,
                },
              );
              pruneDocumentVersions(this.db, context.teamId);
            } else if (scope.kind === "calendar") {
              const preview = calendarPreview(data.markdown);
              const updatedAt = new Date(
                Math.max(Date.now(), Date.parse(previous.updated_at) + 1),
              ).toISOString();
              this.db
                .prepare(
                  "UPDATE calendar_entries SET version_id=?,preview=?,revision=revision+1,updated_at=?,actor_id=?,operation_id=?,request_hash=? WHERE id=?",
                )
                .run(
                  version,
                  preview,
                  updatedAt,
                  user.id,
                  data.operationId,
                  hash,
                  scope.entryId,
                );
              pruneDocumentVersions(
                this.db,
                context.teamId,
                previous.version_id ? [previous.version_id] : [],
              );
              context.row = context.port.entryAccess(user, scope.entryId);
            } else {
              this.db
                .prepare(
                  `UPDATE ${context.table} SET version_id=?,has_content=?,revision=revision+1,updated_at=?,actor_id=?,operation_id=?,request_hash=? WHERE ${context.where} AND id=?`,
                )
                .run(
                  version,
                  Number(hasDocumentContent(data.markdown)),
                  now(),
                  user.id,
                  data.operationId,
                  hash,
                  ...context.args,
                  scope.documentId,
                );
              this.memoAudit(
                user,
                context,
                "memo",
                scope.documentId,
                { revision: current.revision },
                { year: context.year, revision: current.revision + 1 },
              );
              pruneDocumentVersions(this.db, context.teamId, [
                previous.version_id,
              ]);
            }
          }
        }
        return this.body(context);
      }),
    );
    this.invalidate(context, {
      clientId,
      presence: ["task", "sheetClone"].includes(scope.kind)
        ? presence
        : scope.kind === "calendar" && changed,
    });
    return this.documentEvents
      ? this.documentEvents.publish(documentEventKey(scope), result)
      : result;
  }
  readBatch(user, sheetCloneId, taskIds) {
    const result = [];
    let bytes = 0;
    const base = this.access(
      user,
      {
        kind: "sheetClone",
        sheetCloneId,
        taskId: taskIds[0],
      },
      false,
      { taskIds },
    );
    const tasks = base.tasks;
    requireThat(tasks, 404, "사본에서 해당 업무를 찾지 못했습니다.");
    for (const task of tasks) {
      const context = {
        ...base,
        task,
        scope: { kind: "sheetClone", sheetCloneId, taskId: task.id },
        prefix: ["sheetClone", sheetCloneId, task.id],
      };
      const documents = this.rows(context, { content: true });
      const size = documents.reduce(
        (sum, doc) => sum + Buffer.byteLength(doc.markdown),
        0,
      );
      if (result.length && bytes + size > 8 * 1024 * 1024) break;
      result.push({ id: task.id, documents });
      bytes += size;
    }
    return { tasks: result };
  }
}
