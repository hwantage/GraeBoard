import { useRef, useState } from "react";

import {
  filterSlashItems,
  slashMatch,
  type SlashItem,
  type SlashMatch,
} from "./DocumentSlashMenu";

import { type EditorView } from "@milkdown/kit/prose/view";
import { Editor, editorViewCtx } from "@milkdown/kit/core";

import type { RichEditorProps as Props } from "./rich-editor-types";
export default function useDocumentSlash({
  editorRef,
  latest,
  shell,
}: {
  editorRef: React.RefObject<Editor | null>;
  latest: React.RefObject<Props>;
  shell: React.RefObject<HTMLDivElement | null>;
}) {
  type SlashState = SlashMatch & { left: number; top: number; flip: boolean };
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashRef = useRef<SlashState | null>(null);
  const slashItemsRef = useRef<SlashItem[]>([]);
  const slashIndexRef = useRef(0);
  const dismissedSlash = useRef<number | null>(null);
  function closeSlash(dismiss = false) {
    dismissedSlash.current = dismiss ? (slashRef.current?.from ?? null) : null;
    if (!slashRef.current) return;
    slashRef.current = null;
    setSlash(null);
  }
  function applySlash(item: SlashItem) {
    const match = slashRef.current;
    if (!match || !editorRef.current || latest.current.readOnly) return;
    closeSlash();
    editorRef.current.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.delete(match.from, match.to));
    });
    item.run();
  }
  function slashKeydown(event: KeyboardEvent) {
    const items = slashItemsRef.current;
    if (!slashRef.current || !items.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : items.length - 1;
      slashIndexRef.current = (slashIndexRef.current + step) % items.length;
      setSlashIndex(slashIndexRef.current);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      applySlash(items[slashIndexRef.current] || items[0]);
      return true;
    }
    if (event.key === "Escape") {
      closeSlash(true);
      return true;
    }
    return false;
  }
  function syncSlash(view: EditorView) {
    const match = latest.current.readOnly ? null : slashMatch(view.state);
    if (!match) return closeSlash();
    if (dismissedSlash.current === match.from) return;
    dismissedSlash.current = null;
    const coords = view.coordsAtPos(match.from);
    const rect = shell.current?.getBoundingClientRect();
    if (!rect) return;
    const flip = coords.bottom + 280 > window.innerHeight;
    const next = {
      ...match,
      left: Math.max(0, Math.min(coords.left - rect.left, rect.width - 220)),
      top: (flip ? coords.top - 4 : coords.bottom + 4) - rect.top,
      flip,
    };
    const current = slashRef.current;
    if (
      current &&
      (["from", "to", "query", "left", "top", "flip"] as const).every(
        (key) => current[key] === next[key],
      )
    )
      return;
    if (current?.from !== next.from) {
      slashIndexRef.current = 0;
      setSlashIndex(0);
    }
    slashRef.current = next;
    setSlash(next);
  }
  function updateItems(all: SlashItem[]) {
    const items = slash ? filterSlashItems(all, slash.query) : [];
    slashItemsRef.current = items;
    const active = Math.min(slashIndex, Math.max(0, items.length - 1));
    slashIndexRef.current = active;
    return { items, active };
  }
  function hover(index: number) {
    slashIndexRef.current = index;
    setSlashIndex(index);
  }
  return {
    slash,
    closeSlash,
    applySlash,
    slashKeydown,
    syncSlash,
    updateItems,
    hover,
  };
}
