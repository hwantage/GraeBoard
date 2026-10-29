import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { documentImageUrls } from "../shared/document-image-references.js";
import { MAX_DOCUMENT_BYTES } from "../shared/task-documents.js";
import { HttpError } from "../shared/validation.js";

const prefix = "/api/document-images/";
const unavailable = (reason) =>
  Object.assign(
    new HttpError(
      503,
      "문서 이미지 확인을 완료하지 못했습니다. 입력을 보존하고 잠시 후 다시 시도하세요.",
    ),
    { code: "DOCUMENT_IMAGE_PREPARATION_" + reason },
  );
const hash = (text) => createHash("sha256").update(text).digest("hex");
const resultFor = (items, urls) =>
  Object.freeze(
    items.map(({ markdown }, index) =>
      Object.freeze({ markdown, urls: Object.freeze([...urls[index]]) }),
    ),
  );

export function createDocumentImagePreparation({
  workerUrl = new URL("./document-image-worker.mjs", import.meta.url),
  timeoutMs = 30000,
  maxPending = 32,
  maxBytes = 16 * 1024 * 1024,
} = {}) {
  for (const value of [timeoutMs, maxPending, maxBytes])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(
        "Document image preparation limits must be positive integers",
      );
  const queue = [];
  let generation = null,
    active = null,
    retiring = null,
    closePromise = null,
    closed = false,
    inputBytes = 0,
    workerStarts = 0;
  const rejectAll = (error) => {
    const jobs = active ? [active, ...queue] : [...queue];
    active = null;
    queue.length = 0;
    inputBytes = 0;
    for (const job of jobs) {
      clearTimeout(job.timer);
      job.reject(error);
    }
  };
  const fallback = (items) =>
    resultFor(
      items,
      items.map(({ markdown }) => documentImageUrls(markdown)),
    );
  const completeFallback = (job) => {
    if (!job) return;
    if (active === job) active = null;
    else {
      const index = queue.indexOf(job);
      if (index < 0) return;
      queue.splice(index, 1);
    }
    clearTimeout(job.timer);
    inputBytes -= job.bytes;
    try {
      job.resolve(fallback(job.items));
    } catch (error) {
      job.reject(error);
    }
  };
  const retire = (current, error) => {
    if (current && generation !== current) return retiring || Promise.resolve();
    generation = null;
    if (closed) rejectAll(error);
    else completeFallback(active);
    if (current) {
      current.stopping = true;
      // terminate() resolves after exit. A replacement may start only after it
      // settles, including when another request arrives during termination.
      const termination = current.exited
        ? Promise.resolve()
        : current.worker.terminate();
      retiring = Promise.resolve(termination)
        .catch(() => {
          // Never spawn a replacement if termination could not be confirmed.
          closed = true;
          rejectAll(unavailable("TERMINATION"));
        })
        .then(() => {
          retiring = null;
          pump();
        });
    }
    return retiring || Promise.resolve();
  };
  const receive = (current, message) => {
    if (generation !== current || current.stopping) return;
    const job = active;
    try {
      if (
        !job ||
        !message ||
        Object.keys(message).sort().join(",") !== "hashes,id,urls" ||
        message.id !== job.id ||
        !Array.isArray(message.hashes) ||
        !Array.isArray(message.urls) ||
        message.hashes.length !== job.items.length ||
        message.urls.length !== job.items.length
      )
        throw new Error("Invalid response envelope");
      for (let i = 0; i < job.items.length; i++) {
        const urls = message.urls[i];
        if (
          message.hashes[i] !== job.items[i].hash ||
          !Array.isArray(urls) ||
          urls.length > job.items[i].bytes
        )
          throw new Error("Invalid response binding");
        let bytes = 0;
        for (const url of urls) {
          if (typeof url !== "string" || !url.startsWith(prefix))
            throw new Error("Invalid response URL");
          bytes += Buffer.byteLength(url);
          if (bytes > job.items[i].bytes) throw new Error("Oversized response");
        }
        if (new Set(urls).size !== urls.length)
          throw new Error("Duplicate response URL");
      }
      const result = resultFor(job.items, message.urls);
      clearTimeout(job.timer);
      active = null;
      inputBytes -= job.bytes;
      job.resolve(result);
      if (!queue.length) current.worker.unref();
      pump();
    } catch {
      void retire(current, unavailable("INVALID_REPLY"));
    }
  };
  const pump = () => {
    if (closed || active || retiring || !queue.length) return;
    if (!generation) {
      try {
        const current = {
          worker: new Worker(workerUrl),
          stopping: false,
          exited: false,
        };
        generation = current;
        workerStarts++;
        current.worker.on("message", (message) => receive(current, message));
        current.worker.on("error", () => {
          if (generation === current)
            void retire(current, unavailable("CRASH"));
        });
        current.worker.on("exit", () => {
          current.exited = true;
          if (generation === current) void retire(current, unavailable("EXIT"));
        });
      } catch {
        // Preparation is an optimization. A worker failure must not introduce
        // a new save failure for an otherwise valid document.
        while (queue.length) completeFallback(queue[0]);
        return;
      }
    }
    active = queue.shift();
    generation.worker.ref();
    try {
      generation.worker.postMessage({
        id: active.id,
        items: active.items.map(({ markdown, hash }) => ({ markdown, hash })),
      });
    } catch {
      void retire(generation, unavailable("SEND"));
    }
  };
  return {
    get stats() {
      return Object.freeze({
        closed,
        pending: queue.length + Number(!!active),
        queued: queue.length,
        inputBytes,
        active: !!active,
        workerStarts,
        workerThreadId: generation?.worker.threadId ?? null,
        terminating: !!retiring,
      });
    },
    prepare(markdowns) {
      if (closed) return Promise.reject(unavailable("CLOSED"));
      if (
        !Array.isArray(markdowns) ||
        markdowns.length > 2 ||
        markdowns.some(
          (text) =>
            typeof text !== "string" || text.length > MAX_DOCUMENT_BYTES,
        )
      )
        return Promise.reject(unavailable("INPUT"));
      const items = [];
      let bytes = 0;
      for (const markdown of markdowns) {
        if (typeof markdown !== "string")
          return Promise.reject(unavailable("INPUT"));
        const size = Buffer.byteLength(markdown);
        if (size > MAX_DOCUMENT_BYTES)
          return Promise.reject(unavailable("INPUT"));
        items.push({ markdown, bytes: size });
        bytes += size;
      }
      if (!items.some(({ markdown }) => markdown.includes(prefix)))
        return Promise.resolve(
          resultFor(
            items,
            items.map(() => []),
          ),
        );
      if (
        queue.length + Number(!!active) >= maxPending ||
        inputBytes + bytes > maxBytes
      )
        return Promise.resolve(fallback(items));
      for (const item of items) item.hash = hash(item.markdown);
      return new Promise((resolve, reject) => {
        const job = { id: randomUUID(), items, bytes, resolve, reject };
        // Deadlines include queue wait. Expiring a queued request only settles
        // that request. An active timeout replaces the worker while retaining
        // other requests and their original deadlines.
        job.timer = setTimeout(() => {
          if (active === job) void retire(generation, unavailable("TIMEOUT"));
          else completeFallback(job);
        }, timeoutMs);
        inputBytes += bytes;
        queue.push(job);
        pump();
      });
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = retire(generation, unavailable("CLOSED"));
      return closePromise;
    },
  };
}
