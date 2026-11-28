import { useLayoutEffect, useRef, useState } from "react";

import { parseDocumentLinkPath } from "../../../shared/documents/document-links.js";
import {
  DocumentLinkTitles,
  documentLinkTarget,
  copyToClipboard,
  useDocumentLinkOpener,
} from "../document-links";
import { openDocumentLink } from "./DocumentLinkNode";

import { useToast } from "../../ui/Toast";

import { type EditorView } from "@milkdown/kit/prose/view";
import { Editor, editorViewCtx } from "@milkdown/kit/core";
import { linkSchema } from "@milkdown/kit/preset/commonmark";

import { TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import { type Mark } from "@milkdown/kit/prose/model";

import type { Ctx } from "@milkdown/kit/ctx";

import type { RichEditorProps as Props } from "./rich-editor-types";

import { safeDocumentLink } from "./document-markdown";
type LinkRange = { from: number; to: number; mark: Mark };
function linkAround(
  state: EditorState,
  selection = state.selection,
): LinkRange | null {
  const type = state.schema.marks.link;
  const { $from, $to } = selection;
  if (!type || !(selection instanceof TextSelection) || !$from.sameParent($to))
    return null;
  const parent = $from.parent;
  const offset = $from.parentOffset;
  let mark: Mark | null | undefined = null;
  let index = -1;
  const before = offset ? parent.childBefore(offset) : null;
  const after = parent.childAfter(offset);
  for (const hit of selection.empty ? [before, after] : [after]) {
    mark = hit?.node && type.isInSet(hit.node.marks);
    if (mark) {
      index = hit!.index;
      break;
    }
  }
  if (!mark) return null;
  let first = index;
  let last = index + 1;
  while (first > 0 && mark.isInSet(parent.child(first - 1).marks)) first--;
  while (last < parent.childCount && mark.isInSet(parent.child(last).marks))
    last++;
  let from = $from.start();
  for (let i = 0; i < first; i++) from += parent.child(i).nodeSize;
  let to = from;
  for (let i = first; i < last; i++) to += parent.child(i).nodeSize;
  return $from.pos >= from && $to.pos <= to ? { from, to, mark } : null;
}
export default function useDocumentLinkActions({
  props,
  editorRef,
  shell,
  run,
}: {
  editorRef: React.RefObject<Editor | null>;
  shell: React.RefObject<HTMLDivElement | null>;
  props: Props;
  run: (action: (ctx: Ctx) => unknown) => void;
}) {
  const documentLinks = useDocumentLinkOpener();
  const linkOpener = useRef(documentLinks);
  type LinkForm = {
    href: string;
    text: string;
    original: string;
    editText: boolean;
    existing: boolean;
  };
  const [link, setLink] = useState<LinkForm | null>(null);
  const [linkError, setLinkError] = useState("");
  type LinkTip = { href: string; left: number; top: number };
  const [linkTip, setLinkTip] = useState<LinkTip | null>(null);
  const hoveredLink = useRef<HTMLAnchorElement | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const linkTipBox = useRef<HTMLDivElement>(null);
  const linkTitlesRef = useRef<DocumentLinkTitles | null>(null);
  const [notice, setNotice] = useToast();
  const [noticeFailed, setNoticeFailed] = useState(false);
  const [linkOpenError, setLinkOpenError] = useState("");
  linkOpener.current = documentLinks;
  function keepLinkTip() {
    window.clearTimeout(hideTimer.current);
  }
  function hideLinkTip() {
    keepLinkTip();
    if (!hoveredLink.current) return false;
    hoveredLink.current = null;
    setLinkTip(null);
    return true;
  }
  function leaveLinkTip() {
    if (!hoveredLink.current) return;
    // Give the pointer time to cross the gap to the action buttons.
    keepLinkTip();
    hideTimer.current = window.setTimeout(hideLinkTip, 150);
  }
  function hoveredRange(view: EditorView, anchor: HTMLAnchorElement) {
    if (!view.dom.contains(anchor)) return null;
    const from = view.posAtDOM(anchor, 0);
    const to = view.posAtDOM(anchor, anchor.childNodes.length);
    if (
      from >= to ||
      !view.state.doc.resolve(from).parent.inlineContent ||
      !view.state.doc.rangeHasMark(from, to, view.state.schema.marks.link)
    )
      return null;
    const range = linkAround(
      view.state,
      TextSelection.create(view.state.doc, from, to),
    );
    return range?.mark.attrs.href === anchor.getAttribute("href")
      ? range
      : null;
  }
  function showLinkTip(event: React.PointerEvent<HTMLDivElement>) {
    if (
      event.pointerType !== "mouse" ||
      event.buttons ||
      props.readOnly ||
      link !== null
    )
      return;
    const anchor =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    keepLinkTip();
    if (hoveredLink.current === anchor) return;
    const box = shell.current;
    const view = editorRef.current?.action((ctx) => ctx.get(editorViewCtx));
    const range = view && hoveredRange(view, anchor);
    if (!box || !range) {
      hideLinkTip();
      return;
    }
    const rect = box.getBoundingClientRect();
    const scale = rect.width / box.offsetWidth || 1;
    const lines = anchor.getClientRects();
    if (!lines.length) return;
    hoveredLink.current = anchor;
    setLinkTip({
      href: range.mark.attrs.href,
      left: Math.max(0, (lines[0].left - rect.left) / scale),
      top: (lines[lines.length - 1].bottom - rect.top) / scale + 6,
    });
  }
  function editHoveredLink() {
    const anchor = hoveredLink.current;
    const view = editorRef.current?.action((ctx) => ctx.get(editorViewCtx));
    const range = view && anchor && hoveredRange(view, anchor);
    if (!view || !range) {
      hideLinkTip();
      return;
    }
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, range.to),
      ),
    );
    openLinkForm();
  }
  function linkTarget(state: EditorState) {
    const around = linkAround(state);
    const { from, to } = around ?? state.selection;
    const $from = state.doc.resolve(from);
    let editText =
      $from.parent.isTextblock && $from.sameParent(state.doc.resolve(to));
    state.doc.nodesBetween(from, to, (node) => {
      if (node.isInline && !node.isText) editText = false;
    });
    return {
      from,
      to,
      around,
      editText,
      text: editText ? state.doc.textBetween(from, to) : "",
    };
  }
  function openLinkForm() {
    const view = editorRef.current?.action((ctx) => ctx.get(editorViewCtx));
    if (!view || props.readOnly) return;
    const target = linkTarget(view.state);
    hideLinkTip();
    setLinkError("");
    setLink({
      href: target.around?.mark.attrs.href ?? "",
      text: target.text,
      original: target.text,
      editText: target.editText,
      existing: !!target.around,
    });
  }
  function closeLinkForm() {
    setLink(null);
    editorRef.current?.action((ctx) => ctx.get(editorViewCtx).focus());
  }
  function applyLink(form: LinkForm) {
    const href = form.href.trim();
    if (
      !safeDocumentLink(href) ||
      (props.documentLinks === false && !!documentLinkTarget(href))
    ) {
      setLinkError("https:// 또는 mailto:로 시작하는 주소를 입력하세요.");
      return;
    }
    setLink(null);
    run((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const type = linkSchema.type(ctx);
      const { from, to, around, editText, text: current } = linkTarget(state);
      const mark = type.create({ ...around?.mark.attrs, href });
      const text = form.text.trim() ? form.text : href;
      // The name replaces only the text the form opened on, or fills an
      // empty caret; a selection made since then is linked as it is.
      const rename =
        form.editText &&
        editText &&
        text !== current &&
        (current === form.original || from === to);
      const tr = state.tr;
      if (rename) {
        const marks =
          from < to
            ? (state.doc.nodeAt(from)?.marks ?? [])
            : (state.storedMarks ?? state.selection.$from.marks());
        tr.replaceWith(
          from,
          to,
          state.schema.text(text, mark.addToSet(type.removeFromSet(marks))),
        );
        tr.setSelection(TextSelection.create(tr.doc, from + text.length));
      } else if (from < to)
        tr.removeMark(from, to, type).addMark(from, to, mark);
      else return;
      view.dispatch(tr.scrollIntoView());
    });
  }
  function removeLink() {
    run((ctx) => {
      const view = ctx.get(editorViewCtx);
      const anchor = hoveredLink.current;
      const around = link
        ? linkAround(view.state)
        : anchor && hoveredRange(view, anchor);
      if (around)
        view.dispatch(
          view.state.tr.removeMark(
            around.from,
            around.to,
            linkSchema.type(ctx),
          ),
        );
    });
    if (link) setLink(null);
  }
  function openLink(href: string, event: MouseEvent) {
    const target = parseDocumentLinkPath(href);
    if (props.documentLinks === false && documentLinkTarget(href)) return;
    if (target && linkTitlesRef.current)
      openDocumentLink(
        target,
        event,
        linkTitlesRef.current,
        linkOpener.current,
        setLinkOpenError,
      );
    else window.open(href, "_blank", "noopener,noreferrer");
  }
  // The editor's notice, also used by node views such as code block copy.
  function notify(message: string, failed = false) {
    setNoticeFailed(failed);
    setNotice(message);
  }
  async function copyLink(href: string) {
    try {
      await copyToClipboard(href);
      notify("링크 주소를 복사했습니다.");
    } catch {
      notify("링크 주소를 복사하지 못했습니다. 다시 시도해 주세요.", true);
    }
  }
  const tipVisible = linkTip !== null;
  useLayoutEffect(() => {
    if (!tipVisible) return;
    window.addEventListener("resize", hideLinkTip);
    window.addEventListener("scroll", hideLinkTip, true);
    return () => {
      keepLinkTip();
      window.removeEventListener("resize", hideLinkTip);
      window.removeEventListener("scroll", hideLinkTip, true);
    };
  }, [tipVisible]);
  useLayoutEffect(() => {
    const tip = linkTipBox.current;
    const box = shell.current;
    if (!tip || !box || !linkTip) return;
    const overflow = linkTip.left + tip.offsetWidth - box.clientWidth;
    tip.style.left = `${Math.max(0, linkTip.left - Math.max(0, overflow))}px`;
  }, [linkTip]);
  return {
    linkOpener,
    link,
    setLink,
    linkError,
    linkTip,
    showLinkTip,
    hideLinkTip,
    leaveLinkTip,
    keepLinkTip,
    editHoveredLink,
    linkTipBox,
    linkTitlesRef,
    notice,
    noticeFailed,
    notify,
    linkOpenError,
    setLinkOpenError,
    openLinkForm,
    closeLinkForm,
    applyLink,
    removeLink,
    openLink,
    copyLink,
  };
}
