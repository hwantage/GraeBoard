import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type RefObject,
} from "react";
import { TableOfContents, X } from "lucide-react";
import type { Node } from "@milkdown/kit/prose/model";
import { TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { unfoldTogglesAround } from "./DocumentToggle";

// The table of contents beside the rich document lists its headings in
// order, including toggle headings and headings inside toggles. It only reads
// the document: jumping to a heading scrolls the document's scroll area and,
// while editing, puts the caret there. Folded toggles open in this view only.
type Heading = { level: number; text: string };
export type TocApi = {
  update: (view: EditorView, previous: EditorState) => void;
};
type Props = {
  view: () => EditorView | null;
  shell: RefObject<HTMLDivElement | null>;
  onClose: () => void;
};

const LEVELS = [1, 2, 3, 4, 5];
// Narrower documents keep their text width; the pane covers its right edge.
const SIDE_BY_SIDE_WIDTH = 640;
// Room above a heading the contents scrolled to.
const JUMP_GAP = 8;

function headingsOf(doc: Node) {
  const headings: (Heading & { pos: number })[] = [];
  doc.descendants((node, pos) => {
    const level =
      node.type.name === "heading" || node.type.name === "toggle_summary"
        ? Number(node.attrs.level) || 0
        : 0;
    const text = level ? node.textContent.trim() : "";
    if (text) headings.push({ level, text, pos });
    // Headings are text blocks; the text inside them holds no blocks.
    return !node.isTextblock;
  });
  return headings;
}

// The nearest ancestor that scrolls the document: the detail's body, a memo
// card or the document browser.
function scrollArea(shell: HTMLElement) {
  let area = shell.parentElement;
  while (area && !/auto|scroll/.test(getComputedStyle(area).overflowY))
    area = area.parentElement;
  return area;
}

// The tab row, mode row and toolbar stay pinned at the top of the scroll
// area. The contents and its jumps start below the lowest of them.
function pinnedHeight(area: HTMLElement | null, shell: HTMLElement) {
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

export default forwardRef<TocApi, Props>(function DocumentToc(
  { view: getView, shell, onClose },
  ref,
) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [depth, setDepth] = useState<number | null>(null);
  const [active, setActive] = useState(-1);
  const pane = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const positions = useRef<number[]>([]);
  const area = useRef<HTMLElement | null>(null);
  const pinned = useRef(0);
  // The heading jumped to stays current until the area is scrolled again,
  // as one near the end may not reach the top.
  const jumped = useRef<{ index: number; scrollTop: number } | null>(null);
  const frameId = useRef(0);

  function read(doc: Node) {
    const next = headingsOf(doc);
    positions.current = next.map((heading) => heading.pos);
    setHeadings((current) =>
      current.length === next.length &&
      current.every(
        (heading, index) =>
          heading.level === next[index].level &&
          heading.text === next[index].text,
      )
        ? current
        : next.map(({ level, text }) => ({ level, text })),
    );
  }
  // The current heading is the last one at or above the top of the view.
  function spy() {
    frameId.current = 0;
    const view = getView();
    const box = shell.current;
    if (!view || !box) return;
    const scroller = area.current;
    if (jumped.current && scroller?.scrollTop === jumped.current.scrollTop)
      return setActive(jumped.current.index);
    jumped.current = null;
    const bounds = scroller?.getBoundingClientRect();
    const scale = (scroller && bounds!.height / scroller.offsetHeight) || 1;
    const line =
      (bounds ? bounds.top + scroller!.clientTop * scale : 0) +
      (pinned.current + JUMP_GAP + 4) * scale;
    let current = -1;
    for (let index = 0; index < positions.current.length; index++) {
      const dom = view.nodeDOM(positions.current[index]);
      const rect = dom instanceof HTMLElement && dom.getBoundingClientRect();
      // Content of a folded toggle has no box.
      if (!rect || !rect.height) continue;
      // Above the first heading, the first one is current.
      if (current >= 0 && rect.top > line) break;
      current = index;
      if (rect.top > line) break;
    }
    setActive(current);
  }
  function scheduleSpy() {
    if (!frameId.current) frameId.current = requestAnimationFrame(spy);
  }
  useImperativeHandle(ref, () => ({
    update: (view, previous) => {
      if (view.state.doc === previous.doc) return;
      read(view.state.doc);
      scheduleSpy();
    },
  }));

  useLayoutEffect(() => {
    const view = getView();
    const box = shell.current;
    if (!view || !box) return;
    read(view.state.doc);
    const scroller = (area.current = scrollArea(box));
    const measure = () => {
      const element = pane.current;
      if (!element) return;
      pinned.current = pinnedHeight(scroller, box);
      element.style.setProperty("--document-toc-top", `${pinned.current}px`);
      element.style.setProperty(
        "--document-toc-height",
        `${(scroller?.clientHeight ?? window.innerHeight) - pinned.current}px`,
      );
      element.toggleAttribute(
        "data-overlay",
        box.clientWidth < SIDE_BY_SIDE_WIDTH,
      );
      scheduleSpy();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (scroller) observer.observe(scroller);
    const toolbar = box.querySelector(":scope > .document-rich-tools");
    if (toolbar) observer.observe(toolbar);
    const target = scroller ?? window;
    target.addEventListener("scroll", scheduleSpy, { passive: true });
    return () => {
      observer.disconnect();
      target.removeEventListener("scroll", scheduleSpy);
      cancelAnimationFrame(frameId.current);
      frameId.current = 0;
    };
  }, []);

  const shown = headings
    .map((heading, index) => ({ ...heading, index }))
    .filter((heading) => depth === null || heading.level <= depth);
  const base = Math.min(...shown.map((heading) => heading.level));
  // A heading hidden by the level filter marks the one above it instead.
  const current = shown.findLast((heading) => heading.index <= active)?.index;

  // Keep the current heading visible in a long contents list.
  useEffect(() => {
    const box = list.current;
    const item = box?.querySelector<HTMLElement>("[aria-current]");
    if (!box || !item) return;
    if (item.offsetTop < box.scrollTop) box.scrollTop = item.offsetTop;
    else if (
      item.offsetTop + item.offsetHeight >
      box.scrollTop + box.clientHeight
    )
      box.scrollTop = item.offsetTop + item.offsetHeight - box.clientHeight;
  }, [current, depth]);

  function jump(index: number, event: MouseEvent) {
    const view = getView();
    const pos = positions.current[index];
    if (!view || pos === undefined) return;
    unfoldTogglesAround(view, pos);
    if (view.editable) {
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, pos + 1),
        ),
      );
      // The keyboard continues in the document; a click keeps focus as is.
      if (event.detail === 0) view.focus();
    }
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    const scroller = area.current;
    const top = dom.getBoundingClientRect().top;
    const offset = pinned.current + JUMP_GAP;
    if (scroller) {
      const bounds = scroller.getBoundingClientRect();
      const scale = bounds.height / scroller.offsetHeight || 1;
      scroller.scrollTop +=
        (top - bounds.top) / scale - scroller.clientTop - offset;
    } else window.scrollBy(0, top - offset);
    jumped.current = { index, scrollTop: scroller?.scrollTop ?? NaN };
    setActive(index);
  }

  return (
    <aside
      ref={pane}
      className="document-toc"
      aria-label="목차"
      onKeyDown={(event) => {
        // Esc closes the contents, not the detail around it.
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="document-toc-panel">
        <div className="document-toc-header">
          <TableOfContents size={16} aria-hidden="true" />
          <strong>목차</strong>
          <div
            className="document-toc-levels"
            role="group"
            aria-label="표시할 제목 수준"
          >
            {LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                aria-label={`H${level}까지 보기`}
                data-tooltip={`H${level}까지 보기`}
                aria-pressed={depth === level}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setDepth(depth === level ? null : level)}
              >
                H{level}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="document-toc-close"
            aria-label="목차 닫기"
            data-tooltip="목차 닫기"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        {shown.length ? (
          <ol className="document-toc-list" ref={list}>
            {shown.map((heading) => (
              <li key={heading.index}>
                <button
                  type="button"
                  title={heading.text}
                  data-level={heading.level}
                  aria-current={
                    heading.index === current ? "location" : undefined
                  }
                  style={
                    {
                      "--document-toc-indent": heading.level - base,
                    } as CSSProperties
                  }
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => jump(heading.index, event)}
                >
                  {heading.text}
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="document-toc-empty">제목이 없습니다</p>
        )}
      </div>
    </aside>
  );
});
