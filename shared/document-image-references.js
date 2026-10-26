import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { documentImageSource } from "./document-images.js";

// Shared by Node, Worker and the Git protocol. Image syntax, including reference
// definitions, follows the same Markdown parser as the existing Node API.
const markdownParser = unified().use(remarkParse).use(remarkGfm);
function parseDocumentImageUrls(markdown) {
  if (
    typeof markdown !== "string" ||
    !markdown.includes("/api/document-images/")
  )
    return [];
  const tree = markdownParser.parse(markdown);
  const definitions = new Map();
  const visit = (node, fn) => {
    fn(node);
    node.children?.forEach((child) => visit(child, fn));
  };
  visit(tree, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url);
  });
  const urls = new Set();
  visit(tree, (node) => {
    const url =
      node.type === "image"
        ? node.url
        : node.type === "imageReference"
          ? definitions.get(node.identifier)
          : null;
    if (url?.startsWith("/api/document-images/"))
      urls.add(documentImageSource(url) || url);
  });
  return [...urls];
}

// Cache extraction only: authorization, team matching, file existence and all
// protocol checks still run at each call site. No AST or validation-success
// result is retained. Exact immutable strings are the only cache keys.
export function createDocumentImageReferenceCache({
  maxEntries = 8,
  maxBytes = 2 * 1024 * 1024,
  ttlMs = 30000,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();
  let bytes = 0,
    closed = false;
  const remove = (key) => {
    const entry = entries.get(key);
    if (entry) {
      bytes -= entry.bytes;
      entries.delete(key);
    }
  };
  const prune = () => {
    const time = now();
    for (const [key, entry] of entries) if (entry.expires <= time) remove(key);
  };
  return {
    get closed() {
      return closed;
    },
    get size() {
      prune();
      return entries.size;
    },
    get bytes() {
      prune();
      return bytes;
    },
    get(key) {
      if (closed) return undefined;
      prune();
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.urls;
    },
    set(key, urls) {
      if (closed) return;
      prune();
      remove(key);
      const size =
        64 + key.length * 2 + urls.reduce((n, url) => n + url.length * 2, 0);
      if (maxEntries < 1 || size > maxBytes) return;
      while (entries.size >= maxEntries || bytes + size > maxBytes)
        remove(entries.keys().next().value);
      entries.set(key, {
        urls: Object.freeze([...urls]),
        bytes: size,
        expires: now() + ttlMs,
      });
      bytes += size;
    },
    close() {
      closed = true;
      entries.clear();
      bytes = 0;
    },
  };
}
const recentReferences = createDocumentImageReferenceCache();
const referenceScope = new AsyncLocalStorage();
const parseEvents = channel("graeboard.document-images.parse");
const noImages = Object.freeze([]);
export function documentImageUrls(markdown) {
  if (
    typeof markdown !== "string" ||
    !markdown.includes("/api/document-images/")
  )
    return noImages;
  const scope = referenceScope.getStore();
  const cached = scope?.get(markdown) || recentReferences.get(markdown);
  if (cached) {
    scope?.set(markdown, cached);
    return cached;
  }
  if (parseEvents.hasSubscribers)
    parseEvents.publish({ characters: markdown.length });
  const urls = Object.freeze(parseDocumentImageUrls(markdown));
  recentReferences.set(markdown, urls);
  scope?.set(markdown, urls);
  return urls;
}

// Synchronous SQLite callers stay synchronous. Async PG commands retain their
// own scope across awaits; close it on success or failure, including late tasks.
export function withDocumentImageReferences(work) {
  if (referenceScope.getStore() && !referenceScope.getStore().closed)
    return work();
  const scope = createDocumentImageReferenceCache();
  return referenceScope.run(scope, () => {
    try {
      const result = work();
      if (result?.then)
        return Promise.resolve(result).finally(() => scope.close());
      scope.close();
      return result;
    } catch (error) {
      scope.close();
      throw error;
    }
  });
}

// Plain cell values, titles, tag names and filters may contain image-looking
// text. Only Markdown body fields carry image dependencies. Backup/transfer
// tables also store these bodies inside explicitly serialized JSON columns.
const serializedFields = new Set(["payload", "before_json", "after_json"]);
export function documentPayloadImageUrls(value) {
  if (typeof value === "string") return documentImageUrls(value);
  const urls = new Set(),
    pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (key === "markdown" && typeof child === "string") {
        for (const url of documentImageUrls(child)) urls.add(url);
      } else if (child && typeof child === "object") pending.push(child);
      else if (serializedFields.has(key) && typeof child === "string") {
        try {
          const decoded = JSON.parse(child);
          if (decoded && typeof decoded === "object") pending.push(decoded);
        } catch {
          // Historical free text is not a serialized document payload.
        }
      }
    }
  }
  return [...urls];
}
