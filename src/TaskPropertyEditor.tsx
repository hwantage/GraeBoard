import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CompositionEvent, KeyboardEvent } from "react";
import { CalendarDays } from "lucide-react";
import {
  cell,
  displayValue,
  isAssignable,
  propertiesFor,
} from "../shared/domain.js";
import CellDatePicker, { normalizeDateInput } from "./CellDatePicker";
import CellOptionPicker from "./CellOptionPicker";
import PropertyBadge from "./PropertyBadge";
import MemberValue from "./MemberValue";
import { ApiError } from "./api";
import type {
  Cell,
  CellChange,
  Property,
  SavedCell,
  Settings,
  Task,
  User,
} from "./types";

export type PropertySaveRequest = {
  operationId: string;
  createdAt: string;
  changes: CellChange[];
};
export type PropertyEditorHandle = { flush: () => Promise<boolean> };
type Draft = { value: Cell["value"]; baseline: Cell["value"]; version: number };
const same = (a: Cell["value"], b: Cell["value"]) =>
  JSON.stringify(a) === JSON.stringify(b);

export default forwardRef<
  PropertyEditorHandle,
  {
    task: Task;
    settings: Settings;
    users: User[];
    readOnly: boolean;
    onSave: (request: PropertySaveRequest) => Promise<SavedCell[]>;
  }
>(function TaskPropertyEditor(
  { task, settings, users, readOnly, onSave },
  ref,
) {
  const properties = propertiesFor(settings) as Property[];
  const drafts = useRef(new Map<string, Draft>());
  const current = useRef({ task, onSave, readOnly });
  current.current = { task, onSave, readOnly };
  const [, redraw] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [popupKey, setPopupKey] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const controls = useRef(
    new Map<string, HTMLTextAreaElement | HTMLInputElement>(),
  );
  const composing = useRef(new Set<string>());
  const focused = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Promise<boolean> | null>(null);
  const attempt = useRef<PropertySaveRequest | null>(null);
  const alive = useRef(true);
  const render = () => {
    if (alive.current) redraw((n) => n + 1);
  };
  const changed = () =>
    [...drafts.current.values()].some((d) => !same(d.value, d.baseline));
  function clearTimer() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }
  useEffect(() => {
    alive.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!changed() && !attempt.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      alive.current = false;
      clearTimer();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);
  function sizeTextareas() {
    for (const [key, control] of controls.current) {
      if (!(control instanceof HTMLTextAreaElement)) continue;
      control.style.height = "auto";
      const line = parseFloat(getComputedStyle(control).lineHeight) || 20;
      control.style.height = `${key === "title" ? Math.max(line, control.scrollHeight) : line}px`;
    }
  }
  useLayoutEffect(sizeTextareas);
  useEffect(() => {
    if (!root.current) return;
    let width = -1;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      sizeTextareas();
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (popupKey)
      controls.current.get(popupKey)?.focus({ preventScroll: true });
  }, [popupKey]);

  function begin(key: string) {
    if (current.current.readOnly || drafts.current.has(key)) return;
    const before = cell(current.current.task, key);
    drafts.current.set(key, {
      value: before.value,
      baseline: before.value,
      version: before.version,
    });
  }
  function schedule() {
    clearTimer();
    if (!composing.current.size)
      timer.current = setTimeout(() => void flush(), 650);
  }
  function change(key: string, value: Cell["value"]) {
    if (current.current.readOnly) return;
    begin(key);
    drafts.current.get(key)!.value = value;
    render();
    schedule();
  }
  function normalize(key: string, draft: Draft): Cell["value"] {
    const kind = properties.find((p) => p.id === key)?.kind;
    if (kind === "date") {
      const date = normalizeDateInput(String(draft.value));
      if (date === null)
        throw new Error(
          "유효한 날짜를 입력하세요. 예: 2026-10-13 또는 20261013",
        );
      return date;
    }
    if (kind === "number") {
      if (
        !Number.isFinite(Number(draft.value)) ||
        controls.current.get(key)?.validity.badInput
      )
        throw new Error("유효한 숫자를 입력하세요.");
      return draft.value === "" ? "" : Number(draft.value);
    }
    return draft.value;
  }
  async function saveAll(): Promise<boolean> {
    try {
      while (alive.current) {
        if (composing.current.size) return false;
        if (!attempt.current) {
          const changes: CellChange[] = [];
          for (const [key, draft] of drafts.current) {
            const value = normalize(key, draft);
            if (!same(value, draft.baseline))
              changes.push({
                taskId: task.id,
                key,
                value,
                expectedVersion: draft.version,
              });
          }
          if (!changes.length) {
            // A picker opened and dismissed without edits must stop holding
            // its old cell value/version when later SSE updates arrive.
            let released = false;
            for (const [key, draft] of drafts.current) {
              if (
                focused.current !== key &&
                same(draft.value, draft.baseline)
              ) {
                drafts.current.delete(key);
                released = true;
              }
            }
            if (released) render();
            if (alive.current) setError("");
            return true;
          }
          attempt.current = {
            operationId: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            changes,
          };
        }
        if (current.current.readOnly)
          throw new Error("업무를 수정할 권한이 없습니다. 입력은 유지됩니다.");
        setSaving(true);
        const request = attempt.current;
        const saved = await current.current.onSave(request);
        if (!alive.current) return false;
        for (const change of request.changes) {
          const draft = drafts.current.get(change.key);
          const result = saved.find(
            (c) => c.key === change.key && c.taskId === change.taskId,
          );
          if (!draft || !result) continue;
          let submitted = false;
          try {
            submitted = same(normalize(change.key, draft), change.value!);
          } catch {
            /* A newer invalid date/number still keeps the successful baseline. */
          }
          draft.baseline = result.value;
          draft.version = result.version;
          if (submitted) {
            draft.value = result.value;
            if (focused.current !== change.key)
              drafts.current.delete(change.key);
          }
        }
        attempt.current = null;
        render();
      }
      return false;
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof ApiError && e.status === 409
            ? `${e.message} 입력은 유지됩니다. 최신 값을 확인하려면 입력을 취소하세요.`
            : (e as Error).message,
        );
      return false;
    } finally {
      pending.current = null;
      if (alive.current) setSaving(false);
    }
  }
  function flush(): Promise<boolean> {
    clearTimer();
    if (pending.current) return pending.current;
    // Even a no-op or invalid input must settle after the pending assignment.
    const promise = Promise.resolve().then(saveAll);
    pending.current = promise;
    return promise;
  }
  useImperativeHandle(ref, () => ({ flush }));

  function blur(key: string) {
    focused.current = null;
    const draft = drafts.current.get(key);
    if (
      draft &&
      same(draft.value, draft.baseline) &&
      !pending.current &&
      !attempt.current
    )
      drafts.current.delete(key);
    render();
    if (!error) void flush();
  }
  function keyDown(event: KeyboardEvent, key: string) {
    event.stopPropagation();
    if (
      event.nativeEvent.isComposing ||
      composing.current.has(key) ||
      event.nativeEvent.keyCode === 229
    )
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void flush();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      controls.current.get(key)?.blur();
      void flush();
    } else if (event.key === "Escape") {
      event.preventDefault();
      controls.current.get(key)?.blur();
    }
  }
  function events(property: Property) {
    const key = property.id;
    return {
      "aria-label": `${property.name} 편집`,
      readOnly,
      onFocus: () => {
        focused.current = key;
        begin(key);
        render();
      },
      onBlur: () => blur(key),
      onKeyDown: (event: KeyboardEvent) => keyDown(event, key),
      onCompositionStart: () => {
        composing.current.add(key);
        clearTimer();
      },
      onCompositionEnd: (
        event: CompositionEvent<HTMLTextAreaElement | HTMLInputElement>,
      ) => {
        composing.current.delete(key);
        change(key, event.currentTarget.value);
      },
    };
  }
  const raw = (key: string) =>
    drafts.current.get(key)?.value ?? cell(task, key).value;
  function textInput(property: Property, placeholder: string) {
    return (
      <textarea
        {...events(property)}
        className="detail-text-input"
        rows={1}
        wrap={property.id === "title" ? "soft" : "off"}
        title={property.id === "title" ? undefined : String(raw(property.id))}
        ref={(el) => {
          if (el) controls.current.set(property.id, el);
          else controls.current.delete(property.id);
        }}
        maxLength={10000}
        spellCheck={false}
        placeholder={placeholder}
        value={String(raw(property.id))}
        onChange={(e) => change(property.id, e.target.value)}
      />
    );
  }
  const portalContainer = root.current?.closest("dialog") || undefined;
  function closePopup(move?: "stay" | "next" | "previous" | "up" | "down") {
    const key = popupKey;
    focused.current = null;
    setPopupKey(null);
    void flush();
    if (move)
      requestAnimationFrame(() => {
        const trigger = root.current?.querySelector<HTMLButtonElement>(
          `[data-property="${key}"] button`,
        );
        if (move === "next" || move === "previous") {
          const targets = [
            ...(root.current?.querySelectorAll<HTMLElement>(
              "textarea, input, button:not(:disabled)",
            ) || []),
          ];
          const next =
            targets[targets.indexOf(trigger!) + (move === "next" ? 1 : -1)];
          (next || trigger)?.focus();
        } else trigger?.focus({ preventScroll: true });
      });
  }
  function field(property: Property) {
    const key = property.id;
    const value = raw(key);
    const label = `${property.name} 편집`;
    const choice = property.kind === "option" || property.kind === "member";
    if (popupKey === key && choice) {
      return (
        <CellOptionPicker
          label={label}
          value={value}
          multiple={!!property.multiple}
          property={property.kind === "option" ? property : undefined}
          options={
            property.kind === "option"
              ? property.values
                  .filter((v) => !v.archived)
                  .map((v) => ({ value: v.id, label: v.label }))
              : users
                  .filter((u) => isAssignable(u, task.teamId))
                  .map((u) => ({ value: u.id, label: u.name }))
          }
          selectedLabels={Object.fromEntries(users.map((u) => [u.id, u.name]))}
          portalContainer={portalContainer}
          onChange={(next) => change(key, next)}
          onCommit={closePopup}
          onDismiss={() => closePopup()}
          onCancel={() => closePopup("stay")}
        />
      );
    }
    if (popupKey === key && property.kind === "date") {
      return (
        <CellDatePicker
          label={label}
          value={String(value)}
          inputProps={{ ...events(property), className: "detail-text-input" }}
          inputRef={(el) => {
            if (el) controls.current.set(key, el);
            else controls.current.delete(key);
          }}
          portalContainer={portalContainer}
          onChange={(next) => change(key, next)}
          onCommit={closePopup}
          onCancel={() => closePopup("stay")}
        />
      );
    }
    if (choice || property.kind === "date") {
      const text = displayValue(
        {
          ...task,
          cells: { ...task.cells, [key]: { ...cell(task, key), value } },
        },
        key,
        users,
        settings,
      );
      return (
        <button
          type="button"
          className={`detail-field-value ${text ? "" : "is-empty"}`}
          aria-label={`${property.name} 수정`}
          aria-haspopup={choice ? "listbox" : "dialog"}
          aria-expanded={popupKey === key}
          disabled={readOnly}
          title={text || "미입력"}
          onClick={() => {
            begin(key);
            focused.current = key;
            setPopupKey(key);
          }}
        >
          <span>
            {!text ? (
              "미입력"
            ) : property.kind === "option" ? (
              <PropertyBadge property={property} value={String(value)} />
            ) : property.kind === "member" ? (
              <MemberValue property={property} value={value} users={users} />
            ) : (
              text
            )}
          </span>
        </button>
      );
    }
    if (property.kind === "number")
      return (
        <input
          {...events(property)}
          type="number"
          step="any"
          className="detail-text-input"
          placeholder="미입력"
          ref={(el) => {
            if (el) controls.current.set(key, el);
            else controls.current.delete(key);
          }}
          value={String(value)}
          onChange={(e) => change(key, e.target.value)}
        />
      );
    return textInput(property, "미입력");
  }
  const title = properties.find((p) => p.id === "title")!;
  const description = properties.find((p) => p.id === "description");
  return (
    <div
      ref={root}
      className="task-inline-properties"
      onKeyDown={(e) => e.stopPropagation()}
      onCopy={(e) => e.stopPropagation()}
      onCut={(e) => e.stopPropagation()}
      onPaste={(e) => e.stopPropagation()}
    >
      <div className="task-detail-heading">
        <p className="task-detail-year">
          <CalendarDays size={14} /> 관리 연도 {task.years.join(" · ")}
          {saving && <span role="status">속성 저장 중…</span>}
        </p>
        <div className="task-detail-title">
          {textInput(title, "제목 없는 업무")}
        </div>
        {description && (
          <div className="task-detail-description">
            {textInput(
              description,
              readOnly ? "설명 없음" : "설명을 입력하세요…",
            )}
          </div>
        )}
      </div>
      <div
        className="task-detail-properties"
        role="region"
        aria-label="업무 속성"
      >
        <dl className="detail-fields">
          {properties
            .filter((p) => p.id !== "title" && p.id !== "description")
            .map((p) => (
              <div key={p.id} data-property={p.id}>
                <dt>{p.name}</dt>
                <dd>{field(p)}</dd>
              </div>
            ))}
        </dl>
      </div>
      {error && (
        <div className="task-property-error" role="alert">
          <span>{error}</span>
          <button type="button" disabled={saving} onClick={() => void flush()}>
            저장 다시 시도
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              clearTimer();
              drafts.current.clear();
              attempt.current = null;
              setError("");
              render();
            }}
          >
            입력 취소
          </button>
        </div>
      )}
    </div>
  );
});
