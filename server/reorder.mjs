import { z } from "zod";
import { groupValue, propertiesFor } from "../shared/domain.js";
import { requireThat, yearSchema } from "./validation.mjs";
import { getTasks, getTask, nextTaskStamp, transaction, audit } from "./db.mjs";

export function installReorderRoute(app, { db, taskAccess, teamAccess }) {
  app.post("/api/tasks/reorder", (req, res) => {
    const d = z
      .object({
        taskId: z.string().uuid(),
        targetId: z.string().uuid(),
        year: yearSchema,
        placement: z.enum(["before", "after"]),
        groupBy: z.string().max(80).default(""),
        updatedAt: z.string(),
        targetUpdatedAt: z.string(),
      })
      .strict()
      .parse(req.body);
    const task = transaction(db, () => {
      const source = taskAccess(req.user, d.taskId, true),
        target = taskAccess(req.user, d.targetId);
      requireThat(
        source.id !== target.id &&
          source.teamId === target.teamId &&
          source.years.includes(d.year) &&
          target.years.includes(d.year),
        400,
        "같은 팀과 연도의 업무를 선택하세요.",
      );
      requireThat(
        source.updatedAt === d.updatedAt &&
          target.updatedAt === d.targetUpdatedAt,
        409,
        "업무가 변경되었습니다. 새로고침 후 순서를 다시 변경하세요.",
      );
      const settings = teamAccess(req.user, source.teamId).settings;
      requireThat(
        !d.groupBy || propertiesFor(settings).some((p) => p.id === d.groupBy),
        400,
        "유효한 묶음 속성을 선택하세요.",
      );
      requireThat(
        !d.groupBy ||
          groupValue(source, d.groupBy) === groupValue(target, d.groupBy),
        400,
        "묶음 보기에서는 같은 묶음 안에서만 이동할 수 있습니다.",
      );
      let all = getTasks(db, source.teamId, d.year);
      const neighbors = () => {
        const rows = all.filter(
          (t) =>
            t.id !== source.id &&
            (!d.groupBy ||
              groupValue(t, d.groupBy) === groupValue(source, d.groupBy)),
        );
        const index =
          rows.findIndex((t) => t.id === target.id) +
          (d.placement === "after" ? 1 : 0);
        return [rows[index - 1], rows[index]];
      };
      let [before, after] = neighbors();
      if (before && after && after.position - before.position < 0.000001) {
        const put = db.prepare(
          "UPDATE tasks SET position=?,updated_at=? WHERE id=?",
        );
        all.forEach((t, i) =>
          put.run((i + 1) * 1000, nextTaskStamp(t.updatedAt), t.id),
        );
        all = getTasks(db, source.teamId, d.year);
        [before, after] = neighbors();
      }
      const position =
        before && after
          ? (before.position + after.position) / 2
          : before
            ? before.position + 100
            : after.position - 100;
      db.prepare("UPDATE tasks SET position=?,updated_at=? WHERE id=?").run(
        position,
        nextTaskStamp(getTask(db, source.id).updatedAt),
        source.id,
      );
      const result = getTask(db, source.id);
      audit(
        db,
        req.user.id,
        source.teamId,
        "reorder",
        source.id,
        { position: source.position },
        {
          position,
          targetId: target.id,
          placement: d.placement,
          groupBy: d.groupBy,
        },
      );
      return result;
    });
    res.json({ task });
  });
}
