import { TransferBusinessService } from "../server/storage/transfer-service.mjs";
import { PostgresTransferRepository } from "../server/storage/postgres-transfer.mjs";
const response = (value) =>
  value?.contentType
    ? new Response(value.body, {
        headers: {
          "Content-Type": value.contentType,
          "Content-Disposition": `attachment; filename="${value.filename}"`,
          "Cache-Control": "no-store",
        },
      })
    : value;
export async function transferRoutes(ctx, path, method, body) {
  if (method !== "POST") return undefined;
  const service = new TransferBusinessService(
    new PostgresTransferRepository({ context: ctx }),
    ctx.user,
  );
  if (path === "/export") return response(await service.export(body));
  if (path === "/import/preview") {
    const form = await ctx.request.formData(),
      file = form.get("file");
    return service.preview({
      teamId: form.get("teamId"),
      year: form.get("year"),
      ...(form.get("reportId") ? { reportId: form.get("reportId") } : {}),
      sheetOptions: form.get("sheetOptions") || {},
      file:
        file && typeof file.arrayBuffer === "function"
          ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
          : undefined,
    });
  }
  const item = /^\/import\/([^/]+)\/(exceptions|apply)$/.exec(path);
  if (item)
    return response(
      await (item[2] === "exceptions"
        ? service.exceptions(item[1])
        : service.apply(item[1], body)),
    );
  return undefined;
}
