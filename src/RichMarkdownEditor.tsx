import { useEffect, useRef, useState, type ReactNode } from "react";
import { isDocumentImage } from "../shared/document-images.js";
import { documentImageView, type ImagePreview } from "./DocumentImageView";
import { Button, Modal } from "./components";
import Select from "./Select";
import DocumentLoading from "./DocumentLoading";
import { upload, uploadConfig } from "@milkdown/kit/plugin/upload";
import { Decoration } from "@milkdown/kit/prose/view";
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  parserCtx,
  serializerCtx,
  remarkCtx,
} from "@milkdown/kit/core";
import {
  commonmark,
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  createCodeBlockCommand,
  linkSchema,
} from "@milkdown/kit/preset/commonmark";
import {
  gfm,
  insertTableCommand,
  addRowAfterCommand,
  addColAfterCommand,
  toggleStrikethroughCommand,
} from "@milkdown/kit/preset/gfm";
import {
  history,
  undoCommand,
  redoCommand,
} from "@milkdown/kit/plugin/history";
import { Plugin, TextSelection, type Command } from "@milkdown/kit/prose/state";
import {
  Fragment,
  NodeRange,
  Slice,
  type Node,
} from "@milkdown/kit/prose/model";
import { keydownHandler } from "@milkdown/kit/prose/keymap";
import {
  closeHistory,
  undoDepth,
  redoDepth,
} from "@milkdown/kit/prose/history";
import {
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
  selectedRect,
} from "@milkdown/kit/prose/tables";
import { $prose, callCommand } from "@milkdown/kit/utils";
import type { Ctx } from "@milkdown/kit/ctx";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link,
  Undo2,
  Redo2,
  List,
  ListOrdered,
  ListChecks,
  Table2,
  Maximize2,
  ZoomIn,
} from "lucide-react";
import "@milkdown/kit/prose/view/style/prosemirror.css";

const deleteTableColumn: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  const { left, right, map } = selectedRect(state);
  return (right - left === map.width ? deleteTable : deleteColumn)(
    state,
    dispatch,
  );
};

const deleteTableRow: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  const { top, bottom, map } = selectedRect(state);
  // Milkdown's Markdown table requires a header and at least one body row.
  if (top === 0 || bottom - top === map.height - 1) return false;
  return deleteRow(state, dispatch);
};

type ListFormat = "bullet" | "ordered" | "task";
function listFormatCommand(format: ListFormat): Command {
  return (state, dispatch) => {
    const { schema, selection } = state;
    const { $from, $to } = selection;
    const isList = (node: Node) =>
      node.type === schema.nodes.bullet_list ||
      node.type === schema.nodes.ordered_list;
    let range = $from.blockRange($to);
    // A caret or selection within one list changes that list's depth only.
    for (let depth = $from.sharedDepth($to.pos); depth > 0; depth--) {
      if (isList($from.node(depth))) {
        range = new NodeRange($from, $to, depth - 1);
        break;
      }
    }
    if (!range) return false;
    const { parent, startIndex, endIndex, start, end } = range;
    const type =
      schema.nodes[format === "ordered" ? "ordered_list" : "bullet_list"];
    const first = parent.child(startIndex);
    const attrs = isList(first) ? first.attrs : undefined;
    const order = attrs?.order ?? 1;
    const items: Node[] = [];
    // Map text positions inside the replacement, including backwards ranges.
    // The default replace mapping would collapse the selection to its end.
    const positions: { from: number; to: number; offset: number }[] = [];
    let size = 0;
    const append = (item: Node, from: number, to: number, offset: number) => {
      const checked = format === "task" ? (item.attrs.checked ?? false) : null;
      const listType = format === "ordered" ? "ordered" : "bullet";
      const label = format === "ordered" ? `${order + items.length}.` : "•";
      items.push(
        item.attrs.checked === checked &&
          item.attrs.listType === listType &&
          item.attrs.label === label
          ? item
          : item.type.create(
              { ...item.attrs, checked, listType, label },
              item.content,
              item.marks,
            ),
      );
      positions.push({ from, to, offset: start + 1 + size + offset - from });
      size += item.nodeSize;
    };
    let pos = start;
    for (let index = startIndex; index < endIndex; index++) {
      const block = parent.child(index);
      if (isList(block)) {
        block.forEach((item, offset) => {
          const from = pos + 1 + offset;
          append(item, from, from + item.nodeSize, 0);
        });
      } else if (block.isTextblock) {
        const paragraph = schema.nodes.paragraph.create(null, block.content);
        append(
          schema.nodes.list_item.create(null, paragraph),
          pos,
          pos + block.nodeSize,
          1,
        );
      } else return false;
      pos += block.nodeSize;
    }
    const list = type.create(
      attrs,
      items,
      isList(first) ? first.marks : undefined,
    );
    const content = Fragment.from(list);
    if (!parent.canReplace(startIndex, endIndex, content)) return false;
    if (dispatch && !state.doc.slice(start, end).content.eq(content)) {
      // Build once: one replacement avoids rebuilding the parent per item.
      const tr = state.tr.replaceWith(start, end, list);
      if (selection instanceof TextSelection) {
        const mapPosition = (pos: number) => {
          const part = positions.find(
            ({ from, to }) => pos >= from && pos <= to,
          );
          return part ? pos + part.offset : tr.mapping.map(pos);
        };
        tr.setSelection(
          TextSelection.create(
            tr.doc,
            mapPosition(selection.anchor),
            mapPosition(selection.head),
          ),
        );
      }
      dispatch(closeHistory(tr).scrollIntoView());
    }
    return true;
  };
}
const listFormatKeydown = keydownHandler({
  "Mod-Alt-7": listFormatCommand("ordered"),
  "Mod-Alt-8": listFormatCommand("bullet"),
});

export function safeDocumentLink(url: string) {
  return (
    /^(https?:|mailto:)/i.test(url) &&
    !/[\u0000-\u0020\u007f-\u00a0\u200b-\u200d\u2028\u2029\ufeff]/u.test(url)
  );
}

function isPlainLineBreak(value: unknown): value is string {
  return typeof value === "string" && /^<br\s*\/?\s*>$/i.test(value.trim());
}

// Compare meaning, not choices of delimiters, indentation or table spacing.
// Unrepresented AST nodes must never be silently discarded by rich editing.
function semanticTree(node: any): any {
  if (Array.isArray(node)) return node.map(semanticTree);
  if (!node || typeof node !== "object") return node;
  // Milkdown omits the final empty paragraph (its typing area) when saving.
  // Ignore only trailing empty root paragraphs in this comparison, including
  // <br /> placeholders restored by its remark plugin. Keep interior blanks,
  // nested blocks, table cells and all nonempty content in the loss check.
  if (node.type === "root" && Array.isArray(node.children)) {
    let end = node.children.length;
    while (
      end > 0 &&
      node.children[end - 1].type === "paragraph" &&
      node.children[end - 1].children?.length === 0
    )
      end--;
    node = { ...node, children: node.children.slice(0, end) };
  }
  if (node.type === "html" && isPlainLineBreak(node.value))
    return { type: "html", value: "<br />" };
  return Object.fromEntries(
    Object.keys(node)
      .sort()
      .filter((k) => !["position", "spread", "data"].includes(k))
      .map((k) => [k, semanticTree(node[k])]),
  );
}
function checkMarkdown(ctx: Ctx, markdown: string) {
  const remark = ctx.get(remarkCtx);
  const tree = remark.parse(markdown);
  const supported = new Set([
    "root",
    "paragraph",
    "text",
    "heading",
    "strong",
    "emphasis",
    "delete",
    "inlineCode",
    "code",
    "break",
    "thematicBreak",
    "blockquote",
    "list",
    "listItem",
    "link",
    "image",
    "table",
    "tableRow",
    "tableCell",
  ]);
  function visit(node: any) {
    if (
      !supported.has(node.type) &&
      !(node.type === "html" && isPlainLineBreak(node.value))
    )
      throw new Error(
        "HTML·각주·참조 링크 등은 Markdown 원문에서 편집하세요. 원문은 그대로 보존됩니다.",
      );
    if (node.type === "link" && !safeDocumentLink(node.url))
      throw new Error(
        "HTTP(S)·메일 링크만 리치 편집에서 지원합니다. 원문은 그대로 보존됩니다.",
      );
    if (node.type === "image" && !isDocumentImage(node.url))
      throw new Error(
        "외부 이미지는 Markdown 원문에 보존됩니다. 리치 문서에는 이미지를 직접 붙여넣어 주세요.",
      );
    node.children?.forEach(visit);
  }
  visit(tree);
  const doc = ctx.get(parserCtx)(markdown);
  const roundtrip = ctx.get(serializerCtx)(doc);
  // Validate raw nodes first, then compare through Milkdown's own transforms.
  // Its empty-line plugin restores serializer-generated <br /> placeholders
  // to empty paragraphs/table cells. Raw AST comparison rejects those lines.
  if (
    JSON.stringify(semanticTree(remark.runSync(tree, markdown))) !==
    JSON.stringify(
      semanticTree(remark.runSync(remark.parse(roundtrip), roundtrip)),
    )
  )
    throw new Error(
      "이 구문은 리치 편집으로 변환하면 달라질 수 있어 원문을 유지했습니다. Markdown 원문에서 계속 편집하세요.",
    );
  return doc;
}

function safeClipboardSlice(slice: Slice) {
  let safe = true;
  slice.content.descendants((node) => {
    if (
      (node.type.name === "html" && !isPlainLineBreak(node.attrs.value)) ||
      (node.type.name === "image" && !isDocumentImage(node.attrs.src)) ||
      node.type.name === "footnote_definition" ||
      node.type.name === "footnote_reference" ||
      node.marks.some(
        (mark) =>
          mark.type.name === "link" && !safeDocumentLink(mark.attrs.href),
      )
    )
      safe = false;
    return safe;
  });
  return safe;
}

function tableCellPaste(ctx: Ctx, text: string) {
  const { schema } = ctx.get(editorViewCtx).state;
  // GFM cells hold one paragraph. Store line breaks as supported inline HTML
  // so they stay inside the cell when the document is saved as Markdown.
  const lineBreak = () => schema.nodes.html.create({ value: "<br />" });
  let content: Node[] = [];
  try {
    checkMarkdown(ctx, text).forEach((block, _offset, index) => {
      if (block.type.name !== "paragraph")
        throw new Error("Table cells only support inline formatting.");
      if (index) content.push(lineBreak(), lineBreak());
      block.forEach((node) =>
        content.push(node.type.name === "hardbreak" ? lineBreak() : node),
      );
    });
  } catch {
    // Keep unsupported/block syntax literal, including every line break.
    content = [];
    text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .forEach((line, index) => {
        if (index) content.push(lineBreak());
        if (line) content.push(schema.text(line));
      });
  }
  return new Slice(Fragment.fromArray(content), 0, 0);
}

type Props = {
  label?: string;
  initialMarkdown: string;
  readOnly: boolean;
  saveStatus?: ReactNode;
  onChange: (markdown: string) => void;
  onUnsupported: (message: string) => void;
  onReady: () => void;
  onUpload?: (file: File, signal: AbortSignal) => Promise<string>;
  onUploading?: (count: number) => void;
};
export default function RichMarkdownEditor(props: Props) {
  const root = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [ready, setReady] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [inTable, setInTable] = useState(false);
  const [canDeleteRow, setCanDeleteRow] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  const [imageZoom, setImageZoom] = useState(false);
  useEffect(() => {
    let active = true;
    let initialized = false;
    const uploads = new Set<AbortController>();
    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root.current);
        ctx.set(defaultValueCtx, "");
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
                const url = await latest.current.onUpload(
                  file,
                  controller.signal,
                );
                if (!active || controller.signal.aborted) return [];
                if (!isDocumentImage(url))
                  throw new Error("이미지 주소를 확인할 수 없습니다.");
                nodes.push(
                  schema.nodes.image.create({
                    src: url,
                    alt: file.name.replace(/\.[^.]+$/, "") || "붙여넣은 이미지",
                  }),
                );
              }
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
        ctx.set(editorViewOptionsCtx, {
          editable: () => !latest.current.readOnly,
          attributes: {
            role: "textbox",
            "aria-label": props.label || "업무 문서 리치 편집",
            "aria-multiline": "true",
            spellcheck: "false",
            translate: "no",
          },
          handleDOMEvents: {
            click: (_view, event) => {
              const anchor = (event.target as Element).closest("a");
              if (!anchor) return false;
              event.preventDefault();
              const href = anchor.getAttribute("href") || "";
              if (
                safeDocumentLink(href) &&
                (latest.current.readOnly || event.metaKey || event.ctrlKey)
              )
                window.open(href, "_blank", "noopener,noreferrer");
              return true;
            },
          },
          handleKeyDown: (view, event) => {
            if (latest.current.readOnly || view.composing || event.isComposing)
              return false;
            if (listFormatKeydown(view, event)) return true;
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
            if (!$from.parent.isTextblock || !$from.sameParent($to))
              return false;
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
            // ProseMirror has already parsed HTML through the editor schema.
            // Keep its slice boundaries, marks and table paste handling instead
            // of replacing rich clipboard content with its plain-text fallback.
            if (
              view.state.selection.$from.parent.type.spec.code ||
              (event.clipboardData?.getData("text/html") &&
                safeClipboardSlice(slice))
            )
              return false;
            // Markdown/plain text still uses the same preservation check.
            event.preventDefault();
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
              const doc = checkMarkdown(ctx, text);
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
          nodeViews: {
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
                dom.className = task ? "document-check-item" : "";
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
      .use(gfm)
      .use(history)
      .use(upload)
      .use(
        $prose(
          (ctx) =>
            new Plugin({
              view: () => ({
                update: (view, previous) => {
                  if (active) {
                    setCanUndo(undoDepth(view.state) > 0);
                    setCanRedo(redoDepth(view.state) > 0);
                    setInTable(isInTable(view.state));
                    setCanDeleteRow(deleteTableRow(view.state));
                  }
                  if (active && initialized && !view.state.doc.eq(previous.doc))
                    latest.current.onChange(
                      ctx.get(serializerCtx)(view.state.doc),
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
            checkMarkdown(ctx, latest.current.initialMarkdown),
          );
          editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            view.dispatch(
              view.state.tr
                .replaceWith(0, view.state.doc.content.size, doc.content)
                .setMeta("addToHistory", false),
            );
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
      for (const controller of uploads) controller.abort();
      latest.current.onUploading?.(0);
      editorRef.current = null;
      if (editor.status === "Created") void editor.destroy();
    };
  }, []);
  useEffect(() => {
    editorRef.current?.action((ctx) =>
      ctx.get(editorViewCtx).setProps({ editable: () => !props.readOnly }),
    );
    root.current
      ?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((input) => {
        input.disabled = props.readOnly;
      });
  }, [props.readOnly]);
  function run(action: (ctx: Ctx) => unknown) {
    if (props.readOnly || !editorRef.current) return;
    editorRef.current.action(action);
    editorRef.current.action((ctx) => ctx.get(editorViewCtx).focus());
  }
  const command = (key: any, payload?: any) => run(callCommand(key, payload));
  function removeFromTable(action: Command) {
    run((ctx) => {
      const view = ctx.get(editorViewCtx);
      action(view.state, (tr) =>
        view.dispatch(closeHistory(tr).scrollIntoView()),
      );
    });
  }
  function setListFormat(format: ListFormat) {
    run((ctx) => {
      const view = ctx.get(editorViewCtx);
      listFormatCommand(format)(view.state, view.dispatch, view);
    });
  }
  return (
    <div className="rich-document" data-loading={!ready || undefined}>
      {!ready && <DocumentLoading />}
      {uploadError && (
        <p className="document-error" role="alert">
          {uploadError}
        </p>
      )}
      {!props.readOnly && (
        <div className="document-rich-tools">
          <div
            className="document-formatbar"
            role="group"
            aria-label="문서 서식"
          >
            <Select
              aria-label="문서 블록"
              disabled={!ready}
              defaultValue=""
              onChange={(e) => {
                const value = e.target.value;
                if (value.startsWith("h"))
                  command(wrapInHeadingCommand.key, Number(value.slice(1)));
                else
                  command(
                    {
                      paragraph: turnIntoTextCommand,
                      quote: wrapInBlockquoteCommand,
                      code: createCodeBlockCommand,
                    }[value as "paragraph"].key,
                  );
                e.target.value = "";
              }}
            >
              <option value="" disabled>
                문단 / 블록
              </option>
              <option value="paragraph">본문</option>
              <option value="h1">제목 1</option>
              <option value="h2">제목 2</option>
              <option value="h3">제목 3</option>
              <option value="quote">인용</option>
              <option value="code">코드 블록</option>
            </Select>
            {[
              ["굵게", Bold, () => command(toggleStrongCommand.key)],
              ["기울임", Italic, () => command(toggleEmphasisCommand.key)],
              [
                "취소선",
                Strikethrough,
                () => command(toggleStrikethroughCommand.key),
              ],
              ["인라인 코드", Code, () => command(toggleInlineCodeCommand.key)],
              ["글머리 목록", List, () => setListFormat("bullet")],
              ["번호 목록", ListOrdered, () => setListFormat("ordered")],
              ["체크리스트", ListChecks, () => setListFormat("task")],
              [
                "링크",
                Link,
                () => {
                  setLink("");
                  setLinkError("");
                },
              ],
              [
                "표 삽입",
                Table2,
                () => command(insertTableCommand.key, { row: 3, col: 3 }),
              ],
            ].map(([label, Icon, onClick]: any) => (
              <button
                type="button"
                key={label}
                disabled={!ready}
                aria-label={label}
                data-tooltip={label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={onClick}
              >
                <Icon size={16} />
              </button>
            ))}
            <button
              type="button"
              disabled={!ready || !inTable}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => command(addRowAfterCommand.key)}
            >
              표 행 +
            </button>
            <button
              type="button"
              disabled={!ready || !inTable}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => command(addColAfterCommand.key)}
            >
              표 열 +
            </button>
            <button
              type="button"
              disabled={!ready || !canDeleteRow}
              data-tooltip="선택한 행 삭제 (머리글과 마지막 본문 행 제외)"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => removeFromTable(deleteTableRow)}
            >
              표 행 -
            </button>
            <button
              type="button"
              disabled={!ready || !inTable}
              data-tooltip="선택한 열 삭제 (마지막 열은 표 전체 삭제)"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => removeFromTable(deleteTableColumn)}
            >
              표 열 -
            </button>
            <button
              type="button"
              disabled={!ready || !inTable}
              data-tooltip="현재 표 전체 삭제"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => removeFromTable(deleteTable)}
            >
              표 삭제
            </button>
            <div className="document-history-tools">
              {props.saveStatus}
              {[
                [
                  "문서 실행취소",
                  Undo2,
                  () => command(undoCommand.key),
                  canUndo,
                ],
                ["문서 재실행", Redo2, () => command(redoCommand.key), canRedo],
              ].map(([label, Icon, onClick, enabled]: any) => (
                <button
                  type="button"
                  key={label}
                  disabled={!ready || !enabled}
                  aria-label={label}
                  data-tooltip={label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={onClick}
                >
                  <Icon size={16} />
                </button>
              ))}
            </div>
          </div>
          {link !== null && (
            <form
              className="document-link-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!safeDocumentLink(link)) {
                  setLinkError(
                    "https:// 또는 mailto:로 시작하는 주소를 입력하세요.",
                  );
                  return;
                }
                run((ctx) => {
                  const view = ctx.get(editorViewCtx),
                    { from, to } = view.state.selection;
                  let tr = view.state.tr;
                  if (from === to) tr = tr.insertText(link, from);
                  view.dispatch(
                    tr
                      .addMark(
                        from,
                        from === to ? from + link.length : to,
                        linkSchema.type(ctx).create({ href: link }),
                      )
                      .scrollIntoView(),
                  );
                });
                setLink(null);
              }}
            >
              <label>
                링크 주소{" "}
                <input
                  autoFocus
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="https://"
                />
              </label>
              <button type="submit">적용</button>
              <button type="button" onClick={() => setLink(null)}>
                취소
              </button>
              {linkError && <span role="alert">{linkError}</span>}
            </form>
          )}
        </div>
      )}
      <div
        ref={root}
        className="document-prose"
        data-readonly={props.readOnly || undefined}
      />
      {preview && (
        <Modal
          title="이미지 크게 보기"
          onClose={() => setPreview(null)}
          className="document-image-modal"
        >
          <div className="document-image-view-controls">
            <Button onClick={() => setImageZoom((value) => !value)}>
              {imageZoom ? <Maximize2 size={16} /> : <ZoomIn size={16} />}
              {imageZoom ? "화면에 맞추기" : "실제 크기"}
            </Button>
          </div>
          <div
            className={`document-image-canvas${imageZoom ? " actual-size" : ""}`}
          >
            <img src={preview.src} alt={preview.alt} />
          </div>
        </Modal>
      )}
    </div>
  );
}
