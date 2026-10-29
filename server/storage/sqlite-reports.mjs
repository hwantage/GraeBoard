import { z } from "zod";
import { createHash } from "node:crypto";
import { id, now, transaction, getTasks, audit, parse } from "../db.mjs";
import { canContribute, periodYears } from "../../shared/domain.js";
import {
  requireThat,
  yearSchema,
  reportNameSchema,
  dateSchema,
  viewSchema,
} from "../../shared/validation.js";
import {
  withTaskDocumentReferences,
  syncReportDocuments,
  pruneDocumentVersions,
  readReport,
} from "../document-storage.mjs";
import { copyReportMemos } from "../memo-storage.mjs";
import { encodeReport, requireUniqueReportName } from "../reports.mjs";
import { reportResponse, editReport } from "../report-editing.mjs";
import { retentionView } from "../sync/visibility.mjs";

export class SqliteReportRepository {
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
  watchRevision(user, reportId) {
    const row = this.db
      .prepare("SELECT team_id FROM reports WHERE id=?")
      .get(reportId);
    requireThat(row, 404, "사본을 찾을 수 없습니다.");
    this.teamAccess(user, row.team_id);
    retentionView(this.db, row.team_id).requireVisible("report", [reportId]);
  }
  afterCommit(user, command, args, result, { clientId } = {}) {
    const reportId =
      command === "create" ? result.id : command === "remove" ? null : args[0];
    const teamId =
      command === "create" || command === "remove"
        ? args[0].teamId
        : this.db
            .prepare("SELECT team_id FROM reports WHERE id=?")
            .get(reportId)?.team_id;
    if (teamId) this.documentEvents?.invalidate("team:" + teamId, clientId);
    for (const id of command === "remove"
      ? args[0].ids
      : reportId
        ? [reportId]
        : [])
      this.documentEvents?.invalidate("report:" + id, clientId);
  }
  list(user, query) {
    const { db, teamAccess, referencedUsers } = this;

    const teamId = String(query.teamId);
    teamAccess(user, teamId);
    const view = retentionView(db, teamId);
    return {
      reports: db
        .prepare(
          "SELECT r.id,r.name,r.year,r.reference_date AS referenceDate,r.created_at AS createdAt,u.name AS author FROM reports r JOIN users u ON r.created_by=u.id WHERE r.team_id=? ORDER BY r.created_at DESC",
        )
        .all(teamId)
        .filter((row) => !view.hidden("report", [row.id])),
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
        name: reportNameSchema,
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
    if (d.sourceId) localView.requireVisible("report", [d.sourceId]);
    requireThat(
      canContribute(user, d.teamId),
      403,
      "사본을 만들 권한이 없습니다.",
    );
    const reportId = d.id || id();
    const requestHash = createHash("sha256")
      .update(JSON.stringify(d))
      .digest("hex");
    const replay = () => {
      const existing = db
        .prepare("SELECT * FROM reports WHERE id=?")
        .get(reportId);
      if (existing) {
        const last = db
          .prepare(
            "SELECT after_json FROM audit WHERE action='report' AND target=? AND actor_id=?",
          )
          .get(reportId, user.id);
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
    if (replay()) return { id: reportId };
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
      requireUniqueReportName(db, d.teamId, d.name);
      const source = d.sourceId
        ? db
            .prepare("SELECT * FROM reports WHERE id=? AND team_id=?")
            .get(d.sourceId, d.teamId)
        : null;
      requireThat(!d.sourceId || source, 404, "사본을 찾을 수 없습니다.");
      const data = source
        ? readReport(db, source)
        : {
            tasks: withTaskDocumentReferences(db, tasks),
            users: referencedUsers(d.teamId),
            view: d.view,
            settings: team.settings,
          };
      const visibility = retentionView(db, d.teamId);
      data.tasks = visibility.tasks(data.tasks, source?.id);
      db.prepare("INSERT INTO reports VALUES(?,?,?,?,?,?,?,?)").run(
        reportId,
        d.teamId,
        source ? source.year : d.year,
        d.name,
        d.referenceDate,
        user.id,
        now(),
        encodeReport(data),
      );
      syncReportDocuments(db, reportId, data.tasks);
      copyReportMemos(db, {
        reportId,
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
                    ? ["reportMemo", source.id, documentId]
                    : ["annual", String(d.year), documentId],
                ),
            }
          : {}),
      });
      audit(db, user.id, d.teamId, "report", reportId, undefined, {
        name: d.name,
        count: data.tasks.length,
        requestHash,
      });
    });
    return { id: reportId };
  }
  rename(user, reportId, input) {
    const { db, teamAccess, referencedUsers } = this;

    const data = z
      .object({ name: reportNameSchema, expectedName: z.string().max(120) })
      .strict()
      .parse(input);
    return transaction(db, () => {
      const row = db.prepare("SELECT * FROM reports WHERE id=?").get(reportId);
      requireThat(row, 404, "사본을 찾을 수 없습니다.");
      teamAccess(user, row.team_id);
      retentionView(db, row.team_id).requireVisible("report", [reportId]);
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
        requireUniqueReportName(db, row.team_id, data.name);
      db.prepare("UPDATE reports SET name=? WHERE id=?").run(data.name, row.id);
      audit(
        db,
        user.id,
        row.team_id,
        "report-rename",
        row.id,
        { name: row.name },
        { name: data.name },
      );
      return { id: row.id, name: data.name };
    });
  }
  read(user, reportId) {
    const { db, teamAccess, referencedUsers } = this;

    const r = db.prepare("SELECT * FROM reports WHERE id=?").get(reportId);
    requireThat(r, 404, "사본을 찾을 수 없습니다.");
    teamAccess(user, r.team_id);
    const view = retentionView(db, r.team_id);
    view.requireVisible("report", [reportId]);
    const response = reportResponse(db, r);
    return { ...response, tasks: view.tasks(response.tasks, reportId) };
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
    ids.forEach((id) => visibility.requireVisible("report", [id]));
    transaction(db, () => {
      const rows = db
        .prepare(
          `SELECT id,name,reference_date AS referenceDate FROM reports WHERE team_id=? AND id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(d.teamId, ...ids);
      requireThat(
        rows.length === ids.length,
        404,
        "일부 사본을 찾을 수 없습니다. 목록을 새로 열어 확인하세요.",
      );
      const remove = db.prepare("DELETE FROM reports WHERE id=? AND team_id=?");
      for (const row of rows) {
        remove.run(row.id, d.teamId);
        audit(db, user.id, d.teamId, "report-delete", row.id, {
          name: row.name,
          referenceDate: row.referenceDate,
        });
      }
      pruneDocumentVersions(db, d.teamId);
    });
    return { ok: true };
  }
  edit(user, reportId, input) {
    const row = this.db
      .prepare("SELECT team_id FROM reports WHERE id=?")
      .get(reportId);
    requireThat(row, 404, "사본을 찾을 수 없습니다.");
    this.teamAccess(user, row.team_id);
    retentionView(this.db, row.team_id).requireVisible("report", [reportId]);
    return editReport(this, user, reportId, input);
  }
}
