import type { Ctx } from "@milkdown/kit/ctx";
import { documentInputKeydown } from "./DocumentInputRules";
import { pasteExternalLink } from "./DocumentLinkTitle";

import { DocumentLinkTitles } from "../document-links";
import { pasteDocumentLink } from "./DocumentLinkNode";

import {
  blockMoveKeydown,
  blockSelectKeydown,
  type BlockHandleApi,
} from "./DocumentBlockHandle";

import { toggleKeydown } from "./DocumentToggle";

import { isInTable } from "@milkdown/kit/prose/tables";

import type { RichEditorProps as Props } from "./rich-editor-types";
import {
  checkMarkdown,
  safeClipboardSlice,
  clipboardMarkdown,
  tableCellPaste,
} from "./document-markdown";
import { listFormatKeydown } from "./document-editor-commands";
import type useDocumentLinkActions from "./useDocumentLinkActions";
import type useDocumentSlash from "./useDocumentSlash";
import type { EditorProps } from "@milkdown/kit/prose/view";
export function documentEditorInput(
  ctx: Ctx,
  {
    latest,
    blockHandle,
    slashMenu,
    links,
    linkTitles,
  }: {
    latest: React.RefObject<Props>;
    blockHandle: React.RefObject<BlockHandleApi | null>;
    slashMenu: ReturnType<typeof useDocumentSlash>;
    links: ReturnType<typeof useDocumentLinkActions>;
    linkTitles: DocumentLinkTitles;
  },
): Pick<
  EditorProps,
  "handleKeyDown" | "handlePaste" | "handleDrop" | "clipboardTextSerializer"
> {
  const { slashKeydown } = slashMenu;
  const { linkTipRef, setLinkTip } = links;
  return {
    clipboardTextSerializer: (slice) => clipboardMarkdown(ctx, slice),
    handleKeyDown: (view, event) => {
      if (latest.current.readOnly || view.composing || event.isComposing)
        return false;
      if (blockHandle.current?.keydown(event)) return true;
      if (slashKeydown(event)) return true;
      if (blockSelectKeydown(view, event)) return true;
      if (documentInputKeydown(view, event)) return true;
      if (toggleKeydown(view, event)) return true;
      if (listFormatKeydown(view, event)) return true;
      if (blockMoveKeydown(view, event)) return true;
      if (event.key === "Escape") {
        if (linkTipRef.current) {
          linkTipRef.current = null;
          setLinkTip(null);
        } else {
          const focused = document.activeElement;
          if (focused instanceof HTMLElement && view.dom.contains(focused))
            focused.blur();
        }
        event.stopPropagation();
        return true;
      }
      if (
        event.key !== "Enter" ||
        !event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        !isInTable(view.state)
      )
        return false;
      const { $from, $to } = view.state.selection;
      if (!$from.parent.isTextblock || !$from.sameParent($to)) return false;
      // GFM cells need an inline <br />; a Markdown hardbreak would
      // split the table's source row and Milkdown filters it out.
      view.dispatch(
        view.state.tr
          .replaceSelectionWith(
            view.state.schema.nodes.html.create({ value: "<br />" }),
          )
          .scrollIntoView(),
      );
      return true;
    },
    handlePaste: (view, event, slice) => {
      if (event.clipboardData?.files?.length) {
        if (latest.current.readOnly) {
          event.preventDefault();
          return true;
        }
        return false; // Milkdown's upload plugin handles clipboard files.
      }
      const text = event.clipboardData?.getData("text/plain");
      if (text === undefined || latest.current.readOnly) return false;
      if (!view.state.selection.$from.parent.type.spec.code) {
        if (
          pasteDocumentLink(view, text, linkTitles) ||
          pasteExternalLink(view, text, latest.current.linkTitles !== false)
        ) {
          event.preventDefault();
          return true;
        }
      }
      // ProseMirror has already parsed HTML through the editor schema.
      // Keep its slice boundaries, marks and table paste handling instead
      // of replacing rich clipboard content with its plain-text fallback.
      if (
        view.state.selection.$from.parent.type.spec.code ||
        (event.clipboardData?.getData("text/html") &&
          safeClipboardSlice(slice, latest.current))
      )
        return false;
      // Markdown/plain text still uses the same preservation check.
      event.preventDefault();
      if (
        latest.current.documentLinks !== false &&
        pasteDocumentLink(view, text, linkTitles)
      )
        return true;
      const { $from, $to } = view.state.selection;
      if (
        isInTable(view.state) &&
        $from.parent.isTextblock &&
        $from.sameParent($to)
      ) {
        view.dispatch(
          view.state.tr
            .replaceSelection(tableCellPaste(ctx, text))
            .scrollIntoView(),
        );
        return true;
      }
      try {
        const doc = checkMarkdown(ctx, text, latest.current);
        view.dispatch(
          view.state.tr.replaceSelection(doc.slice(0)).scrollIntoView(),
        );
      } catch {
        view.dispatch(view.state.tr.insertText(text).scrollIntoView());
      }
      return true;
    },
    handleDrop: (_view, event) => {
      if (latest.current.readOnly && event.dataTransfer?.files?.length) {
        event.preventDefault();
        return true;
      }
      return false;
    },
  };
}
