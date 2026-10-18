import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Plus, Square, SquareCheck, Tags, Trash2, X } from "lucide-react";
import {
  CALENDAR_TAG_COLORS,
  CALENDAR_TAG_LIMIT,
  calendarTagColor,
} from "../shared/calendar-tags.js";
import { api, send } from "./api";
import { busyProps } from "./busyProps";
import { Button, ErrorNote, Modal } from "./components";
import type { CalendarTag } from "./calendar-types";
import Select from "./Select";
import "./calendar-tags.css";

export function calendarTagManagerLabel(userId: string | null) {
  return userId === null ? "팀 태그 관리" : "개인 태그 관리";
}

export function calendarTagStyle(color: string): CSSProperties {
  const value = calendarTagColor(color);
  return {
    "--calendar-tag-bg": value.background,
    "--calendar-tag-chip": value.chip,
    "--calendar-tag-ink": value.ink,
    "--calendar-tag-border": value.border,
  } as CSSProperties;
}

export function CalendarTagChip({
  tag,
  checked = false,
}: {
  tag: Pick<CalendarTag, "name" | "color" | "kind">;
  checked?: boolean;
}) {
  return (
    <span
      className="calendar-tag-chip"
      style={calendarTagStyle(tag.color)}
      title={tag.name}
    >
      {tag.kind === "check" &&
        (checked ? (
          <SquareCheck size={12} aria-hidden="true" />
        ) : (
          <Square size={12} aria-hidden="true" />
        ))}
      <span>{tag.name}</span>
    </span>
  );
}

export function CalendarCheckTag({
  tag,
  checked,
  onChange,
  disabled = false,
  readOnly = false,
}: {
  tag: CalendarTag;
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const blocked = disabled || readOnly || !onChange;
  return (
    <label
      className="calendar-tag-chip calendar-check-tag"
      style={calendarTagStyle(tag.color)}
      title={tag.name}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (blocked) event.preventDefault();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" || (blocked && event.key === " "))
          event.preventDefault();
      }}
    >
      <input
        type="checkbox"
        aria-label={`${tag.name} 체크`}
        checked={checked}
        disabled={readOnly || !onChange}
        aria-disabled={disabled || undefined}
        onChange={(event) => {
          if (!blocked) onChange?.(event.target.checked);
        }}
      />
      <span>{tag.name}</span>
    </label>
  );
}

export function CalendarTagPicker({
  userId,
  tags,
  value,
  checkedIds,
  onChange,
  onCheckChange,
  onManage,
  disabled = false,
  readOnly = false,
}: {
  userId: string | null;
  tags: CalendarTag[];
  value: string[];
  checkedIds: string[];
  onChange: (ids: string[]) => void;
  onCheckChange: (id: string, checked: boolean) => void;
  onManage: () => void;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const choices = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (
        choices.current?.open &&
        !choices.current.contains(event.target as Node)
      )
        choices.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !choices.current?.open) return;
      event.preventDefault();
      event.stopPropagation();
      choices.current.open = false;
      choices.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape, true);
    };
  }, []);
  const selected = value.flatMap(
    (id) => tags.find((tag) => tag.id === id) || [],
  );
  const toggle = (id: string) =>
    onChange(
      value.includes(id) ? value.filter((item) => item !== id) : [...value, id],
    );
  return (
    <fieldset className="calendar-tag-picker" aria-label="태그">
      <div className="calendar-tag-selection">
        {selected.map((tag, index) =>
          readOnly ? (
            tag.kind === "check" ? (
              <CalendarCheckTag
                key={tag.id}
                tag={tag}
                checked={checkedIds.includes(tag.id)}
                readOnly
              />
            ) : (
              <CalendarTagChip key={tag.id} tag={tag} />
            )
          ) : (
            <span
              key={tag.id}
              className="calendar-tag-selected"
              style={calendarTagStyle(tag.color)}
            >
              {tag.kind === "check" ? (
                <CalendarCheckTag
                  tag={tag}
                  checked={checkedIds.includes(tag.id)}
                  disabled={disabled}
                  onChange={(checked) => onCheckChange(tag.id, checked)}
                />
              ) : (
                <button
                  type="button"
                  {...busyProps(disabled)}
                  title={
                    index === 0
                      ? `${tag.name} · 배경색 적용 중`
                      : `${tag.name} 색상을 배경에 적용`
                  }
                  aria-label={
                    index === 0
                      ? `${tag.name} · 배경색 적용 중`
                      : `${tag.name} 색상을 배경에 적용`
                  }
                  aria-pressed={index === 0}
                  onClick={() =>
                    onChange([tag.id, ...value.filter((id) => id !== tag.id)])
                  }
                >
                  {tag.name}
                </button>
              )}
              <button
                type="button"
                {...busyProps(disabled)}
                aria-label={`${tag.name} 태그 제거`}
                onClick={() => toggle(tag.id)}
              >
                <X size={11} />
              </button>
            </span>
          ),
        )}
        {!selected.length && readOnly && (
          <span className="calendar-tag-empty">태그 없음</span>
        )}
        {!readOnly && (
          <details ref={choices} className="calendar-tag-choices">
            <summary
              onClick={(event) => {
                if (disabled) event.preventDefault();
              }}
              aria-disabled={disabled || undefined}
            >
              <Plus size={12} aria-hidden="true" />
              태그 선택
            </summary>
            <div className="calendar-tag-options">
              {tags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  className="calendar-tag-option"
                  title={`${tag.name} 태그`}
                  aria-label={`${tag.name} 태그`}
                  aria-pressed={value.includes(tag.id)}
                  {...busyProps(
                    disabled,
                    !value.includes(tag.id) &&
                      value.length >= CALENDAR_TAG_LIMIT,
                  )}
                  onClick={() => toggle(tag.id)}
                >
                  <CalendarTagChip
                    tag={tag}
                    checked={checkedIds.includes(tag.id)}
                  />
                </button>
              ))}
              {!tags.length && (
                <span className="calendar-tag-empty">
                  {calendarTagManagerLabel(userId)}에서 첫 태그를 만들어 보세요.
                </span>
              )}
              <div className="calendar-tag-options-actions">
                <button
                  type="button"
                  className="calendar-tag-manage"
                  {...busyProps(disabled)}
                  onClick={() => {
                    if (choices.current) {
                      choices.current.open = false;
                      choices.current
                        .querySelector("summary")
                        ?.focus({ preventScroll: true });
                    }
                    onManage();
                  }}
                >
                  <Tags size={12} aria-hidden="true" />
                  {calendarTagManagerLabel(userId)}
                </button>
              </div>
            </div>
          </details>
        )}
      </div>
    </fieldset>
  );
}

type Draft = {
  id: string;
  name: string;
  color: string;
  kind: CalendarTag["kind"];
  revision?: number;
};
const newDraft = (): Draft => ({
  id: crypto.randomUUID(),
  name: "",
  color: "default",
  kind: "label",
});
const sorted = (tags: CalendarTag[]) =>
  [...tags].sort((a, b) => a.name.localeCompare(b.name, "ko"));

export default function CalendarTagManager({
  teamId,
  userId,
  ownerName,
  tags,
  readOnly,
  onChanged,
  onClose,
}: {
  teamId: string;
  userId: string | null;
  ownerName: string;
  tags: CalendarTag[];
  readOnly: boolean;
  onChanged: (tags: CalendarTag[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const alive = useRef(true);
  const composing = useRef(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const selected = tags.find((tag) => tag.id === draft.id);
  useEffect(() => {
    const controller = new AbortController();
    alive.current = true;
    setLoading(true);
    const scope =
      userId === null
        ? "scope=team"
        : new URLSearchParams({ userId }).toString();
    void api<{ tags: CalendarTag[] }>(
      `/calendar/teams/${teamId}/tags?${scope}`,
      {
        signal: controller.signal,
      },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        changed.current(sorted(result.tags));
        setDraft(
          (previous) =>
            result.tags.find((tag) => tag.id === previous.id) || newDraft(),
        );
        setError("");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [teamId, userId, attempt]);
  useEffect(() => {
    if (!loading) nameInput.current?.focus();
  }, [loading]);
  function edit(next: Draft) {
    setDraft(next);
    setError("");
    setConfirmDelete(false);
    nameInput.current?.focus();
  }
  async function save(remove = false) {
    if (saving.current || loading || readOnly) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      if (remove && selected) {
        await send(
          `/calendar/tags/${selected.id}`,
          { expectedRevision: selected.revision },
          "DELETE",
        );
        if (!alive.current) return;
        onChanged(tags.filter((tag) => tag.id !== selected.id));
        edit(newDraft());
      } else {
        const tag = await send<CalendarTag>(
          selected
            ? `/calendar/tags/${draft.id}`
            : `/calendar/teams/${teamId}/tags`,
          {
            name: draft.name,
            color: draft.color,
            kind: draft.kind,
            ...(selected
              ? { expectedRevision: draft.revision }
              : { id: draft.id, userId }),
          },
          selected ? "PATCH" : "POST",
        );
        if (!alive.current) return;
        onChanged(sorted([...tags.filter((item) => item.id !== tag.id), tag]));
        setDraft(tag);
        setConfirmDelete(false);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={calendarTagManagerLabel(userId)}
      className="calendar-tag-manager"
      initialFocus={nameInput}
      onClose={() => {
        if (!saving.current) onClose();
      }}
    >
      <p className="calendar-hint">
        {userId === null
          ? "팀 공용 일정에 사용하는 태그입니다. 모든 팀원이 관리할 수 있습니다."
          : `${ownerName}의 개인 일정에 사용하는 태그입니다. 다른 팀원의 태그와 별도로 관리합니다.`}
      </p>
      <div className="calendar-tag-manager-layout">
        <div className="calendar-tag-catalog">
          <div className="calendar-tag-catalog-heading">
            <strong>
              {userId === null ? "팀 공용 태그" : "개인 태그"}{" "}
              <span>{tags.length}</span>
            </strong>
            {!readOnly && (
              <Button
                {...busyProps(busy || loading)}
                onClick={() => edit(newDraft())}
              >
                <Plus size={12} />새 태그
              </Button>
            )}
          </div>
          <div
            className="calendar-tag-list"
            aria-label={
              userId === null ? "팀 공용 태그 목록" : "개인 태그 목록"
            }
          >
            {tags.map((tag) => (
              <button
                type="button"
                key={tag.id}
                {...busyProps(busy || loading)}
                aria-pressed={tag.id === draft.id}
                onClick={() => edit(tag)}
              >
                <CalendarTagChip tag={tag} />
                <span>{tag.usageCount}개 일정</span>
              </button>
            ))}
            {!tags.length && (
              <p className="calendar-hint">
                {loading
                  ? "태그를 불러오는 중…"
                  : "아직 등록된 태그가 없습니다."}
              </p>
            )}
          </div>
        </div>
        {!readOnly && (
          <form
            className="calendar-tag-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!composing.current && draft.name.trim()) void save();
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (composing.current ||
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229 ||
                  event.repeat)
              )
                event.preventDefault();
            }}
          >
            <h3>{selected ? "태그 수정" : "새 태그"}</h3>
            <label className="calendar-field">
              태그 유형
              <Select
                aria-label="태그 유형"
                value={draft.kind}
                {...busyProps(busy || loading)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    kind: event.target.value as CalendarTag["kind"],
                  })
                }
              >
                <option value="label">일반 태그</option>
                <option value="check">체크 태그</option>
              </Select>
            </label>
            {draft.kind === "check" && (
              <p className="calendar-hint">
                일정마다 체크 상태를 따로 기록합니다.
              </p>
            )}
            {selected?.kind === "check" && draft.kind === "label" && (
              <p className="calendar-hint">
                일반 태그로 바꾸면 연결된 일정의 체크 상태가 해제됩니다.
              </p>
            )}
            <label className="calendar-field">
              태그 이름
              <input
                ref={nameInput}
                aria-label="태그 이름"
                maxLength={40}
                value={draft.name}
                {...busyProps(busy || loading)}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </label>
            <fieldset className="calendar-tag-palette">
              <legend>색상</legend>
              {CALENDAR_TAG_COLORS.map((color) => (
                <label key={color.id} style={calendarTagStyle(color.id)}>
                  <input
                    type="radio"
                    name="calendar-tag-color"
                    value={color.id}
                    checked={draft.color === color.id}
                    {...busyProps(busy || loading)}
                    onChange={() => setDraft({ ...draft, color: color.id })}
                  />
                  <span className="calendar-tag-swatch" aria-hidden="true" />
                  {color.name}
                </label>
              ))}
            </fieldset>
            <div
              className="calendar-tag-preview"
              style={calendarTagStyle(draft.color)}
              aria-label="태그 색상 미리보기"
            >
              <strong>일정 미리보기</strong>
              <CalendarTagChip
                tag={{ ...draft, name: draft.name.trim() || "태그 이름" }}
              />
            </div>
            <div className="calendar-actions">
              <Button
                type="submit"
                {...busyProps(busy || loading, !draft.name.trim())}
              >
                {busy ? "저장 중…" : selected ? "변경 저장" : "태그 만들기"}
              </Button>
              {selected && (
                <Button
                  {...busyProps(busy || loading)}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={13} />
                  태그 삭제
                </Button>
              )}
            </div>
            {confirmDelete && selected && (
              <div className="calendar-tag-delete" role="alert">
                <p>
                  ‘{selected.name}’ 태그를 삭제할까요? 모든 일정에서 이 태그만
                  제거되며 일정은 유지됩니다.
                </p>
                <div className="calendar-actions">
                  <Button {...busyProps(busy)} onClick={() => void save(true)}>
                    태그 삭제 확인
                  </Button>
                  <Button
                    {...busyProps(busy)}
                    onClick={() => setConfirmDelete(false)}
                  >
                    취소
                  </Button>
                </div>
              </div>
            )}
          </form>
        )}
      </div>
      <ErrorNote error={error} />
      {error && (
        <Button
          {...busyProps(busy || loading)}
          onClick={() => {
            setConfirmDelete(false);
            setAttempt((n) => n + 1);
          }}
        >
          최신 태그 목록 불러오기
        </Button>
      )}
    </Modal>
  );
}
