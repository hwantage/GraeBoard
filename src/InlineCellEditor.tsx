import { useEffect, useRef, useState } from "react";
import type { Cell, Point, Task, User, Settings, Property } from "./types";
import CellOptionPicker from "./CellOptionPicker";
import {
  cell,
  fieldsFor,
  propertiesFor,
  propertyValue,
} from "../shared/domain.js";

export type EditorState = { point: Point; initial?: string };
export type EditMove = "down" | "next" | "previous";
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
      e.stopPropagation();
      if (
        e.nativeEvent.isComposing ||
        composing.current ||
        e.nativeEvent.keyCode === 229
      )
        return;
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
          .map((v) => ({ value: propertyValue(property, v), label: v.label }))
      : property?.kind === "member"
        ? users.map((u) => ({
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
          min={["score", "current"].includes(key) ? 0 : undefined}
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
