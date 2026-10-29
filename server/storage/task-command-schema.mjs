import { z } from "zod";
import {
  yearSchema,
  copiedRowSchema,
  viewSchema,
} from "../../shared/validation.js";
export const createTaskSchema = z
  .object({
    teamId: z.string().uuid(),
    year: yearSchema,
    startMonth: z.number().int().min(1).max(12).default(1),
    fields: z.record(z.string(), z.any()).default({}),
    sourceId: z.string().uuid().optional(),
    copiedRow: copiedRowSchema.optional(),
    insertAt: z
      .object({
        taskId: z.string().uuid(),
        updatedAt: z.string(),
        placement: z.enum(["before", "after"]),
      })
      .strict()
      .optional(),
  })
  .refine((d) => !d.sourceId || !d.copiedRow, "복사할 행을 확인하세요.");
export const updateTaskSchema = z.object({
  updatedAt: z.string(),
  years: z.array(yearSchema).min(1).max(101).optional(),
  position: z.number().finite().optional(),
});
export const taskVersionsSchema = z.object({
  tasks: z
    .array(
      z.object({
        id: z.string().uuid(),
        updatedAt: z.string().datetime(),
      }),
    )
    .min(1)
    .max(20000)
    .refine((tasks) => new Set(tasks.map((t) => t.id)).size === tasks.length),
});
export const saveViewSchema = z.object({
  teamId: z.string().uuid(),
  name: z.literal("__current"),
  data: viewSchema,
});
const destination = {
  targetId: z.string().uuid(),
  year: yearSchema,
  startMonth: z.number().int().min(1).max(12).default(1),
  placement: z.enum(["before", "after"]),
  groupBy: z.string().max(80).default(""),
  targetUpdatedAt: z.string(),
};
export const reorderTaskSchema = z.union([
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
]);
