import { createDocumentImageUploads } from "./document-image-uploads";
import { documentEditorInput } from "./document-editor-input";
import { configureDocumentInputRules } from "./DocumentInputRules";
import { documentLinkTitle } from "./DocumentLinkTitle";
import { useEffect, useRef, useState } from "react";
import {
  placeIn,
  scrollAround,
  visibleBounds,
} from "../document-scroll-anchor";
import { documentPositions, markdownOffsets } from "./document-source-position";

import { parseDocumentLinkPath } from "../../../shared/documents/document-links.js";
import { DocumentLinkTitles, documentLinkTarget } from "../document-links";
import {
  documentLinkSchema,
  documentLinkView,
  openDocumentLink,
} from "./DocumentLinkNode";
import {
  documentImageView,
  imageCaret,
  imageComposition,
  withoutImageSpacer,
  type ImagePreview,
} from "./DocumentImageView";
import { imageOriginals } from "./document-image-original";
import {
  documentCodeBlockSelection,
  documentCodeBlockView,
} from "./DocumentCodeBlockView";

import {
  blockDrag,
  blockSelect,
  type BlockHandleApi,
} from "./DocumentBlockHandle";
import { type TocApi } from "./DocumentToc";

import { remarkToggle, toggle, toggleSummaryView } from "./DocumentToggle";
import { upload } from "@milkdown/kit/plugin/upload";
import { trailing, trailingConfig } from "@milkdown/kit/plugin/trailing";

import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { Fragment } from "@milkdown/kit/prose/model";

import { dropCursor } from "@milkdown/kit/prose/dropcursor";
import { undoDepth, redoDepth } from "@milkdown/kit/prose/history";
import { isInTable } from "@milkdown/kit/prose/tables";
import { $prose } from "@milkdown/kit/utils";
import type { EditorView } from "@milkdown/kit/prose/view";

import type {
  DocumentPlace,
  RemoteMarkdown,
  RichEditorProps as Props,
} from "./rich-editor-types";

import {
  replaceChangedBlocks,
  needsTrailingParagraph,
  codeBlockMetaSchema,
  safeDocumentLink,
  isPlainLineBreak,
  remarkTableShape,
  checkMarkdown,
  configureTextEscapes,
} from "./document-markdown";
import { deleteTableRow } from "./document-editor-commands";
import type useDocumentLinkActions from "./useDocumentLinkActions";
import type useDocumentSlash from "./useDocumentSlash";
// Shows where a dragged image or text lands, between characters or between
// blocks, at the point the drop itself uses. Milkdown's cursor plugin would
// also add a gap cursor and drop images only between blocks.
const dropIndicator = $prose(() =>
  dropCursor({ color: false, width: 2, class: "document-drop-cursor" }),
);
// Uploaded images land at the end of their paragraph without a visible caret.
// Continue typing in the paragraph below, creating it when needed.

// The caret when it is on screen, otherwise the text at the top of the view,
// and its viewport height. A tall block, such as an image, starting above the
// view counts from the view's top.
function shownPosition(view: EditorView) {
  const { head } = view.state.selection;
  const { top, bottom } = visibleBounds(view.dom);
  const caret = view.coordsAtPos(head);
  if (caret.top >= top && caret.bottom <= bottom)
    return { pos: head, top: caret.top };
  const box = view.dom.getBoundingClientRect();
  const pos =
    view.posAtCoords({
      left: box.left + Math.min(40, box.width / 2),
      top: Math.max(top, box.top) + 1,
    })?.pos ?? head;
  return { pos, top: Math.max(top, view.coordsAtPos(pos).top) };
}

export default function useRichEditorLifecycle(
  props: Props,
  {
    root,
    editorRef,
    latest,
    links,
    slashMenu,
    blockHandle,
    toc,
    setPreview,
    setImageZoom,
  }: {
    root: React.RefObject<HTMLDivElement | null>;
    editorRef: React.RefObject<Editor | null>;
    latest: React.RefObject<Props>;
    links: ReturnType<typeof useDocumentLinkActions>;
    slashMenu: ReturnType<typeof useDocumentSlash>;
    blockHandle: React.RefObject<BlockHandleApi | null>;
    toc: React.RefObject<TocApi | null>;
    setPreview: React.Dispatch<React.SetStateAction<ImagePreview | null>>;
    setImageZoom: React.Dispatch<React.SetStateAction<boolean>>;
  },
) {
  const {
    linkTitlesRef,
    linkOpener,
    hideLinkTip,
    setLink,
    setLinkOpenError,
    notify,
  } = links;
  const { closeSlash, syncSlash } = slashMenu;
  const applyingRemote = useRef(false);
  const appliedRemote = useRef(props.remoteMarkdown);
  // The text to bring back to its height on screen once the editor shows.
  const shownAt = useRef<{ pos: number; top: number; focus: boolean } | null>(
    null,
  );
  const [ready, setReady] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [inTable, setInTable] = useState(false);
  const [canDeleteRow, setCanDeleteRow] = useState(false);
  const [uploadError, setUploadError] = useState("");
  useEffect(() => {
    let active = true;
    let initialized = false;
    const imageUploads = createDocumentImageUploads(latest, setUploadError);
    const linkTitles = new DocumentLinkTitles();
    linkTitlesRef.current = linkTitles;
    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root.current);
        ctx.set(defaultValueCtx, "");
        imageUploads.configure(ctx);
        ctx.set(trailingConfig.key, {
          shouldAppend: needsTrailingParagraph,
          getNode: (state) => state.schema.nodes.paragraph.create(),
        });
        configureDocumentInputRules(ctx);
        configureTextEscapes(ctx);
        ctx.set(editorViewOptionsCtx, {
          ...documentEditorInput(ctx, {
            latest,
            blockHandle,
            slashMenu,
            links,
            linkTitles,
          }),
          editable: () => !latest.current.readOnly,
          attributes: {
            role: "textbox",
            "aria-label": props.label || "업무 문서 리치 편집",
            "aria-multiline": "true",
            spellcheck: "false",
            translate: "no",
          },

          handleDOMEvents: {
            keydown: (_view, event) =>
              latest.current.readOnly && event.key === "Tab",
            blur: () => {
              closeSlash();
              return false;
            },
            click: (_view, event) => {
              const anchor = (event.target as Element).closest("a");
              if (!anchor) return false;
              event.preventDefault();
              const href = anchor.getAttribute("href") || "";
              const target = parseDocumentLinkPath(href);
              if (
                latest.current.documentLinks === false &&
                documentLinkTarget(href)
              )
                return true;
              if (target)
                openDocumentLink(
                  target,
                  event,
                  linkTitles,
                  linkOpener.current,
                  (message) => active && setLinkOpenError(message),
                );
              // A click opens a web link; selecting its text by dragging
              // does not.
              else if (
                safeDocumentLink(href) &&
                (latest.current.readOnly ||
                  event.metaKey ||
                  event.ctrlKey ||
                  document.getSelection()?.isCollapsed !== false)
              )
                window.open(href, "_blank", "noopener,noreferrer");
              return true;
            },
          },

          nodeViews: {
            code_block: (node, view, getPos) =>
              documentCodeBlockView(node, view, getPos, notify),
            document_link: (node) => {
              if (latest.current.documentLinks !== false)
                return documentLinkView(node, linkTitles);
              const dom = document.createElement("span");
              dom.textContent = node.attrs.text;
              return { dom };
            },
            image: (node, view, getPos) =>
              documentImageView(
                node,
                view,
                getPos,
                () => latest.current.readOnly,
                (image) => {
                  setImageZoom(false);
                  setPreview(image);
                },
                latest.current.images,
                imageUploads.uploadEdited,
              ),
            toggle_summary: (node, view, getPos) =>
              toggleSummaryView(
                node,
                view,
                getPos,
                () => latest.current.readOnly,
              ),
            html: (node) => {
              // Only attribute-free breaks become DOM elements. All other
              // HTML stays text, including nodes introduced by a DOM paste.
              const isBreak = isPlainLineBreak(node.attrs.value);
              const dom = document.createElement(isBreak ? "br" : "span");
              if (!isBreak) dom.textContent = node.attrs.value;
              return { dom };
            },
            list_item: (node, view, getPos) => {
              const dom = document.createElement("li");
              const contentDOM = document.createElement("div");
              const checkbox = document.createElement("input");
              checkbox.type = "checkbox";
              checkbox.contentEditable = "false";
              checkbox.setAttribute("aria-label", "체크리스트 완료");
              const update = (next: typeof node) => {
                if (next.type !== node.type) return false;
                node = next;
                const task = node.attrs.checked != null;
                // Keep classes from decorations, such as selected blocks.
                dom.classList.toggle("document-check-item", task);
                checkbox.hidden = !task;
                checkbox.checked = !!node.attrs.checked;
                checkbox.disabled = latest.current.readOnly;
                return true;
              };
              checkbox.addEventListener("change", () => {
                const pos = getPos();
                if (pos === undefined || latest.current.readOnly) return;
                view.dispatch(
                  view.state.tr.setNodeMarkup(pos, undefined, {
                    ...node.attrs,
                    checked: checkbox.checked,
                  }),
                );
              });
              dom.append(checkbox, contentDOM);
              update(node);
              return {
                dom,
                contentDOM,
                update,
                stopEvent: (event) => event.target === checkbox,
                ignoreMutation: (mutation) =>
                  mutation.type !== "selection" &&
                  (mutation.target === checkbox || mutation.target === dom),
              };
            },
          },
        });
      })
      .use(commonmark)
      .use(codeBlockMetaSchema)
      .use(documentCodeBlockSelection)
      .use(gfm)
      .use(documentLinkTitle)
      .use(documentLinkSchema)
      .use(toggle)
      .use(remarkToggle)
      .use(remarkTableShape)
      .use(history)
      .use(upload)
      .use(trailing)
      .use(blockDrag)
      .use(blockSelect)
      .use(imageCaret)
      .use(imageComposition)
      .use(imageOriginals)
      .use(dropIndicator)
      .use(
        $prose(
          (ctx) =>
            new Plugin({
              appendTransaction: imageUploads.appendTransaction,
              view: () => ({
                update: (view, previous) => {
                  if (active) {
                    setCanUndo(undoDepth(view.state) > 0);
                    setCanRedo(redoDepth(view.state) > 0);
                    setInTable(isInTable(view.state));
                    setCanDeleteRow(deleteTableRow(view.state));
                    syncSlash(view);
                    if (view.state.doc !== previous.doc) hideLinkTip();
                    blockHandle.current?.update(view, previous);
                    toc.current?.update(view, previous);
                  }
                  if (
                    active &&
                    initialized &&
                    !applyingRemote.current &&
                    !view.state.doc.eq(previous.doc)
                  )
                    latest.current.onChange(
                      ctx.get(serializerCtx)(withoutImageSpacer(view.state)),
                    );
                },
              }),
            }),
        ),
      );
    void editor
      .create()
      .then(() => {
        if (!active) return editor.destroy();
        try {
          const doc = editor.action((ctx) =>
            checkMarkdown(ctx, latest.current.initialMarkdown, latest.current),
          );
          editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const tr = view.state.tr
              .replaceWith(0, view.state.doc.content.size, doc.content)
              .setMeta("addToHistory", false);
            // Continue where the Markdown source was.
            const initialPlace = latest.current.initialPlace;
            const place =
              initialPlace &&
              placeIn(initialPlace, latest.current.initialMarkdown);
            if (place) {
              const [anchor, head, shown] = documentPositions(
                ctx,
                doc,
                latest.current.initialMarkdown,
                [place.anchor, place.head, place.view.offset],
              );
              if (anchor != null && head != null)
                tr.setSelection(TextSelection.create(tr.doc, anchor, head));
              if (shown != null || place.focus)
                shownAt.current = {
                  pos: shown ?? tr.selection.head,
                  top: shown != null ? place.view.top : NaN,
                  focus: !!place.focus,
                };
            }
            view.dispatch(tr);
          });
          editorRef.current = editor;
          initialized = true;
          setReady(true);
          latest.current.onReady();
        } catch (error) {
          latest.current.onUnsupported((error as Error).message);
        }
      })
      .catch((error) => {
        if (active)
          latest.current.onUnsupported(
            `리치 편집기를 열지 못했습니다. 원문에서 계속 편집할 수 있습니다. ${(error as Error).message}`,
          );
      });
    return () => {
      active = false;
      linkTitlesRef.current = null;
      linkTitles.dispose();
      imageUploads.dispose();
      editorRef.current = null;
      if (editor.status === "Created") void editor.destroy();
    };
  }, []);
  // After the host shows the editor, its layout is final.
  useEffect(() => {
    const shown = shownAt.current;
    if (!ready || !shown) return;
    shownAt.current = null;
    const frame = requestAnimationFrame(() =>
      editorRef.current?.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (shown.pos > view.state.doc.content.size) return;
        if (!Number.isNaN(shown.top))
          scrollAround(view.dom, view.coordsAtPos(shown.pos).top, shown.top);
        // The caret stays where the selection was placed; focusing does not
        // scroll to it.
        if (shown.focus && view.editable) view.focus();
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [ready]);
  function place(markdown: string): DocumentPlace | null {
    return (
      editorRef.current?.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { anchor, head } = view.state.selection;
        const shown = shownPosition(view);
        const [from, to, offset] = markdownOffsets(
          ctx,
          view.state,
          [anchor, head, shown.pos],
          markdown,
        );
        return from == null || to == null || offset == null
          ? null
          : {
              markdown,
              anchor: from,
              head: to,
              view: { offset, top: shown.top },
            };
      }) ?? null
    );
  }
  function applyRemote(remote: RemoteMarkdown) {
    if (appliedRemote.current === remote || !editorRef.current) return;
    appliedRemote.current = remote;
    try {
      applyingRemote.current = true;
      editorRef.current.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const parsed = checkMarkdown(ctx, remote.markdown, latest.current);
        // Compare against the same trailing paragraph the view keeps so a
        // caret resting there is not moved by every remote save.
        const doc = needsTrailingParagraph(parsed.lastChild)
          ? parsed.copy(
              parsed.content.append(
                Fragment.from(view.state.schema.nodes.paragraph.create()),
              ),
            )
          : parsed;
        const tr = replaceChangedBlocks(view.state.tr, doc);
        if (tr.docChanged) view.dispatch(tr.setMeta("addToHistory", false));
      });
    } catch (error) {
      latest.current.onUnsupported((error as Error).message);
    } finally {
      applyingRemote.current = false;
    }
  }
  useEffect(() => {
    if (ready && props.remoteMarkdown) applyRemote(props.remoteMarkdown);
  }, [ready, props.remoteMarkdown]);
  useEffect(() => {
    if (props.readOnly) {
      closeSlash();
      setLink(null);
      hideLinkTip();
    }
    editorRef.current?.action((ctx) =>
      ctx.get(editorViewCtx).setProps({ editable: () => !props.readOnly }),
    );
    root.current
      ?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((input) => {
        input.disabled = props.readOnly;
      });
  }, [props.readOnly]);
  return {
    ready,
    canUndo,
    canRedo,
    inTable,
    canDeleteRow,
    uploadError,
    applyRemote,
    place,
  };
}
