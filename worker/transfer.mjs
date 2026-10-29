import {
  TRANSFER_ROUTES,
  matchBusinessRoute,
  callBusinessRoute,
} from "../shared/business-routes.js";
import { TransferBusinessService } from "../server/storage/transfer-service.mjs";
import { PostgresTransferRepository } from "./storage/postgres-transfer.mjs";
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
  const match = matchBusinessRoute(TRANSFER_ROUTES, path, method);
  if (!match) return undefined;
  const service = new TransferBusinessService(
    new PostgresTransferRepository({ context: ctx }),
    ctx.user,
  );
  if (match.route.name === "preview") {
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
  return response(
    await callBusinessRoute(service, match.route, {
      params: match.params,
      body,
    }),
  );
}
