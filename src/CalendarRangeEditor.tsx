import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { api, ApiError, send } from "./api";
import { Button, ErrorNote } from "./components";
import type { CalendarEntry, CalendarEntryUpdate } from "./calendar-types";
import type { CalendarRange } from "./useCalendarDrag";

export type CalendarRangeHandle = {
  flush: () => Promise<boolean>;
  persistDraft: () => boolean;
};
const same = (a: CalendarRange, b: CalendarRange) =>
  a.date === b.date && a.endDate === b.endDate;
const valid = (range: CalendarRange) =>
  [range.date, range.endDate].every(
    (date) =>
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      !Number.isNaN(Date.parse(date)) &&
      new Date(`${date}T12:00:00Z`).toISOString().startsWith(date),
  ) && range.date <= range.endDate;

export default function CalendarRangeEditor({
  entry,
  userId,
  readOnly,
  onSaved,
  onCloseWithDraft,
  ref,
}: {
  entry: CalendarEntry;
  userId: string;
  readOnly: boolean;
  onSaved: (saved: CalendarEntryUpdate) => void;
  onCloseWithDraft: () => void;
  ref: Ref<CalendarRangeHandle>;
}) {
  const key = `weekly-plan:calendar-range:${userId}:${entry.teamId}:${entry.id}`;
  const path = `/calendar/entries/${entry.id}`;
  const base = useRef<CalendarRange>({
    date: entry.date,
    endDate: entry.endDate,
  });
  const draft = useRef(base.current);
  const [range, setRange] = useState(base.current);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<CalendarRange | null>(null);
  const conflictRef = useRef<CalendarRange | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const alive = useRef(true);
  function persistDraft() {
    try {
      if (same(draft.current, base.current)) sessionStorage.removeItem(key);
      else
        sessionStorage.setItem(
          key,
          JSON.stringify({ range: draft.current, base: base.current }),
        );
      return true;
    } catch {
      if (alive.current)
        setError(
          "기간을 임시 보관할 수 없습니다. 저장하거나 날짜를 복사한 뒤 닫아 주세요.",
        );
      return false;
    }
  }
  useEffect(() => {
    alive.current = true;
    try {
      const restored = JSON.parse(sessionStorage.getItem(key) || "null");
      if (
        restored?.range &&
        typeof restored.range.date === "string" &&
        typeof restored.range.endDate === "string"
      ) {
        draft.current = restored.range;
        setRange(restored.range);
        if (readOnly && !same(restored.range, base.current))
          setError(
            "현재는 읽기 전용입니다. 보관된 기간을 확인하고 초안을 보관한 채 닫아 주세요.",
          );
        if (
          !same(restored.range, base.current) &&
          (!restored.base || !same(restored.base, base.current))
        ) {
          conflictRef.current = base.current;
          setConflict(base.current);
          setError(
            "서버의 일정 기간이 바뀌었습니다. 보관된 기간과 비교해 주세요.",
          );
        }
      }
    } catch {
      /* Optional draft. */
    }
    const unload = (event: BeforeUnloadEvent) => {
      if (same(draft.current, base.current)) return;
      persistDraft();
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      alive.current = false;
      window.removeEventListener("beforeunload", unload);
    };
  }, [key]);
  async function flush(): Promise<boolean> {
    if (inFlight.current) return (await inFlight.current) ? flush() : false;
    if (same(draft.current, base.current)) return true;
    if (readOnly || conflictRef.current) return false;
    if (!valid(draft.current)) {
      setError(
        "유효한 시작일과 종료일을 입력하세요. 종료일은 시작일 이후여야 합니다.",
      );
      return false;
    }
    const submitted = { ...draft.current };
    const expected = { ...base.current };
    setSaving(true);
    inFlight.current = (async () => {
      try {
        const result = await send<CalendarEntryUpdate>(
          path,
          {
            ...submitted,
            expectedDate: expected.date,
            expectedEndDate: expected.endDate,
          },
          "PATCH",
        );
        base.current = { date: result.date, endDate: result.endDate };
        persistDraft();
        onSaved(result);
        if (alive.current) {
          setError("");
          setSaved(true);
        }
        return true;
      } catch (e) {
        if (alive.current) {
          setError((e as Error).message);
          if (e instanceof ApiError && e.details?.currentRange) {
            const latest = e.details.currentRange as CalendarRange;
            conflictRef.current = latest;
            setConflict(latest);
          }
        }
        return false;
      } finally {
        inFlight.current = null;
        if (alive.current) setSaving(false);
      }
    })();
    return (await inFlight.current) ? flush() : false;
  }
  useImperativeHandle(ref, () => ({ flush, persistDraft }));
  function acceptServerRange() {
    if (inFlight.current) return;
    setSaving(true);
    inFlight.current = api<CalendarEntryUpdate>(
      `${path}?${new URLSearchParams({ placements: "1", from: base.current.date, to: base.current.endDate })}`,
    )
      .then((latest) => {
        if (!alive.current) return false;
        base.current = { date: latest.date, endDate: latest.endDate };
        draft.current = base.current;
        setRange(base.current);
        conflictRef.current = null;
        setConflict(null);
        setError("");
        persistDraft();
        onSaved(latest);
        return true;
      })
      .catch((e) => {
        if (alive.current) setError(e.message);
        return false;
      })
      .finally(() => {
        inFlight.current = null;
        if (alive.current) setSaving(false);
      });
  }
  const changed = !same(range, base.current);
  return (
    <div className="calendar-range-editor">
      <fieldset disabled={saving} aria-label="일정 기간">
        {(["date", "endDate"] as const).map((field) => (
          <label key={field}>
            {field === "date" ? "시작일" : "종료일"}
            <input
              type="date"
              aria-label={`일정 ${field === "date" ? "시작일" : "종료일"}`}
              value={range[field]}
              readOnly={readOnly}
              onChange={(e) => {
                draft.current = { ...draft.current, [field]: e.target.value };
                setRange(draft.current);
                setSaved(false);
                persistDraft();
              }}
            />
          </label>
        ))}
        {!readOnly && (
          <Button
            disabled={!changed || saving || !!conflict}
            onClick={() => void flush()}
          >
            {saving ? "기간 저장 중…" : "기간 저장"}
          </Button>
        )}
        {saved && !changed && <span role="status">기간 저장됨</span>}
      </fieldset>
      <ErrorNote error={error} />
      {error && <Button onClick={onCloseWithDraft}>초안 보관하고 닫기</Button>}
      {conflict && (
        <div className="document-conflict">
          <p>
            최신 서버 기간: {conflict.date} ~ {conflict.endDate}
          </p>
          {!readOnly && (
            <Button
              disabled={saving}
              onClick={() => {
                base.current = conflict;
                conflictRef.current = null;
                setConflict(null);
                void flush();
              }}
            >
              내 기간으로 최신 기간 교체
            </Button>
          )}
          <Button disabled={saving} onClick={acceptServerRange}>
            서버 기간 사용
          </Button>
        </div>
      )}
    </div>
  );
}
