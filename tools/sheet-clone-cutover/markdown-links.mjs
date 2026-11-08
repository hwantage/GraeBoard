import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

// Stored Markdown links to a sheet clone's task or memo, rewritten once:
//
//   /links/report-task/<사본>/<업무>  ->  /links/sheet-clone-task/<사본>/<업무>
//   /links/report-memo/<사본>/<메모>  ->  /links/sheet-clone-memo/<사본>/<메모>
//
// Only real link destinations change: inline and reference links, autolinks,
// the `href` of an `<a>` tag, and the Markdown a toggle keeps inside its html
// (title and body, read as src/DocumentToggle.ts reads them). Text, code,
// inline code, html comments and link text stay as written. A relative address
// always belongs to this app; an absolute one only for the operator's origins.
// Query and fragment are kept. Every edit replaces exactly the old segment
// once, so the rest of the body is byte-identical.
const parser = unified().use(remarkParse).use(remarkGfm);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LEGACY_PATH = new RegExp(
  `^/links/report-(task|memo)/(${UUID})/(${UUID}|main)$`,
);
// The toggle grammar of src/DocumentToggle.ts (parseOpen, groupDetails).
const PHRASING_PARENTS = new Set([
  "paragraph",
  "heading",
  "tableCell",
  "link",
  "linkReference",
  "emphasis",
  "strong",
  "delete",
]);
const SUMMARY_INLINE = new Set([
  "text",
  "strong",
  "emphasis",
  "delete",
  "inlineCode",
  "link",
]);
const DETAILS_OPEN =
  /^<details((?:\s+open(?:\s*=\s*(?:""|''|"open"|'open'|open))?)?)\s*>[ \t]*\r?\n?/i;
const SUMMARY = /^[ \t]*<summary>([^\n]*?)<\/summary>[ \t]*(?:\r?\n|$)/di;
const SUMMARY_HEADING = /^\s*<h([1-6])>([^\n]*?)<\/h\1>\s*$/di;
const DETAILS_CLOSE = /^<\/details\s*>[ \t]*(?:\r?\n|$)/i;
const DETAILS_END = /\r?\n?<\/details\s*>\s*$/i;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const ANCHOR = /<a(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const ATTRIBUTE =
  /([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

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

const supportedTitle = (nodes) =>
  nodes.every(
    (node) =>
      SUMMARY_INLINE.has(node.type) &&
      (!node.children || supportedTitle(node.children)),
  );
// A toggle's opening html as parseOpen reads it: the title on the summary line
// right after `<details>` and the body that follows in the same html, each
// [from, to) in the html. null when the editor keeps it as plain html.
function toggleOpening(html) {
  const open = DETAILS_OPEN.exec(html);
  if (!open) return null;
  const at = open[0].length,
    summary = SUMMARY.exec(html.slice(at));
  if (!summary) return null;
  const heading = SUMMARY_HEADING.exec(summary[1]),
    from = at + summary.indices[1][0] + (heading ? heading.indices[2][0] : 0),
    to = from + (heading ? heading[2] : summary[1]).length,
    title = html.slice(from, to);
  if (title.trim()) {
    const [block, ...more] = parser.parse(title).children;
    if (
      !block ||
      more.length ||
      block.type !== "paragraph" ||
      !supportedTitle(block.children)
    )
      return null;
  }
  const body = at + summary[0].length,
    end = DETAILS_END.exec(html.slice(body));
  return {
    parts: [
      [from, to],
      [body, end ? body + end.index : html.length],
    ],
    closed: !!end,
  };
}

// Where each position of an html node's value is stored. Inside a list item
// or block quote the parser drops each line's prefix (indentation, `>`), so a
// value line is the end of its stored line; anything else is not mapped.
function storedAt(markdown, node) {
  const start = node.position.start.offset,
    stored = markdown.slice(start, node.position.end.offset);
  if (stored === node.value) return (i) => start + i;
  const lines = node.value.split("\n"),
    storedLines = stored.split("\n");
  if (lines.length !== storedLines.length) return null;
  const map = [];
  for (let i = 0, from = 0, at = start; i < lines.length; i++) {
    if (!storedLines[i].endsWith(lines[i])) return null;
    map.push([from, at + storedLines[i].length - lines[i].length]);
    from += lines[i].length + 1;
    at += storedLines[i].length + 1;
  }
  return (i) => {
    const [from, at] = map.findLast(([from]) => from <= i);
    return at + i - from;
  };
}

function editsOf(markdown, origins, base, report) {
  const edits = [];
  const replace = (start, url, next) => {
    // The stored text of the destination, exactly where the parser found it.
    if (markdown.slice(start, start + url.length) !== url) {
      report.unverified.push(url);
      return;
    }
    edits.push({
      start: base + start,
      end: base + start + url.length,
      url,
      next,
    });
  };
  // Html: its Markdown parts are converted as Markdown, the rest only in the
  // `href` of `<a>` tags outside comments.
  const html = (node, parts) => {
    const value = node.value;
    if (!value.includes("/links/report-")) return;
    const at = storedAt(markdown, node);
    if (!at) {
      report.unverified.push(value);
      return;
    }
    for (const [from, to] of parts)
      if (value.slice(from, to).includes("/links/report-"))
        for (const edit of editsOf(value.slice(from, to), origins, 0, report))
          replace(at(from + edit.start), edit.url, edit.next);
    const skip = [
      ...[...value.matchAll(COMMENT)].map((m) => [
        m.index,
        m.index + m[0].length,
      ]),
      ...parts,
    ];
    for (const tag of value.matchAll(ANCHOR)) {
      if (skip.some(([from, to]) => tag.index >= from && tag.index < to))
        continue;
      for (const attribute of tag[0].slice(2).matchAll(ATTRIBUTE)) {
        const url = attribute[2] ?? attribute[3] ?? attribute[4];
        if (attribute[1].toLowerCase() !== "href" || url === undefined)
          continue;
        const next = convertLinkUrl(url, origins);
        if (next)
          replace(
            at(tag.index + 2 + attribute.index + attribute[0].lastIndexOf(url)),
            url,
            next,
          );
        else if (url.includes("/links/report-")) report.kept.push(url);
      }
    }
  };
  // The children of a block container, as groupDetails groups them: an
  // opening toggle html carries Markdown, and so does what follows its
  // closing `</details>` in the same html.
  const flow = (children) => {
    let open = 0;
    for (const node of children) {
      if (node.type !== "html") {
        visit(node);
        continue;
      }
      const toggle = toggleOpening(node.value),
        close = !toggle && open > 0 && DETAILS_CLOSE.exec(node.value);
      if (toggle && !toggle.closed) open++;
      if (close) open--;
      html(
        node,
        toggle
          ? toggle.parts
          : close
            ? [[close[0].length, node.value.length]]
            : [],
      );
    }
  };
  const visit = (node) => {
    if (node.type === "code" || node.type === "inlineCode") return;
    if (node.type === "html") return html(node, []);
    if (node.type === "link" || node.type === "definition") {
      const next = convertLinkUrl(node.url, origins);
      if (!next) {
        if (node.url?.includes("/links/report-")) report.kept.push(node.url);
      } else {
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
        if (at < 0 || at + node.url.length > to)
          report.unverified.push(node.url);
        else replace(at, node.url, next);
        if (literal) return;
      }
    }
    if (!node.children) return;
    if (PHRASING_PARENTS.has(node.type)) node.children.forEach(visit);
    else flow(node.children);
  };
  visit(parser.parse(markdown));
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
  // Every edit must name the old address exactly where it stands in the whole
  // body, once; otherwise the reading above is wrong and the body is refused.
  for (const [i, edit] of edits.entries())
    if (
      markdown.slice(edit.start, edit.end) !== edit.url ||
      (i > 0 && edit.end > edits[i - 1].start)
    )
      report.unverified.push(edit.url);
  let text = markdown;
  for (const edit of edits)
    text = text.slice(0, edit.start) + edit.next + text.slice(edit.end);
  return { markdown: text, changes: edits.length, ...report };
}
