import { parentPort } from "node:worker_threads";
import { createHash } from "node:crypto";
import { documentImageUrls } from "../shared/document-image-references.js";
import { MAX_DOCUMENT_BYTES } from "../shared/task-documents.js";

const hash = (text) => createHash("sha256").update(text).digest("hex");
parentPort.on("message", ({ id, items }) => {
  // This worker has no DB or file access. The main process separately rechecks
  // team ownership, current document revision and image existence before save.
  if (
    typeof id !== "string" ||
    !Array.isArray(items) ||
    items.length > 2 ||
    items.some(
      (item) =>
        typeof item?.markdown !== "string" ||
        item.markdown.length > MAX_DOCUMENT_BYTES ||
        Buffer.byteLength(item.markdown) > MAX_DOCUMENT_BYTES ||
        item.hash !== hash(item.markdown),
    )
  )
    throw new Error("Invalid document image preparation request");
  const urls = items.map(({ markdown }) => documentImageUrls(markdown));
  for (let i = 0; i < items.length; i++) {
    const inputBytes = Buffer.byteLength(items[i].markdown);
    let bytes = 0;
    for (const url of urls[i]) {
      bytes += Buffer.byteLength(url);
      if (
        typeof url !== "string" ||
        !url.startsWith("/api/document-images/") ||
        bytes > inputBytes
      )
        throw new Error("Invalid document image preparation result");
    }
  }
  parentPort.postMessage({ id, hashes: items.map((item) => item.hash), urls });
});
