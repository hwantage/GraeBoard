import { z } from "zod";
import { groupValue, propertiesFor } from "../shared/domain.js";
import { requireThat, yearSchema } from "./validation.mjs";
import { getTasks, nextTaskStamp, transaction, audit } from "./db.mjs";

export function installReorderRoute(app, { db, taskAccess, teamAccess }) {
  app.post("/api/tasks/reorder", (req, res) => {
    const destination = {
      targetId: z.string().uuid(),
      year: yearSchema,
      placement: z.enum(["before", "after"]),
      groupBy: z.string().max(80).default(""),
      targetUpdatedAt: z.string(),
    };
    const d = z
      .union([
        z
          .object({
            ...destination,
            tasks: z
              .array(
                z
                  .object({
                    id: z.string().uuid(),
                    updatedAt: z.string(),
                  })
                  .strict(),
              )
              .min(1)
              .max(20000),
          })
          .strict(),
        z
          .object({
            ...destination,
            taskId: z.string().uuid(),
            updatedAt: z.string(),
          })
          .strict(),
      ])
      .parse(req.body);
    const requested =
      "tasks" in d ? d.tasks : [{ id: d.taskId, updatedAt: d.updatedAt }];
    const ids = new Set(requested.map((t) => t.id));
    requireThat(
      ids.size === requested.length,
      400,
      "같은 업무를 중복 선택할 수 없습니다.",
    );
    requireThat(!ids.has(d.targetId), 400, "이동할 행 밖의 위치를 선택하세요.");
    const tasks = transaction(db, () => {
      const sources = requested.map((t) => taskAccess(req.user, t.id, true));
      const target = taskAccess(req.user, d.targetId);
      requireThat(
        sources.every(
          (source) =>
            source.teamId === target.teamId && source.years.includes(d.year),
        ) && target.years.includes(d.year),
        400,
        "같은 팀과 연도의 업무를 선택하세요.",
      );
      requireThat(
        sources.every(
          (source, i) => source.updatedAt === requested[i].updatedAt,
        ) && target.updatedAt === d.targetUpdatedAt,
        409,
        "업무가 변경되었습니다. 새로고침 후 순서를 다시 변경하세요.",
      );
      const settings = teamAccess(req.user, target.teamId).settings;
      requireThat(
        !d.groupBy || propertiesFor(settings).some((p) => p.id === d.groupBy),
        400,
        "유효한 묶음 속성을 선택하세요.",
      );
      requireThat(
        !d.groupBy ||
          sources.every(
            (source) =>
              groupValue(source, d.groupBy) === groupValue(target, d.groupBy),
          ),
        400,
        "묶음 보기에서는 같은 묶음 안에서만 이동할 수 있습니다.",
      );
      let all = getTasks(db, target.teamId, d.year).sort(
        (a, b) =>
          a.position - b.position ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
      // Always preserve the board's order, even when another selected handle
      // starts the drag or the client sends the IDs in a different order.
      let moving = all.filter((t) => ids.has(t.id));
      const neighbors = () => {
        const rows = all.filter(
          (t) =>
            !ids.has(t.id) &&
            (!d.groupBy ||
              groupValue(t, d.groupBy) === groupValue(target, d.groupBy)),
        );
        const index =
          rows.findIndex((t) => t.id === target.id) +
          (d.placement === "after" ? 1 : 0);
        return [rows[index - 1], rows[index]];
      };
      let [before, after] = neighbors();
      if (
        before &&
        after &&
        (after.position - before.position) / (moving.length + 1) < 0.000001
      ) {
        const put = db.prepare(
          "UPDATE tasks SET position=?,updated_at=? WHERE id=?",
        );
        all.forEach((t, i) =>
          put.run((i + 1) * 1000, nextTaskStamp(t.updatedAt), t.id),
        );
        all = getTasks(db, target.teamId, d.year);
        moving = all.filter((t) => ids.has(t.id));
        [before, after] = neighbors();
      }
      const step =
        before && after
          ? (after.position - before.position) / (moving.length + 1)
          : 100;
      const start = before
        ? before.position
        : after.position - step * (moving.length + 1);
      const put = db.prepare(
        "UPDATE tasks SET position=?,updated_at=? WHERE id=?",
      );
      return moving.map((source, i) => {
        const position = start + step * (i + 1),
          updatedAt = nextTaskStamp(source.updatedAt);
        put.run(position, updatedAt, source.id);
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
        return { ...source, position, updatedAt };
      });
    });
    res.json({ task: tasks[0], tasks });
  });
}
