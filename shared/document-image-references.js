import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { documentImageSource } from "./document-images.js";

// Shared by Node, Worker and the Git protocol. Image syntax, including reference
// definitions, follows the same Markdown parser as the existing Node API.
const markdownParser = unified().use(remarkParse).use(remarkGfm);
export function documentImageUrls(markdown) {
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
