import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Cell, Point, Task, User, Settings, Property } from "./types";
import CellOptionPicker from "./CellOptionPicker";
import {
  cell,
  fieldsFor,
  propertiesFor,
  isAssignable,
} from "../shared/domain.js";

export type EditorState = { point: Point; initial?: string };
export type EditMove = "stay" | "down" | "next" | "previous";

function fitTextEditor(input: HTMLTextAreaElement) {
  const editor = input.parentElement;
  const cell = input.closest<HTMLElement>(".sheet-cell");
  const grid = input.closest<HTMLElement>(".sheet-scroll");
  if (!editor || !cell || !grid || !cell.offsetWidth) return;
  const box = cell.getBoundingClientRect();
  const gridBox = grid.getBoundingClientRect();
  const scale = box.width / cell.offsetWidth;
  const top = Math.max(
    0,
    gridBox.top,
    grid.querySelector(".sheet-header")?.getBoundingClientRect().bottom || 0,
  );
  const bottom =
    Math.min(window.innerHeight, gridBox.top + grid.clientHeight * scale) - 4;
  const style = getComputedStyle(input);
  const borders =
    parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const scrollTop = input.scrollTop;
  // 먼저 높이를 비워야 삭제한 줄과 자동 줄바꿈이 줄어든 경우도 다시 잴 수 있다.
  input.style.height = "0px";
  const height = Math.max(
    cell.clientHeight,
    Math.min(input.scrollHeight + borders, Math.floor((bottom - top) / scale)),
  );
  editor.style.height = `${height}px`;
  // 아래 공간이 부족하면 위로 펼쳐 화면 안에서 계속 편집할 수 있게 한다.
  editor.style.top = `${Math.min(0, (bottom - box.top) / scale - height)}px`;
  input.style.height = "100%";
  input.scrollTop = scrollTop;
}

export default function InlineCellEditor({
  editor,
  task,
  users,
  settings,
  onCommit,
  onCancel,
}: {
  editor: EditorState;
  task: Task;
  users: User[];
  settings: Settings;
  onCommit: (value: Cell["value"], move?: EditMove) => boolean | undefined;
  onCancel: () => void;
}) {
  const key = editor.point.key;
  const field = fieldsFor(settings).find((f) => f.key === key);
  const property = (propertiesFor(settings) as Property[]).find(
    (p) => p.id === key,
  );
  const [draft, setDraft] = useState<Cell["value"]>(
    property?.kind === "member" && property.multiple
      ? Array.isArray(cell(task, key).value)
        ? cell(task, key).value
        : []
      : (editor.initial ?? cell(task, key).value),
  );
  const draftRef = useRef(draft),
    finished = useRef(false),
    composing = useRef(false);
  const control = useRef<
    HTMLTextAreaElement | HTMLInputElement | HTMLSelectElement
  >(null);
  const [error, setError] = useState("");
  const label = `${field?.label || key} 편집`;
  useLayoutEffect(() => {
    if (control.current instanceof HTMLTextAreaElement)
      fitTextEditor(control.current);
  }, [draft, task, settings]);
  useLayoutEffect(() => {
    const input = control.current;
    if (!(input instanceof HTMLTextAreaElement)) return;
    const cell = input.closest<HTMLElement>(".sheet-cell")!;
    const grid = input.closest<HTMLElement>(".sheet-scroll")!;
    const resize = () => fitTextEditor(input);
    const observer = new ResizeObserver(resize);
    observer.observe(cell);
    observer.observe(grid);
    grid.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    document.fonts.addEventListener("loadingdone", resize);
    return () => {
      observer.disconnect();
      grid.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
      document.fonts.removeEventListener("loadingdone", resize);
    };
  }, []);
  useEffect(() => {
    control.current?.focus({ preventScroll: true });
    if (
      editor.initial === undefined &&
      control.current instanceof HTMLTextAreaElement
    )
      control.current.select();
  }, []);
  function change(value: Cell["value"]) {
    draftRef.current = value;
    setDraft(value);
    setError("");
  }
  function commit(move?: EditMove) {
    if (finished.current || composing.current) return;
    let value = draftRef.current;
    if (
      control.current instanceof HTMLInputElement &&
      !control.current.checkValidity()
    ) {
      setError("입력 형식과 범위를 확인하세요.");
      control.current.focus();
      return;
    }
    if (field?.type === "number" && value !== "") {
      const input = control.current as HTMLInputElement;
      if (!input.checkValidity() || !Number.isFinite(Number(value))) {
        setError("숫자 범위를 확인하세요.");
        input.focus();
        return;
      }
      value = Number(value);
    }
    finished.current = true;
    if (onCommit(value, move) === false) {
      finished.current = false;
      control.current?.focus();
    }
  }
  function cancel() {
    if (finished.current) return;
    finished.current = true;
    onCancel();
  }
  const events = {
    "aria-label": label,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (
        e.nativeEvent.isComposing ||
        composing.current ||
        e.nativeEvent.keyCode === 229
      ) {
        e.stopPropagation();
        return;
      }
      // Let the workspace format the cell without committing the draft text.
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        (e.code === "KeyB" || e.key.toLowerCase() === "b")
      )
        return;
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
      if (e.key === "Tab") {
        e.preventDefault();
        commit(e.shiftKey ? "previous" : "next");
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commit("down");
      }
    },
    onBlur: () => commit(),
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: () => {
      composing.current = false;
    },
  };
  const options =
    property?.kind === "option"
      ? property.values
          .filter((v) => !v.archived)
          .map((v) => ({ value: v.id, label: v.label }))
      : property?.kind === "member"
        ? users
            .filter((u) => isAssignable(u, task.teamId))
            .map((u) => ({
              value: u.id,
              label: `${u.name}${u.active ? "" : " (비활성)"}`,
            }))
        : null;
  return (
    <div
      className={`inline-editor ${options ? "inline-choice-editor" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onCopy={(e) => e.stopPropagation()}
      onPaste={(e) => e.stopPropagation()}
    >
      {options ? (
        <CellOptionPicker
          label={label}
          options={options}
          property={property?.kind === "option" ? property : undefined}
          value={draft}
          multiple={!!property?.multiple}
          selectedLabels={
            property?.kind === "member"
              ? Object.fromEntries(users.map((u) => [u.id, u.name]))
              : undefined
          }
          onChange={change}
          onCommit={commit}
          onCancel={cancel}
        />
      ) : field?.type === "date" || field?.type === "number" ? (
        <input
          {...events}
          ref={(el) => {
            control.current = el;
          }}
          type={field.type}
          step="any"
          value={String(draft)}
          onChange={(e) => change(e.target.value)}
        />
      ) : (
        <textarea
          {...events}
          ref={(el) => {
            control.current = el;
          }}
          value={String(draft)}
          onChange={(e) => change(e.target.value)}
          maxLength={10000}
          spellCheck={false}
        />
      )}
      {error && (
        <span className="inline-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
