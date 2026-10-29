import {
  useMemo,
  type KeyboardEvent,
  type PointerEvent,
  type MouseEvent,
} from "react";
import { busyProps } from "./busyProps";
import { FileText } from "lucide-react";
import { normalizeSearchQuery } from "../shared/search.js";
import { addDays, moveCalendarRange } from "../shared/calendar.js";
import type { CalendarEntry, CalendarTag } from "./calendar-types";
import {
  CalendarCheckTag,
  CalendarTagChip,
  calendarTagStyle,
} from "./CalendarTags";
import type {
  CalendarDrag,
  CalendarDragMode,
  CalendarRange,
} from "./useCalendarDrag";

type Segment = {
  item: CalendarEntry;
  first: number;
  last: number;
  lane: number;
};

export default function CalendarEntries({
  entries,
  tags,
  start,
  weekdays,
  preview,
  drag,
  disabled,
  readOnly,
  changingId,
  savingId,
  searchQuery,
  onOpen,
  onContextMenu,
  onDragStart,
  onRangeChange,
  onOrderChange,
  onCheckTag,
  canClick,
}: {
  entries: CalendarEntry[];
  tags: Map<string, CalendarTag>;
  start: string;
  weekdays: number[];
  preview: CalendarEntry | null;
  drag: CalendarDrag | null;
  disabled: boolean;
  readOnly: boolean;
  changingId?: string;
  savingId?: string;
  searchQuery: string;
  onOpen: (entry: CalendarEntry) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, entry: CalendarEntry) => void;
  onDragStart: (
    event: PointerEvent<HTMLButtonElement>,
    entry: CalendarEntry,
    mode: CalendarDragMode,
  ) => void;
  onRangeChange: (entry: CalendarEntry, range: CalendarRange) => void;
  onOrderChange: (entry: CalendarEntry, lane: number) => void;
  onCheckTag: (entry: CalendarEntry, tagId: string, checked: boolean) => void;
  canClick: () => boolean;
}) {
  const dates = useMemo(
    () => weekdays.map((day) => addDays(start, day)),
    [start, weekdays],
  );
  function columns(item: CalendarRange) {
    const first = dates.findIndex(
      (date) => date >= item.date && date <= item.endDate,
    );
    const last = dates.findLastIndex(
      (date) => date >= item.date && date <= item.endDate,
    );
    return first < 0 ? null : { first, last };
  }
  // The original cards stay in the layout throughout a gesture. The floating
  // preview cannot repack lanes or move the date cells used for hit testing.
  const segments: Segment[] = useMemo(() => {
    return entries.flatMap((item) => {
      const span = columns(item);
      if (!span) return [];
      return [{ item, ...span, lane: item.lane }];
    });
  }, [entries, dates]);
  const previewSpan = preview && columns(preview);

  function keyboard(
    event: KeyboardEvent<HTMLButtonElement>,
    item: CalendarEntry,
    mode: CalendarDragMode,
  ) {
    if (readOnly || disabled || (mode === "move" && !event.altKey)) return;
    if (
      mode === "move" &&
      event.shiftKey &&
      ["ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      onOrderChange(
        item,
        Math.max(0, item.lane + (event.key === "ArrowUp" ? -1 : 1)),
      );
      return;
    }
    const offset = (
      { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<
        string,
        number
      >
    )[event.key];
    if (!offset) return;
    event.preventDefault();
    event.stopPropagation();
    const anchor = mode === "end" ? item.endDate : item.date;
    onRangeChange(
      item,
      moveCalendarRange(item, mode, anchor, addDays(anchor, offset)),
    );
  }

  function render({ item, first, last, lane }: Segment, isPreview = false) {
    const entryTags = item.tagIds.flatMap((id) => tags.get(id) || []);
    const separateTags =
      !isPreview && entryTags.some((tag) => tag.kind === "check");
    const before = item.date < dates[first],
      after = item.endDate > dates[last];
    const isSource = !isPreview && drag?.id === item.id;
    const open = (detail: number) => {
      if (!disabled && (!detail || canClick())) onOpen(item);
    };
    const content = (
      <span className="calendar-entry-content">
        <strong>
          <span>
            {before && <i aria-hidden="true">← </i>}
            {item.title}
            {after && <i aria-hidden="true"> →</i>}
          </span>
          {(item.hasDocument ?? !!item.preview) && (
            <FileText
              size={12}
              className="calendar-document-icon"
              aria-label="문서 있음"
            />
          )}
        </strong>
        <span className="calendar-entry-tags">
          {!separateTags &&
            entryTags.map((tag) => (
              <CalendarTagChip
                key={tag.id}
                tag={tag}
                checked={item.checkedTagIds.includes(tag.id)}
              />
            ))}
        </span>
      </span>
    );
    return (
      <div
        key={`${isPreview ? "preview:" : ""}${item.id}`}
        data-entry-id={isSource ? undefined : item.id}
        data-range-start={item.date}
        data-range-end={item.endDate}
        data-entry-lane={lane}
        data-readonly={readOnly || undefined}
        role="group"
        aria-hidden={isPreview || undefined}
        aria-busy={savingId === item.id || undefined}
        aria-label={`${item.title} · ${item.date} ~ ${item.endDate}`}
        onContextMenu={
          isPreview || disabled || readOnly
            ? undefined
            : (event) => onContextMenu(event, item)
        }
        className={`calendar-entry-segment${before ? " continues-before" : ""}${after ? " continues-after" : ""}${isSource ? " is-drag-source" : ""}${isPreview ? " is-drag-preview" : ""}${!isSource && changingId === item.id ? " is-changing" : ""}`}
        style={{
          visibility: normalizeSearchQuery(item.title).includes(searchQuery)
            ? undefined
            : "hidden",
          ...(entryTags[0] ? calendarTagStyle(entryTags[0].color) : {}),
          gridColumn: `${first + 1} / ${last + 2}`,
          gridRow: isPreview ? undefined : lane + 1,
          ...(isPreview
            ? {
                top: `clamp(var(--calendar-entry-top), calc(var(--calendar-entry-top) + ${lane} * (var(--calendar-entry-height) + var(--calendar-entry-gap))), calc(100% - var(--calendar-entry-height) - var(--calendar-entry-bottom)))`,
              }
            : {}),
        }}
      >
        {isPreview ? (
          <div className="calendar-entry-card">{content}</div>
        ) : (
          <>
            <button
              className="calendar-entry-card"
              {...busyProps(disabled && !drag)}
              aria-disabled={disabled || undefined}
              aria-label={`${item.title}${item.preview ? ` ${item.preview}` : ""}${entryTags.length ? ` · 태그: ${entryTags.map((tag) => tag.name).join(", ")}` : ""}`}
              aria-describedby={readOnly ? undefined : "calendar-drag-help"}
              title={item.title}
              onClick={(e) => open(e.detail)}
              onPointerDown={
                readOnly || disabled
                  ? undefined
                  : (e) => onDragStart(e, item, "move")
              }
              onKeyDown={(e) => keyboard(e, item, "move")}
            >
              {content}
            </button>
            {separateTags && (
              <span className="calendar-entry-tag-overlay">
                <span className="calendar-entry-content">
                  <span className="calendar-entry-tags">
                    {entryTags.map((tag) =>
                      tag.kind === "check" ? (
                        <CalendarCheckTag
                          key={tag.id}
                          tag={tag}
                          checked={item.checkedTagIds.includes(tag.id)}
                          disabled={disabled}
                          readOnly={readOnly}
                          onChange={(checked) =>
                            onCheckTag(item, tag.id, checked)
                          }
                        />
                      ) : (
                        <CalendarTagChip key={tag.id} tag={tag} />
                      ),
                    )}
                  </span>
                </span>
              </span>
            )}
            {savingId === item.id && (
              <span className="calendar-entry-saving">저장 중…</span>
            )}
            {!readOnly &&
              (["start", "end"] as const).map((mode) => (
                <button
                  key={mode}
                  className={`calendar-range-handle is-${mode}`}
                  {...busyProps(disabled && !drag)}
                  aria-disabled={disabled || undefined}
                  aria-label={`${mode === "start" ? "시작일" : "종료일"} 조정`}
                  title={`${mode === "start" ? "시작일" : "종료일"} 드래그 · 좌우 방향키 1일, 위아래 방향키 1주`}
                  onClick={(e) => open(e.detail)}
                  onPointerDown={
                    disabled ? undefined : (e) => onDragStart(e, item, mode)
                  }
                  onKeyDown={(e) => keyboard(e, item, mode)}
                />
              ))}
          </>
        )}
      </div>
    );
  }
  return (
    <div className="calendar-week-events">
      {segments.map((item) => render(item))}
      {preview &&
        previewSpan &&
        render({ item: preview, ...previewSpan, lane: preview.lane }, true)}
    </div>
  );
}
