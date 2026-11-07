import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

// Stored Markdown links to a sheet clone's task or memo, rewritten once:
//
//   /links/report-task/<사본>/<업무>  ->  /links/sheet-clone-task/<사본>/<업무>
//   /links/report-memo/<사본>/<메모>  ->  /links/sheet-clone-memo/<사본>/<메모>
//
// Only real link destinations change: inline and reference links, autolinks,
// `href` of HTML anchors and the link of a toggle title (`<summary>` keeps
// Markdown, see src/DocumentToggle.ts). Text, code, inline code and link text
// stay as written. A relative address always belongs to this app; an absolute
// one only for the operator's origins. Query and fragment are kept. Every edit
// replaces exactly the old segment, so the rest of the body is byte-identical.
const parser = unified().use(remarkParse).use(remarkGfm);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LEGACY_PATH = new RegExp(
  `^/links/report-(task|memo)/(${UUID})/(${UUID}|main)$`,
);
const SUMMARY = /<summary>([^\n]*?)<\/summary>/gi;
const SUMMARY_HEADING = /^(\s*<h([1-6])>)([^\n]*?)<\/h\2>\s*$/i;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

// The new address of a link destination, or null when it is not one of ours.
function convertLinkUrl(url, origins = []) {
  if (typeof url !== "string" || !url.includes("/links/report-")) return null;
  let path, prefix, suffix;
  if (url.startsWith("/")) {
    const end = url.search(/[?#]/);
    path = end < 0 ? url : url.slice(0, end);
    prefix = "";
    suffix = end < 0 ? "" : url.slice(end);
  } else {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!origins.includes(parsed.origin)) return null;
    const start = url.indexOf(parsed.pathname, parsed.origin.length);
    if (start < 0) return null;
    prefix = url.slice(0, start);
    path = parsed.pathname;
    suffix = url.slice(start + path.length);
  }
  const m = LEGACY_PATH.exec(path);
  if (!m) return null;
  return `${prefix}/links/sheet-clone-${m[1]}/${m[2]}/${m[3]}${suffix}`;
}

const visit = (node, fn) => {
  if (fn(node) === false) return;
  node.children?.forEach((child) => visit(child, fn));
};

function editsOf(markdown, origins, base, report) {
  const edits = [];
  const replace = (start, url, next) => {
    // The stored text of the destination, exactly where the parser found it.
    if (markdown.slice(start, start + url.length) !== url) {
      report.unverified.push(url);
      return;
    }
    edits.push({ start: base + start, end: base + start + url.length, next });
  };
  const tree = parser.parse(markdown);
  visit(tree, (node) => {
    if (node.type === "code" || node.type === "inlineCode") return false;
    if (node.type === "link" || node.type === "definition") {
      const next = convertLinkUrl(node.url, origins);
      if (!next) {
        if (node.url?.includes("/links/report-")) report.kept.push(node.url);
        return node.type === "link" ? undefined : false;
      }
      const from =
          node.type === "definition"
            ? markdown.indexOf("]:", node.position.start.offset) + 2
            : node.children.length
              ? node.children.at(-1).position.end.offset
              : node.position.start.offset,
        to = node.position.end.offset,
        source = markdown.slice(node.position.start.offset, to);
      // An autolink is its own text: `<url>` or the bare literal.
      const literal =
        node.type === "link" &&
        (source === node.url || source === `<${node.url}>`);
      const at = literal
        ? node.position.start.offset + (source.startsWith("<") ? 1 : 0)
        : markdown.indexOf(node.url, from);
      if (at < 0 || at + node.url.length > to) report.unverified.push(node.url);
      else replace(at, node.url, next);
      return literal ? false : undefined;
    }
    if (node.type === "html") {
      const start = node.position.start.offset,
        value = markdown.slice(start, node.position.end.offset);
      if (value !== node.value) {
        report.unverified.push(node.value);
        return false;
      }
      for (const m of value.matchAll(HREF)) {
        const url = m[1] ?? m[2] ?? m[3],
          next = convertLinkUrl(url, origins);
        if (next) replace(start + m.index + m[0].lastIndexOf(url), url, next);
        else if (url.includes("/links/report-")) report.kept.push(url);
      }
      // A toggle title is Markdown inside `<summary>` and an optional
      // `<hN>`, as the editor reads it (SUMMARY_HEADING in DocumentToggle).
      for (const m of value.matchAll(SUMMARY)) {
        const heading = SUMMARY_HEADING.exec(m[1]),
          title = heading ? heading[3] : m[1],
          offset =
            start + m.index + m[0].indexOf(m[1]) + (heading?.[1].length || 0);
        edits.push(...editsOf(title, origins, base + offset, report));
      }
      return false;
    }
  });
  return edits;
}

// { markdown, changes, kept, unverified }: kept are addresses of the old
// shape left alone on purpose (an unrelated origin or not a complete link);
// unverified are destinations whose stored text did not match the parser.
export function convertMarkdownLinks(markdown, { origins = [] } = {}) {
  const report = { kept: [], unverified: [] };
  if (typeof markdown !== "string" || !markdown.includes("/links/report-"))
    return { markdown, changes: 0, ...report };
  const edits = editsOf(markdown, origins, 0, report).sort(
    (a, b) => b.start - a.start,
  );
  let text = markdown;
  for (const edit of edits)
    text = text.slice(0, edit.start) + edit.next + text.slice(edit.end);
  return { markdown: text, changes: edits.length, ...report };
}
