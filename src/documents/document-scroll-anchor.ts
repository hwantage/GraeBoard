import { mapDocumentPositions } from "../../shared/documents/document-merge.js";
import type { DocumentPlace } from "./editor/rich-editor-types";

// Keeps the same text at the same height on screen when the document switches
// between the rich editor and the Markdown source, whose heights differ and
// which may scroll inside themselves or in the panel around them.

// The nearest element around `element` that scrolls vertically.
export function scrollContainer(element: Element): Element {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (
      /^(auto|scroll|overlay)$/.test(overflowY) &&
      node.scrollHeight > node.clientHeight
    )
      return node;
  }
  return document.scrollingElement || document.documentElement;
}

// The tab row, mode row and toolbar stay pinned at the top of the scroll
// area. Its text shows below the lowest of them. `shell` is the rich editor
// whose toolbar counts; other editors' toolbars in the area do not.
export function pinnedHeight(area: Element | null, shell: Element | null) {
  let height = 0;
  for (const bar of (area ?? document).querySelectorAll<HTMLElement>(
    ".document-tabs, .document-mode-bar, .document-rich-tools",
  )) {
    const owner = bar.closest(".rich-document");
    if (!bar.offsetHeight || (owner && owner !== shell)) continue;
    const style = getComputedStyle(bar);
    if (style.position === "sticky")
      height = Math.max(
        height,
        (parseFloat(style.top) || 0) + bar.offsetHeight,
      );
  }
  return height;
}

// The part of the viewport where `element` shows text, below pinned bars. A
// scroll area partly above the viewport counts from the viewport's top.
export function visibleBounds(element: Element) {
  const container = scrollContainer(element);
  const box = element.getBoundingClientRect();
  const page = container === document.scrollingElement;
  const area = page
    ? { top: 0, bottom: window.innerHeight }
    : container.getBoundingClientRect();
  return {
    top: Math.max(
      0,
      box.top,
      area.top +
        pinnedHeight(
          page ? null : container,
          element.closest(".rich-document"),
        ),
    ),
    bottom: Math.min(box.bottom, area.bottom, window.innerHeight),
  };
}

// Scroll the area around `element` so what is at `current` moves to `wanted`
// (viewport px).
export function scrollAround(
  element: Element,
  current: number,
  wanted: number,
) {
  const delta = Math.round(current - wanted);
  if (delta) scrollContainer(element).scrollTop += delta;
}

const MIRRORED = [
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontFeatureSettings",
  "fontKerning",
  "fontVariantLigatures",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textIndent",
  "textTransform",
  "tabSize",
  "overflowWrap",
  "wordBreak",
] as const;

// A hidden copy of the textarea's text box. `lineTop(offset)` is the top of
// the line holding that offset, from the textarea's border box (px).
function mirror<T>(
  input: HTMLTextAreaElement,
  read: (lineTop: (offset: number) => number, box: HTMLDivElement) => T,
) {
  const style = getComputedStyle(input);
  const box = document.createElement("div");
  for (const key of MIRRORED) box.style[key] = style[key];
  Object.assign(box.style, {
    position: "absolute",
    top: "0",
    left: "-10000px",
    visibility: "hidden",
    whiteSpace: "pre-wrap",
    // The scrollbar narrows the textarea's lines.
    boxSizing: "border-box",
    width: `${
      input.clientWidth +
      parseFloat(style.borderLeftWidth) +
      parseFloat(style.borderRightWidth)
    }px`,
  });
  const mark = document.createElement("span");
  document.body.append(box);
  try {
    return read((offset) => {
      box.textContent = input.value.slice(0, offset);
      // The rest keeps the line wrapping as the textarea shows it.
      mark.textContent = input.value.slice(offset) || ".";
      box.append(mark);
      return input.clientTop + mark.offsetTop;
    }, box);
  } finally {
    box.remove();
  }
}

// The viewport top (px) of the textarea line holding `offset`.
export function sourceLineTop(input: HTMLTextAreaElement, offset: number) {
  return mirror(
    input,
    (lineTop) =>
      input.getBoundingClientRect().top + lineTop(offset) - input.scrollTop,
  );
}

// The first offset whose screen line, as the source wraps it, starts at or
// below viewport `top`. One layout of the copy, with a span per source line,
// finds the line; the wrapped lines inside it are told apart by their
// rectangles, which need no new layout.
export function sourceOffsetAt(input: HTMLTextAreaElement, top: number) {
  return mirror(input, (_lineTop, box) => {
    const lines = input.value.split("\n");
    box.replaceChildren(
      ...lines.map((line, index) => {
        const span = document.createElement("span");
        span.textContent = index < lines.length - 1 ? `${line}\n` : line || ".";
        return span;
      }),
    );
    const base = box.getBoundingClientRect().top;
    // A line cut by up to half its height still counts as the top one, so
    // subpixel scrolling does not skip it.
    const wanted =
      top -
      input.getBoundingClientRect().top +
      input.scrollTop -
      parseFloat(getComputedStyle(input).lineHeight) / 2;
    const range = document.createRange();
    let offset = 0;
    for (const [index, span] of [...box.children].entries()) {
      const { offsetTop, offsetHeight } = span as HTMLElement;
      const line = lines[index];
      if (input.clientTop + offsetTop + offsetHeight > wanted) {
        if (input.clientTop + offsetTop >= wanted || !line) return offset;
        const text = span.firstChild!;
        const charTop = (at: number) => {
          range.setStart(text, at);
          range.setEnd(text, at + 1);
          return range.getClientRects()[0]?.top - base;
        };
        let low = 0,
          high = line.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (charTop(middle) < wanted) low = middle + 1;
          else high = middle;
        }
        return offset + low;
      }
      offset += line.length + 1;
    }
    return input.value.length;
  });
}

// The place in `text`, a newer version of the text it was taken in: a remote
// change can arrive while the other mode opens. Null when the two versions
// cannot be compared in time.
export function placeIn(
  place: DocumentPlace,
  text: string,
): DocumentPlace | null {
  if (place.markdown === text) return place;
  const offsets: number[] | null = mapDocumentPositions(place.markdown, text, [
    place.anchor,
    place.head,
    place.view.offset,
  ]);
  if (!offsets) return null;
  const [anchor, head, offset] = offsets;
  return {
    ...place,
    markdown: text,
    anchor,
    head,
    view: { ...place.view, offset },
  };
}
