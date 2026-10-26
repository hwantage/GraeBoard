import { z } from "zod";
import {
  changeSchema,
  copiedRowSchema,
  formatSchema,
  styleSchema,
  viewSchema,
} from "../validation.mjs";
const ids = z.array(z.string().uuid()).min(1).max(20000);
const base = { at: z.iso.datetime() };
const restoreTaskSchema = z
  .object({
    id: z.string().uuid(),
    teamId: z.string().uuid(),
    years: z.array(z.number().int().min(2000).max(2100)).max(101),
    position: z.number().finite(),
    createdBy: z.string().uuid(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deletedAt: z.string().nullable().optional(),
    cells: z.record(
      z.string().max(80),
      z
        .object({
          value: changeSchema.shape.value.unwrap(),
          style: styleSchema,
          version: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    defaultStyle: styleSchema.optional(),
    rowStyle: styleSchema.optional(),
    hasDocument: z.boolean().optional(),
    documentCount: z.number().int().nonnegative().optional(),
    documents: copiedRowSchema.shape.documents,
    formatting: z
      .object({
        revision: z.number().int().nonnegative(),
        rules: z
          .array(
            z
              .object({
                id: z.string().max(100),
                rows: z.array(z.string().uuid()).max(20000).nullable(),
                keys: z.array(z.string().max(80)).max(1000).nullable(),
                excludeKeys: z.array(z.string().max(80)).max(1000).optional(),
                style: styleSchema,
                orders: z.record(
                  z.string().max(30),
                  z.number().int().nonnegative(),
                ),
              })
              .strict(),
          )
          .max(10000),
      })
      .strict()
      .optional(),
  })
  .strict();
export const editSchema = z
  .object({
    operationId: z.string().uuid(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    view: viewSchema.optional(),
    operations: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              ...base,
              kind: z.literal("restore"),
              removeIds: z.array(z.string().uuid()).max(20000).optional(),
              tasks: z
                .array(restoreTaskSchema)
                .max(20000)
                .refine(
                  (tasks) =>
                    new Set(tasks.map((task) => task.id)).size === tasks.length,
                ),
            })
            .strict(),
          z
            .object({
              ...base,
              kind: z.literal("cells"),
              changes: z.array(changeSchema).min(1).max(200000),
            })
            .strict(),
          z
            .object({
              ...base,
              kind: z.literal("format"),
              id: z.string().uuid(),
              scopes: formatSchema.shape.scopes.unwrap(),
            })
            .strict(),
          z
            .object({
              ...base,
              kind: z.literal("create"),
              taskId: z.string().uuid(),
              sourceId: z.string().uuid().optional(),
              copiedRow: copiedRowSchema.optional(),
              fields: z
                .record(z.string().max(80), changeSchema.shape.value.unwrap())
                .default({}),
              insertAt: z
                .object({
                  taskId: z.string().uuid(),
                  placement: z.enum(["before", "after"]),
                })
                .strict()
                .optional(),
            })
            .strict(),
          z
            .object({ ...base, kind: z.literal("delete"), taskIds: ids })
            .strict(),
          z
            .object({
              ...base,
              kind: z.literal("reorder"),
              taskIds: ids,
              targetId: z.string().uuid(),
              placement: z.enum(["before", "after"]),
            })
            .strict(),
        ]),
      )
      .max(1000),
  })
  .strict();
