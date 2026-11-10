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
function linkAround(state: EditorState): LinkRange | null {
  const type = state.schema.marks.link;
  const { selection } = state;
  const { $from, $to } = selection;
  if (!type || !(selection instanceof TextSelection) || !$from.sameParent($to))
    return null;
  const parent = $from.parent;
  const offset = $from.parentOffset;
  let mark: Mark | null | undefined = null;
  let index = -1;
  for (const hit of [
    offset ? parent.childBefore(offset) : null,
    parent.childAfter(offset),
  ]) {
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
  latest,
  shell,
  run,
}: {
  editorRef: React.RefObject<Editor | null>;
  latest: React.RefObject<Props>;
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
  };
  const [link, setLink] = useState<LinkForm | null>(null);
  const linkFormOpen = useRef(false);
  const [linkError, setLinkError] = useState("");
  type LinkTip = { href: string; left: number; top: number };
  const [linkTip, setLinkTip] = useState<LinkTip | null>(null);
  const linkTipRef = useRef<LinkTip | null>(null);
  const linkTipBox = useRef<HTMLDivElement>(null);
  const linkTitlesRef = useRef<DocumentLinkTitles | null>(null);
  const [notice, notify] = useToast();
  const [noticeFailed, setNoticeFailed] = useState(false);
  const [linkOpenError, setLinkOpenError] = useState("");
  linkOpener.current = documentLinks;
  linkFormOpen.current = link !== null;
  function syncLinkTip(view: EditorView, focused = view.hasFocus()) {
    const range =
      focused && !latest.current.readOnly && !linkFormOpen.current
        ? linkAround(view.state)
        : null;
    const box = shell.current;
    let next: LinkTip | null = null;
    if (range && box) {
      const rect = box.getBoundingClientRect();
      const scale = rect.width / box.offsetWidth || 1;
      const start = view.coordsAtPos(range.from, 1);
      const end = view.coordsAtPos(range.to, -1);
      next = {
        href: range.mark.attrs.href,
        left: Math.max(0, (start.left - rect.left) / scale),
        top: (end.bottom - rect.top) / scale + 6,
      };
    }
    const current = linkTipRef.current;
    if (
      current === next ||
      (current &&
        next &&
        current.href === next.href &&
        Math.abs(current.left - next.left) < 0.5 &&
        Math.abs(current.top - next.top) < 0.5)
    )
      return;
    linkTipRef.current = next;
    setLinkTip(next);
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
    linkTipRef.current = null;
    setLinkTip(null);
    setLinkError("");
    setLink({
      href: target.around?.mark.attrs.href ?? "",
      text: target.text,
      original: target.text,
      editText: target.editText,
    });
  }
  function closeLinkForm() {
    linkFormOpen.current = false;
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
    linkFormOpen.current = false;
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
      const around = linkAround(view.state);
      if (around)
        view.dispatch(
          view.state.tr.removeMark(
            around.from,
            around.to,
            linkSchema.type(ctx),
          ),
        );
    });
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
  async function copyLink(href: string) {
    try {
      await copyToClipboard(href);
      setNoticeFailed(false);
      notify("링크 주소를 복사했습니다.");
    } catch {
      setNoticeFailed(true);
      notify("링크 주소를 복사하지 못했습니다. 다시 시도해 주세요.");
    }
  }
  useLayoutEffect(() => {
    const sync = () => {
      const view = editorRef.current?.action((ctx) => ctx.get(editorViewCtx));
      if (view) syncLinkTip(view);
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [link === null]);
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
    setLinkTip,
    linkTipRef,
    linkTipBox,
    linkTitlesRef,
    notice,
    noticeFailed,
    linkOpenError,
    setLinkOpenError,
    syncLinkTip,
    openLinkForm,
    closeLinkForm,
    applyLink,
    removeLink,
    openLink,
    copyLink,
  };
}
