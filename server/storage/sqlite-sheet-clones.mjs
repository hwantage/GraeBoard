import { z } from "zod";
import { createHash } from "node:crypto";
import { id, now, transaction, getTasks, audit, parse } from "../db.mjs";
import { canContribute, periodYears } from "../../shared/domain.js";
import {
  requireThat,
  yearSchema,
  sheetCloneNameSchema,
  dateSchema,
  viewSchema,
} from "../../shared/validation.js";
import {
  withTaskDocumentReferences,
  syncSheetCloneDocuments,
  pruneDocumentVersions,
  readSheetClone,
} from "../documents/document-storage.mjs";
import { copySheetCloneMemos } from "../documents/memo-storage.mjs";
import {
  encodeSheetClone,
  requireUniqueSheetCloneName,
} from "../sheet-clones.mjs";
import { sheetCloneResponse, editSheetClone } from "../sheet-clone-editing.mjs";
import { retentionView } from "../sync/visibility.mjs";

export class SqliteSheetCloneRepository {
  constructor({
    db,
    teamAccess,
    referencedUsers,
    documentImagesDir,
    documentEvents,
  }) {
    Object.assign(this, {
      db,
      teamAccess,
      referencedUsers,
      documentImagesDir,
      documentEvents,
    });
  }
  watchRevision(user, sheetCloneId) {
    const row = this.db
      .prepare("SELECT team_id FROM sheet_clones WHERE id=?")
      .get(sheetCloneId);
    requireThat(row, 404, "사본을 찾을 수 없습니다.");
    this.teamAccess(user, row.team_id);
    retentionView(this.db, row.team_id).requireVisible("sheetClone", [
      sheetCloneId,
    ]);
  }
  afterCommit(user, command, args, result, { clientId } = {}) {
    const sheetCloneId =
      command === "create" ? result.id : command === "remove" ? null : args[0];
    const teamId =
      command === "create" || command === "remove"
        ? args[0].teamId
        : this.db
            .prepare("SELECT team_id FROM sheet_clones WHERE id=?")
            .get(sheetCloneId)?.team_id;
    if (teamId) this.documentEvents?.invalidate("team:" + teamId, clientId);
    for (const id of command === "remove"
      ? args[0].ids
      : sheetCloneId
        ? [sheetCloneId]
        : [])
      this.documentEvents?.invalidate("sheet-clone:" + id, clientId);
  }
  list(user, query) {
    const { db, teamAccess, referencedUsers } = this;

    const teamId = String(query.teamId);
    teamAccess(user, teamId);
    const view = retentionView(db, teamId);
    return {
      sheetClones: db
        .prepare(
          "SELECT r.id,r.name,r.year,r.reference_date AS referenceDate,r.created_at AS createdAt,u.name AS author FROM sheet_clones r JOIN users u ON r.created_by=u.id WHERE r.team_id=? ORDER BY r.created_at DESC",
        )
        .all(teamId)
        .filter((row) => !view.hidden("sheetClone", [row.id])),
    };
  }
  authorizeCreate(user, request) {
    this.teamAccess(user, request.teamId);
    requireThat(
      canContribute(user, request.teamId),
      403,
      "사본을 만들 권한이 없습니다.",
    );
  }
  create(user, input) {
    const { db, teamAccess, referencedUsers } = this;

    const d = z
      .object({
        id: z.string().uuid().optional(),
        teamId: z.string().uuid(),
        year: yearSchema,
        name: sheetCloneNameSchema,
        sourceId: z.string().uuid().optional(),
        referenceDate: dateSchema,
        view: viewSchema,
        taskIds: z.array(z.string().uuid()).max(20000),
      })
      .parse(input);
    const team = teamAccess(user, d.teamId);
    const localView = retentionView(db, d.teamId);
    requireThat(
      !localView.years.has(String(d.year)),
      409,
      "이 사이트에서 정리한 연도입니다. 설정에서 복원한 뒤 사용하세요.",
    );
    if (d.sourceId) localView.requireVisible("sheetClone", [d.sourceId]);
    requireThat(
      canContribute(user, d.teamId),
      403,
      "사본을 만들 권한이 없습니다.",
    );
    const sheetCloneId = d.id || id();
    const requestHash = createHash("sha256")
      .update(JSON.stringify(d))
      .digest("hex");
    const replay = () => {
      const existing = db
        .prepare("SELECT * FROM sheet_clones WHERE id=?")
        .get(sheetCloneId);
      if (existing) {
        const last = db
          .prepare(
            "SELECT after_json FROM audit WHERE action='sheet-clone' AND target=? AND actor_id=?",
          )
          .get(sheetCloneId, user.id);
        requireThat(
          existing.team_id === d.teamId &&
            existing.created_by === user.id &&
            parse(last?.after_json)?.requestHash === requestHash,
          409,
          "사본 생성 요청이 변경되었습니다. 새 이름으로 다시 시도하세요.",
        );
        return true;
      }
      return false;
    };
    if (replay()) return { id: sheetCloneId };
    requireThat(
      d.view.year === d.year,
      400,
      "보고 연도와 보기의 연도가 일치해야 합니다.",
    );
    const selected = new Set(d.sourceId ? [] : d.taskIds),
      tasks = selected.size
        ? getTasks(db, d.teamId, periodYears(d.year, d.view.startMonth)).filter(
            (t) => selected.has(t.id),
          )
        : [];
    requireThat(
      tasks.length === selected.size,
      409,
      "일부 업무가 변경 또는 삭제되었습니다. 새로고침 후 다시 저장하세요.",
    );
    transaction(db, () => {
      if (replay()) return;
      requireUniqueSheetCloneName(db, d.teamId, d.name);
      const source = d.sourceId
        ? db
            .prepare("SELECT * FROM sheet_clones WHERE id=? AND team_id=?")
            .get(d.sourceId, d.teamId)
        : null;
      requireThat(!d.sourceId || source, 404, "사본을 찾을 수 없습니다.");
      const data = source
        ? readSheetClone(db, source)
        : {
            tasks: withTaskDocumentReferences(db, tasks),
            users: referencedUsers(d.teamId),
            view: d.view,
            settings: team.settings,
          };
      const visibility = retentionView(db, d.teamId);
      data.tasks = visibility.tasks(data.tasks, source?.id);
      db.prepare("INSERT INTO sheet_clones VALUES(?,?,?,?,?,?,?,?)").run(
        sheetCloneId,
        d.teamId,
        source ? source.year : d.year,
        d.name,
        d.referenceDate,
        user.id,
        now(),
        encodeSheetClone(data),
      );
      syncSheetCloneDocuments(db, sheetCloneId, data.tasks);
      copySheetCloneMemos(db, {
        sheetCloneId,
        sourceId: source?.id,
        teamId: d.teamId,
        year: d.year,
        actorId: user.id,
        ...(visibility.active
          ? {
              visibleDocument: (documentId) =>
                !visibility.hidden(
                  "document",
                  source
                    ? ["sheetCloneMemo", source.id, documentId]
                    : ["annual", String(d.year), documentId],
                ),
            }
          : {}),
      });
      audit(db, user.id, d.teamId, "sheet-clone", sheetCloneId, undefined, {
        name: d.name,
        count: data.tasks.length,
        requestHash,
      });
    });
    return { id: sheetCloneId };
  }
  rename(user, sheetCloneId, input) {
    const { db, teamAccess, referencedUsers } = this;

    const data = z
      .object({ name: sheetCloneNameSchema, expectedName: z.string().max(120) })
      .strict()
      .parse(input);
    return transaction(db, () => {
      const row = db
        .prepare("SELECT * FROM sheet_clones WHERE id=?")
        .get(sheetCloneId);
      requireThat(row, 404, "사본을 찾을 수 없습니다.");
      teamAccess(user, row.team_id);
      retentionView(db, row.team_id).requireVisible("sheetClone", [
        sheetCloneId,
      ]);
      requireThat(
        canContribute(user, row.team_id),
        403,
        "사본 이름을 바꿀 권한이 없습니다.",
      );
      requireThat(
        row.name === data.expectedName || row.name === data.name,
        409,
        "사본 이름이 변경되었습니다. 목록을 다시 불러오세요.",
      );
      if (row.name !== data.name)
        requireUniqueSheetCloneName(db, row.team_id, data.name, row.id);
      db.prepare("UPDATE sheet_clones SET name=? WHERE id=?").run(
        data.name,
        row.id,
      );
      audit(
        db,
        user.id,
        row.team_id,
        "sheet-clone-rename",
        row.id,
        { name: row.name },
        { name: data.name },
      );
      return { id: row.id, name: data.name };
    });
  }
  read(user, sheetCloneId) {
    const { db, teamAccess, referencedUsers } = this;

    const r = db
      .prepare("SELECT * FROM sheet_clones WHERE id=?")
      .get(sheetCloneId);
    requireThat(r, 404, "사본을 찾을 수 없습니다.");
    teamAccess(user, r.team_id);
    const view = retentionView(db, r.team_id);
    view.requireVisible("sheetClone", [sheetCloneId]);
    const response = sheetCloneResponse(db, r);
    return { ...response, tasks: view.tasks(response.tasks, sheetCloneId) };
  }
  remove(user, input) {
    const { db, teamAccess, referencedUsers } = this;

    const d = z
      .object({
        teamId: z.string().uuid(),
        ids: z.array(z.string().uuid()).min(1).max(20000),
      })
      .strict()
      .parse(input);
    teamAccess(user, d.teamId);
    requireThat(
      canContribute(user, d.teamId),
      403,
      "사본을 삭제할 권한이 없습니다.",
    );
    const ids = [...new Set(d.ids)];
    const visibility = retentionView(db, d.teamId);
    ids.forEach((id) => visibility.requireVisible("sheetClone", [id]));
    transaction(db, () => {
      const rows = db
        .prepare(
          `SELECT id,name,reference_date AS referenceDate FROM sheet_clones WHERE team_id=? AND id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(d.teamId, ...ids);
      requireThat(
        rows.length === ids.length,
        404,
        "일부 사본을 찾을 수 없습니다. 목록을 새로 열어 확인하세요.",
      );
      const remove = db.prepare(
        "DELETE FROM sheet_clones WHERE id=? AND team_id=?",
      );
      for (const row of rows) {
        remove.run(row.id, d.teamId);
        audit(db, user.id, d.teamId, "sheet-clone-delete", row.id, {
          name: row.name,
          referenceDate: row.referenceDate,
        });
      }
      pruneDocumentVersions(db, d.teamId);
    });
    return { ok: true };
  }
  edit(user, sheetCloneId, input) {
    const row = this.db
      .prepare("SELECT team_id FROM sheet_clones WHERE id=?")
      .get(sheetCloneId);
    requireThat(row, 404, "사본을 찾을 수 없습니다.");
    this.teamAccess(user, row.team_id);
    retentionView(this.db, row.team_id).requireVisible("sheetClone", [
      sheetCloneId,
    ]);
    return editSheetClone(this, user, sheetCloneId, input);
  }
}
