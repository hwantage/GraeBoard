import type { Ctx } from "@milkdown/kit/ctx";

import {
  isDocumentImage,
  withDocumentImageWidth,
} from "../../../shared/documents/document-images.js";

import { capturedWidth } from "./DocumentImageView";

import { uploadConfig } from "@milkdown/kit/plugin/upload";

import { Decoration } from "@milkdown/kit/prose/view";

import { TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import { type Node } from "@milkdown/kit/prose/model";

import type { RichEditorProps as Props } from "./rich-editor-types";

import type { Transaction } from "@milkdown/kit/prose/state";
function selectAfterImage(state: EditorState, pos: number) {
  const $after = state.doc.resolve(pos + 1);
  const tr = state.tr;
  if ($after.parentOffset < $after.parent.content.size)
    return tr.setSelection(TextSelection.create(tr.doc, $after.pos));
  const end = $after.after();
  const $end = state.doc.resolve(end);
  const next = $end.nodeAfter;
  const { paragraph } = state.schema.nodes;
  if (next?.type === paragraph && next.content.size === 0)
    return tr.setSelection(TextSelection.create(tr.doc, end + 1));
  if (!$end.parent.canReplaceWith($end.index(), $end.index(), paragraph))
    return tr.setSelection(TextSelection.create(tr.doc, $after.pos));
  tr.insert(end, paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, end + 1));
}
export function createDocumentImageUploads(
  latest: React.RefObject<Props>,
  setUploadError: (message: string) => void,
) {
  let active = true;
  const uploads = new Set<AbortController>();
  const pendingImages = new Set<Node>();
  return {
    configure(ctx: Ctx) {
      ctx.update(uploadConfig.key, (options) => ({
        ...options,
        enableHtmlFileUploader: true,
        uploadWidgetFactory: (pos, spec) => {
          const dom = document.createElement("span");
          dom.className = "document-upload-placeholder";
          dom.textContent = "이미지 업로드 중…";
          return Decoration.widget(pos, dom, spec);
        },
        uploader: async (files, schema) => {
          if (!active || latest.current.readOnly || !latest.current.onUpload)
            return [];
          setUploadError("");
          const controller = new AbortController();
          uploads.add(controller);
          latest.current.onUploading?.(uploads.size);
          try {
            const nodes = [];
            for (const file of Array.from(files)) {
              const [url, width] = await Promise.all([
                latest.current.onUpload(file, controller.signal),
                capturedWidth(file),
              ]);
              if (!active || controller.signal.aborted) return [];
              if (!(latest.current.images?.accepts || isDocumentImage)(url))
                throw new Error("이미지 주소를 확인할 수 없습니다.");
              const withWidth =
                latest.current.images?.withWidth || withDocumentImageWidth;
              nodes.push(
                schema.nodes.image.create({
                  src: (width && withWidth(url, width)) || url,
                  alt: file.name.replace(/\.[^.]+$/, "") || "붙여넣은 이미지",
                }),
              );
            }
            for (const node of nodes) pendingImages.add(node);
            return nodes;
          } catch (error) {
            if (active && !controller.signal.aborted)
              setUploadError((error as Error).message);
            return [];
          } finally {
            uploads.delete(controller);
            if (active) latest.current.onUploading?.(uploads.size);
          }
        },
      }));
    },
    appendTransaction(
      transactions: readonly Transaction[],
      _previous: EditorState,
      state: EditorState,
    ) {
      if (!pendingImages.size || !transactions.some((tr) => tr.docChanged))
        return null;
      let inserted = -1;
      state.doc.descendants((node, pos) => {
        if (pendingImages.delete(node)) inserted = pos;
      });
      return inserted < 0
        ? null
        : selectAfterImage(state, inserted).scrollIntoView();
    },
    dispose() {
      active = false;
      pendingImages.clear();
      for (const controller of uploads) controller.abort();
      latest.current.onUploading?.(0);
    },
  };
}
