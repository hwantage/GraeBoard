import useDocumentLinkActions from "./useDocumentLinkActions";
import useDocumentSlash from "./useDocumentSlash";
import useRichEditorLifecycle from "./useRichEditorLifecycle";
import {
  deleteTableColumn,
  deleteTableRow,
  listFormatCommand,
  blockCommand,
  type ListFormat,
} from "./document-editor-commands";
import type { RichEditorProps as Props } from "./rich-editor-types";
import { useRef, useState, type ReactNode } from "react";
import { type ImagePreview } from "./DocumentImageView";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import Toast from "../../ui/Toast";
import Select from "../../ui/Select";
import DocumentLoading from "../DocumentLoading";
import DocumentToolMenu from "../DocumentToolMenu";
import DocumentBlockHandle, {
  BLOCK_FORMATS,
  type BlockHandleApi,
} from "./DocumentBlockHandle";
import DocumentToc, { type TocApi } from "./DocumentToc";
import DocumentSlashMenu, { type SlashItem } from "./DocumentSlashMenu";
import { TOGGLE_LEVELS } from "./DocumentToggle";
import { Editor, editorViewCtx, commandsCtx } from "@milkdown/kit/core";
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  createCodeBlockCommand,
  insertHrCommand,
} from "@milkdown/kit/preset/commonmark";
import {
  insertTableCommand,
  addRowAfterCommand,
  addColAfterCommand,
  toggleStrikethroughCommand,
} from "@milkdown/kit/preset/gfm";
import { undoCommand, redoCommand } from "@milkdown/kit/plugin/history";
import { TextSelection, type Command } from "@milkdown/kit/prose/state";
import { closeHistory } from "@milkdown/kit/prose/history";
import { deleteTable } from "@milkdown/kit/prose/tables";
import { callCommand } from "@milkdown/kit/utils";
import type { Ctx } from "@milkdown/kit/ctx";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Copy,
  ExternalLink,
  Link,
  Pencil,
  Unlink,
  Undo2,
  Redo2,
  List,
  ListOrdered,
  ListChecks,
  ListCollapse,
  Table2,
  Maximize2,
  ZoomIn,
  Pilcrow,
  Heading1,
  Heading2,
  Heading3,
  Quote,
  SquareCode,
  Workflow,
  Minus,
  BetweenHorizontalStart,
  BetweenVerticalStart,
  TableRowsSplit,
  TableColumnsSplit,
  Trash2,
} from "lucide-react";
import "@milkdown/kit/prose/view/style/prosemirror.css";

export default function RichMarkdownEditor(props: Props) {
  const root = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);

  const latest = useRef(props);
  latest.current = props;

  const [preview, setPreview] = useState<ImagePreview | null>(null);
  const [imageZoom, setImageZoom] = useState(false);

  const shell = useRef<HTMLDivElement>(null);

  const blockHandle = useRef<BlockHandleApi>(null);
  const toc = useRef<TocApi>(null);

  const links = useDocumentLinkActions({
    props,
    editorRef,
    latest,
    shell,
    run,
  });
  const {
    link,
    setLink,
    linkError,
    linkTip,
    setLinkTip,
    linkTipRef,
    linkTipBox,
    notice,
    noticeFailed,
    linkOpenError,
    openLinkForm,
    closeLinkForm,
    applyLink,
    removeLink,
    openLink,
    copyLink,
  } = links;
  const slashMenu = useDocumentSlash({ editorRef, latest, shell });
  const { slash, closeSlash, applySlash } = slashMenu;
  const { ready, canUndo, canRedo, inTable, canDeleteRow, uploadError } =
    useRichEditorLifecycle(props, {
      root,
      editorRef,
      latest,
      links,
      slashMenu,
      blockHandle,
      toc,
      setPreview,
      setImageZoom,
    });

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

  function setBlock(value: string) {
    run((ctx) => {
      const view = ctx.get(editorViewCtx);
      blockCommand(ctx, value)?.(view.state, view.dispatch, view);
    });
  }
  const slashEntries: [string, string, string, ReactNode][] = [
    ["paragraph", "본문", "text p", <Pilcrow size={16} />],
    ["h1", "제목 1", "heading h1", <Heading1 size={16} />],
    ["h2", "제목 2", "heading h2", <Heading2 size={16} />],
    ["h3", "제목 3", "heading h3", <Heading3 size={16} />],
    ["bullet", "글머리 목록", "list ul 목록", <List size={16} />],
    ["ordered", "번호 목록", "list ol 번호 목록", <ListOrdered size={16} />],
    ["task", "체크리스트", "todo task check 할 일", <ListChecks size={16} />],
    ["quote", "인용", "quote blockquote", <Quote size={16} />],
    ["code", "코드 블록", "code pre", <SquareCode size={16} />],
    [
      "mermaid",
      "Mermaid 다이어그램",
      "diagram chart 순서도",
      <Workflow size={16} />,
    ],
    ["table", "표", "table", <Table2 size={16} />],
    ["hr", "구분선", "divider hr rule 구분 선", <Minus size={16} />],
    ["toggle0", "토글", "toggle details 접기", <ListCollapse size={16} />],
    ...TOGGLE_LEVELS.map((level): [string, string, string, ReactNode] => [
      `toggle${level}`,
      `토글 제목 ${level}`,
      `toggle heading h${level} 토글제목`,
      <ListCollapse size={16} />,
    ]),
    ["link", "링크", "link url", <Link size={16} />],
  ];
  const slashItems: SlashItem[] = slashEntries.map(
    ([id, label, keywords, icon]) => ({
      id,
      label,
      keywords,
      icon,
      run: () => {
        if (id === "bullet" || id === "ordered" || id === "task")
          setListFormat(id);
        else if (id === "table")
          command(insertTableCommand.key, { row: 3, col: 3 });
        else if (id === "hr") command(insertHrCommand.key);
        else if (id === "link") openLinkForm();
        else if (id === "mermaid")
          run((ctx) => {
            const view = ctx.get(editorViewCtx);
            ctx.get(commandsCtx).call(createCodeBlockCommand.key, "mermaid");
            if (!view.state.selection.$from.parent.textContent)
              view.dispatch(
                view.state.tr.insertText("flowchart LR\n  A[시작] --> B[완료]"),
              );
          });
        else setBlock(id);
      },
    }),
  );
  const { items: visibleSlashItems, active: activeSlash } =
    slashMenu.updateItems(slashItems);
  const tocShown = ready && !!props.toc;
  return (
    <div
      className="rich-document"
      data-loading={!ready || undefined}
      ref={shell}
    >
      {!ready && <DocumentLoading />}
      {uploadError && (
        <p className="document-error" role="alert">
          {uploadError}
        </p>
      )}
      {linkOpenError && (
        <p className="document-error" role="alert">
          {linkOpenError}
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
                setBlock(e.target.value);
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
              <option value="toggle0">토글</option>
              {TOGGLE_LEVELS.map((level) => (
                <option key={level} value={`toggle${level}`}>
                  토글 제목 {level}
                </option>
              ))}
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
              ["링크", Link, openLinkForm],
              ["인용", Quote, () => setBlock("quote")],
              ["코드 블록", SquareCode, () => setBlock("code")],
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
            <DocumentToolMenu
              label="토글"
              menuLabel="토글 제목 선택"
              icon={<ListCollapse size={16} />}
              disabled={!ready}
              onClick={() => setBlock("toggle0")}
              items={TOGGLE_LEVELS.map((level) => ({
                label: `토글 제목 ${level}`,
                icon: [
                  <Heading1 size={16} />,
                  <Heading2 size={16} />,
                  <Heading3 size={16} />,
                ][level - 1],
                run: () => setBlock(`toggle${level}`),
              }))}
            />
            <DocumentToolMenu
              label="표 삽입"
              menuLabel="표 행·열 편집"
              icon={<Table2 size={16} />}
              disabled={!ready}
              onClick={() =>
                command(insertTableCommand.key, { row: 3, col: 3 })
              }
              items={[
                {
                  label: "아래에 행 추가",
                  icon: <BetweenHorizontalStart size={16} />,
                  disabled: !inTable,
                  run: () => command(addRowAfterCommand.key),
                },
                {
                  label: "오른쪽에 열 추가",
                  icon: <BetweenVerticalStart size={16} />,
                  disabled: !inTable,
                  run: () => command(addColAfterCommand.key),
                },
                {
                  label: "행 삭제",
                  icon: <TableRowsSplit size={16} />,
                  tooltip: "선택한 행 삭제 (머리글과 마지막 본문 행 제외)",
                  disabled: !canDeleteRow,
                  run: () => removeFromTable(deleteTableRow),
                },
                {
                  label: "열 삭제",
                  icon: <TableColumnsSplit size={16} />,
                  tooltip: "선택한 열 삭제 (마지막 열은 표 전체 삭제)",
                  disabled: !inTable,
                  run: () => removeFromTable(deleteTableColumn),
                },
                {
                  label: "표 삭제",
                  icon: <Trash2 size={16} />,
                  tooltip: "현재 표 전체 삭제",
                  disabled: !inTable,
                  run: () => removeFromTable(deleteTable),
                },
              ]}
            />
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
              {props.modeControl}
            </div>
          </div>
          {link !== null && (
            <form
              className="document-link-form"
              onSubmit={(e) => {
                e.preventDefault();
                applyLink(link);
              }}
              onKeyDown={(e) => {
                // Esc closes the form, not the detail around it.
                if (e.key !== "Escape") return;
                e.preventDefault();
                e.stopPropagation();
                closeLinkForm();
              }}
            >
              <label>
                <span>링크 주소</span>
                <input
                  autoFocus
                  value={link.href}
                  onChange={(e) => setLink({ ...link, href: e.target.value })}
                  placeholder="https://"
                />
              </label>
              {link.editText && (
                <label>
                  <span>표시 이름</span>
                  <input
                    value={link.text}
                    onChange={(e) => setLink({ ...link, text: e.target.value })}
                    placeholder="비워 두면 링크 주소"
                  />
                </label>
              )}
              <button type="submit">적용</button>
              <button type="button" onClick={closeLinkForm}>
                취소
              </button>
              {linkError && <span role="alert">{linkError}</span>}
            </form>
          )}
        </div>
      )}
      <div className="document-body" data-toc={tocShown || undefined}>
        {/* Before the text for the keyboard, shown on its right. */}
        {tocShown && (
          <DocumentToc
            ref={toc}
            view={() =>
              editorRef.current?.action((ctx) => ctx.get(editorViewCtx)) ?? null
            }
            shell={shell}
            onClose={() => props.onTocClose?.()}
          />
        )}
        <div
          ref={root}
          className="document-prose"
          data-readonly={props.readOnly || undefined}
          onMouseDown={(event) => {
            // Clicks on the padding below the text continue at the end.
            if (event.target !== root.current || props.readOnly) return;
            event.preventDefault();
            editorRef.current?.action((ctx) => {
              const view = ctx.get(editorViewCtx);
              view.dispatch(
                view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)),
              );
              view.focus();
            });
          }}
        />
      </div>
      {ready && !props.readOnly && (
        <DocumentBlockHandle
          ref={blockHandle}
          view={() =>
            editorRef.current?.action((ctx) => ctx.get(editorViewCtx)) ?? null
          }
          shell={shell}
          formats={slashItems.filter((item) => BLOCK_FORMATS.includes(item.id))}
          canFormat={(id) =>
            !!editorRef.current?.action((ctx) =>
              blockCommand(ctx, id)?.(ctx.get(editorViewCtx).state),
            )
          }
          onOpen={() => closeSlash()}
        />
      )}
      {linkTip && (
        <div
          ref={linkTipBox}
          className="document-link-tip"
          role="group"
          aria-label="링크"
          style={{ left: linkTip.left, top: linkTip.top }}
          onBlur={(event) => {
            const next = event.relatedTarget as globalThis.Node | null;
            if (
              !event.currentTarget.contains(next) &&
              !root.current?.contains(next)
            ) {
              linkTipRef.current = null;
              setLinkTip(null);
            }
          }}
        >
          <span className="document-link-tip-href" title={linkTip.href}>
            {linkTip.href}
          </span>
          {[
            [
              "링크 열기",
              ExternalLink,
              (event: MouseEvent) => openLink(linkTip.href, event),
            ],
            ["링크 주소 복사", Copy, () => void copyLink(linkTip.href)],
            ["링크 수정", Pencil, openLinkForm],
            ["링크 제거", Unlink, removeLink],
          ].map(([label, Icon, onClick]: any) => (
            <button
              type="button"
              key={label}
              aria-label={label}
              data-tooltip={label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => onClick(e.nativeEvent)}
            >
              <Icon size={16} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      <Toast message={notice} failed={noticeFailed} />
      {slash && !props.readOnly && visibleSlashItems.length > 0 && (
        <DocumentSlashMenu
          items={visibleSlashItems}
          active={activeSlash}
          left={slash.left}
          top={slash.top}
          flip={slash.flip}
          onHover={slashMenu.hover}
          onSelect={applySlash}
        />
      )}
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
