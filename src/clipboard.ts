import {
  cell,
  displayValue,
  FONTS,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  normalizeFont,
  textMode,
} from "../shared/domain.js";
import type { Settings, Style, Task, User } from "./types";

export type ClipboardCell = { text: string; style?: Style };
export type ClipboardMatrix = ClipboardCell[][];
export const CELL_MIME = "application/x-weekly-plan-cells+json";
const LIMIT = 2000;
const BASE_STYLE: Required<Style> = {
  color: "#5c7078",
  backgroundColor: "#ffffff",
  fontFamily: FONTS[0],
  fontSize: 9,
  textAlign: "left",
  verticalAlign: "middle",
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  wrap: false,
  textMode: "overflow",
};

function checkSize<T extends ClipboardMatrix>(rows: T): T {
  if (rows.reduce((n, row) => n + row.length, 0) > LIMIT)
    throw new Error("한 번에 2,000개 셀까지 복사·붙여넣을 수 있습니다.");
  if (rows.some((row) => row.some((c) => c.text.length > 10000)))
    throw new Error("한 셀에 10,000자까지 붙여넣을 수 있습니다.");
  return rows;
}

// Only supported cell properties cross the clipboard boundary.
function cleanStyle(input: unknown): Style {
  const s =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const result: Style = {};
  for (const key of ["color", "backgroundColor"] as const)
    if (typeof s[key] === "string" && /^#[a-f\d]{6}$/i.test(s[key]))
      result[key] = s[key];
  if (typeof s.fontFamily === "string" && FONTS.includes(s.fontFamily))
    result.fontFamily = s.fontFamily;
  if (
    typeof s.fontSize === "number" &&
    Number.isInteger(s.fontSize) &&
    s.fontSize >= MIN_FONT_SIZE &&
    s.fontSize <= MAX_FONT_SIZE
  )
    result.fontSize = s.fontSize;
  if (["left", "center", "right"].includes(String(s.textAlign)))
    result.textAlign = s.textAlign as Style["textAlign"];
  if (["top", "middle", "bottom"].includes(String(s.verticalAlign)))
    result.verticalAlign = s.verticalAlign as Style["verticalAlign"];
  for (const key of ["bold", "italic", "underline", "strike", "wrap"] as const)
    if (typeof s[key] === "boolean") result[key] = s[key];
  if (["overflow", "wrap", "clip"].includes(String(s.textMode)))
    result.textMode = s.textMode as Style["textMode"];
  else if (result.wrap !== undefined)
    result.textMode = result.wrap ? "wrap" : "overflow";
  return result;
}

function escapeHTML(text: string) {
  return text.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );
}

export function createClipboard(
  tasks: Task[],
  keys: string[],
  users: User[],
  settings: Settings,
) {
  if (tasks.length * keys.length > LIMIT)
    throw new Error("한 번에 2,000개 셀까지 복사·붙여넣을 수 있습니다.");
  const rows = checkSize(
    tasks.map((task) =>
      keys.map((key) => ({
        text: displayValue(task, key, users, settings),
        // Explicit defaults also clear formatting inherited from the destination task.
        style: {
          ...BASE_STYLE,
          color: key === "title" ? "#3e5661" : BASE_STYLE.color,
          ...cell(task, key).style,
          textMode: textMode(cell(task, key).style) as Style["textMode"],
          wrap: textMode(cell(task, key).style) === "wrap",
        },
      })),
    ),
  );
  const plain = rows
    .map((row) =>
      row
        .map(({ text }) =>
          /[\n\r\t"]/.test(text)
            ? '"' + text.replaceAll('"', '""') + '"'
            : text,
        )
        .join("\t"),
    )
    .join("\n");
  const html = `<table><tbody>${rows
    .map(
      (row) =>
        `<tr>${row
          .map(({ text, style: s }) => {
            const css = [
              `color:${s.color}`,
              `background-color:${s.backgroundColor}`,
              `font-family:${s.fontFamily}`,
              `font-size:${s.fontSize}pt`,
              `font-weight:${s.bold ? 700 : 400}`,
              `font-style:${s.italic ? "italic" : "normal"}`,
              `text-decoration:${[s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ") || "none"}`,
              `text-align:${s.textAlign}`,
              `vertical-align:${s.verticalAlign}`,
              `white-space:${s.wrap ? "pre-wrap" : "nowrap"}`,
              `overflow:${s.textMode === "clip" ? "hidden" : "visible"}`,
            ].join(";");
            return `<td data-text-mode="${s.textMode}" style="${escapeHTML(css)}">${escapeHTML(text).replace(/\r\n|\r|\n/g, "<br>")}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
  return {
    "text/plain": plain,
    "text/html": html,
    [CELL_MIME]: JSON.stringify({ version: 1, rows }),
  };
}

export function copyToEvent(
  data: DataTransfer,
  contents: ReturnType<typeof createClipboard>,
) {
  data.setData("text/plain", contents["text/plain"]);
  data.setData("text/html", contents["text/html"]);
  try {
    data.setData(CELL_MIME, contents[CELL_MIME]);
  } catch {
    /* HTML retains formatting on browsers without custom types. */
  }
}

export async function copyToSystem(
  contents: ReturnType<typeof createClipboard>,
) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
    throw new Error("표에 초점을 두고 Ctrl/Cmd+C로 복사하세요.");
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/plain": new Blob([contents["text/plain"]], { type: "text/plain" }),
      "text/html": new Blob([contents["text/html"]], { type: "text/html" }),
    }),
  ]);
}

export function parseTSV(text: string): string[][] {
  const rows: string[][] = [[]];
  let token = "",
    quoted = false,
    count = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        token += '"';
        i++;
      } else if (quoted || token === "") quoted = !quoted;
      else token += ch;
    } else if (!quoted && (ch === "\t" || ch === "\n" || ch === "\r")) {
      rows.at(-1)!.push(token);
      if (++count > LIMIT)
        throw new Error("한 번에 2,000개 셀까지 붙여넣을 수 있습니다.");
      token = "";
      if (ch !== "\t") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        rows.push([]);
      }
    } else token += ch;
  }
  rows.at(-1)!.push(token);
  if (rows.length > 1 && rows.at(-1)!.length === 1 && rows.at(-1)![0] === "")
    rows.pop();
  return rows;
}

function colorHex(color: string): string | undefined {
  if (/^#[a-f\d]{6}$/i.test(color)) return color;
  if (/^#[a-f\d]{3}$/i.test(color))
    return "#" + [...color.slice(1)].map((c) => c + c).join("");
  const rgb = color.match(
    /^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/,
  );
  if (!rgb || (rgb[4] !== undefined && Number(rgb[4]) !== 1)) return;
  return (
    "#" +
    rgb
      .slice(1, 4)
      .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0"))
      .join("")
  );
}

function htmlStyle(element: HTMLElement): Style {
  const s = element.style,
    result: Style = {};
  const color = colorHex(s.color),
    background = colorHex(s.backgroundColor);
  if (color) result.color = color;
  if (background) result.backgroundColor = background;
  if (s.fontFamily)
    result.fontFamily =
      s.fontFamily.split(",").map(normalizeFont).find(Boolean) || FONTS[0];
  if (/^[\d.]+(pt|px)$/.test(s.fontSize))
    result.fontSize = Math.max(
      MIN_FONT_SIZE,
      Math.min(
        MAX_FONT_SIZE,
        Math.round(
          parseFloat(s.fontSize) * (s.fontSize.endsWith("px") ? 0.75 : 1),
        ),
      ),
    );
  if (["left", "center", "right"].includes(s.textAlign))
    result.textAlign = s.textAlign as Style["textAlign"];
  if (["top", "middle", "bottom"].includes(s.verticalAlign))
    result.verticalAlign = s.verticalAlign as Style["verticalAlign"];
  if (s.fontWeight)
    result.bold = s.fontWeight === "bold" || Number(s.fontWeight) >= 600;
  if (s.fontStyle)
    result.italic = s.fontStyle === "italic" || s.fontStyle === "oblique";
  const decoration = s.textDecorationLine || s.textDecoration;
  if (decoration) {
    result.underline = decoration.includes("underline");
    result.strike = decoration.includes("line-through");
  }
  if (s.whiteSpace) {
    result.wrap = !["nowrap", "pre"].includes(s.whiteSpace);
    result.textMode = result.wrap
      ? "wrap"
      : s.overflow === "hidden"
        ? "clip"
        : "overflow";
  }
  if (["overflow", "wrap", "clip"].includes(element.dataset.textMode || "")) {
    result.textMode = element.dataset.textMode as Style["textMode"];
    result.wrap = result.textMode === "wrap";
  }
  return result;
}

function htmlText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (!(node instanceof Element)) return "";
  if (
    ["SCRIPT", "STYLE", "IFRAME", "OBJECT", "TEMPLATE"].includes(node.tagName)
  )
    return "";
  if (node.tagName === "BR") return "\n";
  return Array.from(node.childNodes)
    .map(
      (child, i) =>
        (i > 0 &&
        child instanceof Element &&
        ["DIV", "P"].includes(child.tagName)
          ? "\n"
          : "") + htmlText(child),
    )
    .join("");
}

function parseHTML(html: string): ClipboardMatrix | null {
  // A detached template stays inert: no scripts, styles or resources enter the page.
  const template = document.createElement("template");
  template.innerHTML = html;
  const table = template.content.querySelector("table");
  if (!table) return null;
  const rows: ClipboardMatrix = [];
  let count = 0;
  for (const tr of Array.from(table.rows)) {
    const row: ClipboardCell[] = [];
    for (const td of Array.from(tr.cells)) {
      if (++count > LIMIT)
        throw new Error("한 번에 2,000개 셀까지 붙여넣을 수 있습니다.");
      if (td.colSpan > 1 || td.rowSpan > 1)
        throw new Error("병합된 셀은 원본에서 병합을 해제한 뒤 붙여넣으세요.");
      const inherited = [table, tr.parentElement, tr, td].filter(
        Boolean,
      ) as HTMLElement[];
      const style = Object.assign({}, BASE_STYLE, ...inherited.map(htmlStyle));
      // Sheets and other editors often put whole-cell formatting on one text wrapper.
      let wrapper: Element = td;
      while (
        wrapper.children.length === 1 &&
        wrapper.textContent === wrapper.firstElementChild!.textContent
      ) {
        wrapper = wrapper.firstElementChild!;
        Object.assign(style, htmlStyle(wrapper as HTMLElement));
        if (["B", "STRONG"].includes(wrapper.tagName)) style.bold = true;
        if (["I", "EM"].includes(wrapper.tagName)) style.italic = true;
        if (wrapper.tagName === "U") style.underline = true;
        if (["S", "STRIKE", "DEL"].includes(wrapper.tagName))
          style.strike = true;
      }
      row.push({ text: htmlText(td), style });
    }
    if (row.length) rows.push(row);
  }
  return rows.length ? checkSize(rows) : null;
}

export function readClipboard(
  data: Pick<DataTransfer, "types" | "getData">,
): ClipboardMatrix {
  const types = Array.from(data.types);
  if (types.includes(CELL_MIME)) {
    let payload;
    try {
      payload = JSON.parse(data.getData(CELL_MIME));
    } catch {
      /* Try interoperable formats. */
    }
    if (
      payload?.version === 1 &&
      Array.isArray(payload.rows) &&
      payload.rows.length &&
      payload.rows.every(
        (r: unknown) =>
          Array.isArray(r) &&
          r.length &&
          r.every(
            (c: unknown) =>
              c &&
              typeof c === "object" &&
              typeof (c as ClipboardCell).text === "string",
          ),
      )
    ) {
      return checkSize(
        payload.rows.map((row: ClipboardCell[]) =>
          row.map((c) => ({
            text: c.text,
            style: { ...BASE_STYLE, ...cleanStyle(c.style) },
          })),
        ),
      );
    }
  }
  if (types.includes("text/html")) {
    const rows = parseHTML(data.getData("text/html"));
    if (rows) return rows;
  }
  if (types.includes("text/plain"))
    return checkSize(
      parseTSV(data.getData("text/plain")).map((r) =>
        r.map((text) => ({ text })),
      ),
    );
  throw new Error("텍스트 또는 표 내용을 복사해서 붙여넣으세요.");
}
