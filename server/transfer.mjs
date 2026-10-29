import { TRANSFER_ROUTES } from "../shared/business-routes.js";
import { TransferBusinessService } from "./storage/transfer-service.mjs";
import { SqliteTransferRepository } from "./storage/sqlite-transfer.mjs";
import multer from "multer";

export function installTransferRoutes(app, options) {
  const repository = new SqliteTransferRepository({
    ...options,
    documentEvents: app.locals.documentEvents,
  });
  app.locals.transferRepository = repository;
  const service = (req) =>
    new TransferBusinessService(repository, req.user, {
      clientId: req.get("X-Client-ID")?.slice(0, 64),
    });
  const send = (result, res, next) => {
    const complete = (value) =>
      value?.contentType
        ? res
            .attachment(value.filename)
            .type(value.contentType)
            .send(
              value.body instanceof Uint8Array
                ? Buffer.from(value.body)
                : value.body,
            )
        : res.json(value);
    return complete(result);
  };
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });
  const path = (name) =>
    "/api" + TRANSFER_ROUTES.find((route) => route.name === name).path;
  app.post(path("export"), async (req, res, next) =>
    send(await service(req).export(req.body), res, next),
  );
  app.post(path("preview"), upload.single("file"), async (req, res, next) =>
    send(
      await service(req).preview({
        ...req.body,
        file: req.file && {
          name: req.file.originalname,
          bytes: req.file.buffer,
        },
      }),
      res,
      next,
    ),
  );
  app.post(path("exceptions"), (req, res, next) =>
    send(service(req).exceptions(req.params.id), res, next),
  );
  app.post(path("apply"), (req, res, next) =>
    send(service(req).apply(req.params.id, req.body), res, next),
  );
}
