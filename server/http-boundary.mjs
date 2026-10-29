import express from "express";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { pack, unpack } from "../shared/compact.js";
import { now } from "./db.mjs";
import { HttpError } from "../shared/validation.js";
import {
  isSyncRequest,
  syncErrorMessage,
} from "../shared/sync-error-message.js";

export function installHttpBoundary(app) {
  app.disable("x-powered-by");
  if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          fontSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(
    compression({
      filter: (req, res) =>
        !req.path.endsWith("/events") && compression.filter(req, res),
    }),
  );
  app.use(cookieParser());
  app.use((req, res, next) => {
    const respond = res.json.bind(res);
    res.json = (data) => {
      res.set("X-Server-Time", now());
      return respond(pack(data));
    };
    next();
  });
  app.use("/api/cells/batch", express.json({ limit: "32mb" }));
  app.use("/api/reports", express.json({ limit: "32mb" }));
  app.use(express.json({ limit: "5mb" }));
  app.use((req, res, next) => {
    try {
      req.body = unpack(req.body, { maxStyles: 50001 });
      next();
    } catch (error) {
      next(new HttpError(400, error.message));
    }
  });
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (req.get("X-Requested-With") !== "WeeklyPlan")
        return res
          .status(403)
          .json({ error: "요청 출처를 확인할 수 없습니다." });
      const origin = req.get("Origin");
      if (origin && !URL.canParse(origin))
        return res.status(403).json({ error: "허용되지 않은 출처입니다." });
      if (
        origin &&
        new URL(origin).host !== req.get("Host") &&
        origin !== process.env.APP_ORIGIN
      )
        return res.status(403).json({ error: "허용되지 않은 출처입니다." });
      if (req.get("Sec-Fetch-Site") === "cross-site")
        return res
          .status(403)
          .json({ error: "외부 사이트의 요청은 허용되지 않습니다." });
    }
    next();
  });
}

export function installHttpFallback(app, { staticDir }) {
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "요청한 API를 찾을 수 없습니다." }),
  );
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir, { maxAge: 0 }));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(resolve(staticDir, "index.html")),
    );
  }
  app.use((err, req, res, _next) => {
    // Changing worker subscriptions cancels the previous read-only POST,
    // sometimes before its JSON body has finished arriving.
    if (req.path === "/api/events" && err.type === "request.aborted") return;
    if (err.type === "entity.parse.failed")
      return res.status(400).json({ error: "JSON 입력 형식을 확인하세요." });
    if (err instanceof z.ZodError)
      return res.status(400).json({
        // 직접 정의한 검증 문구가 있으면 그대로 보여 준다.
        error:
          err.issues.find((i) => i.code === "custom")?.message ||
          "입력값을 확인하세요.",
        details: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    if (process.env.DEBUG_HTTP)
      console.error(
        "DEBUG_HTTP",
        req.method,
        req.path,
        err.message,
        JSON.stringify(err.issues?.slice(0, 3) ?? err.details ?? null),
      );
    const syncMessage = isSyncRequest(req.path) && syncErrorMessage(err);
    if (syncMessage) {
      console.error(`[${now()}] ${req.method} ${req.path}:`, err.message);
      return res.status(err.status || 500).json({ error: syncMessage });
    }
    if (err instanceof HttpError)
      return res
        .status(err.status)
        .json({ error: err.message, details: err.details });
    if (err.code === "LIMIT_FILE_SIZE")
      return res
        .status(413)
        .json({ error: "파일은 25MB까지 가져올 수 있습니다." });
    if (err.type === "entity.too.large")
      return res.status(413).json({
        error: "요청 크기가 너무 큽니다. 범위를 줄여 다시 시도하세요.",
      });
    console.error(`[${now()}] ${req.method} ${req.path}:`, err.message);
    res.status(500).json({
      error: "서버에서 처리하지 못했습니다. 입력을 보존한 뒤 다시 시도하세요.",
    });
  });
}
