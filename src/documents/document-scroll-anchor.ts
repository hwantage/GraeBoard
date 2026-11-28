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

// The part of the viewport where `element` can show text.
export function visibleBounds(element: Element) {
  const container = scrollContainer(element);
  let top = Math.max(0, element.getBoundingClientRect().top);
  let bottom = Math.min(
    window.innerHeight,
    element.getBoundingClientRect().bottom,
  );
  if (container !== document.scrollingElement) {
    const box = container.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
  }
  return { top, bottom };
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
  read: (lineTop: (offset: number) => number) => T,
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
    });
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

// The first offset whose line starts at or below viewport `top`.
export function sourceOffsetAt(input: HTMLTextAreaElement, top: number) {
  return mirror(input, (lineTop) => {
    const wanted = top - input.getBoundingClientRect().top + input.scrollTop;
    let low = 0,
      high = input.value.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (lineTop(middle) < wanted) low = middle + 1;
      else high = middle;
    }
    return low;
  });
}
