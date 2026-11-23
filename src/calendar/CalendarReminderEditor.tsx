import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { X } from "lucide-react";
import { api, ApiError, send } from "../platform/api";
import { useSite } from "../platform/site-context";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import Select from "../ui/Select";
import {
  CALENDAR_REMINDER_OPTIONS,
  CALENDAR_TIME_PATTERN,
  calendarReminderLabel,
} from "../../shared/calendar/calendar.js";
import type { CalendarEntry } from "./calendar-types";

export type CalendarReminderHandle = { flush: () => Promise<boolean> };
type Schedule = { time: string | null; remindMinutes: number | null };
type PushAddress = {
  enabled: boolean;
  ip: string | null;
  manual: boolean;
  detectedIp: string | null;
};
const scheduleOf = (entry: CalendarEntry): Schedule => ({
  time: entry.time ?? null,
  remindMinutes: entry.remindMinutes ?? null,
});
const same = (a: Schedule, b: Schedule) =>
  a.time === b.time && a.remindMinutes === b.remindMinutes;

// The start time of an entry and its reminder. Both sites save the same
// setting; the reminder itself is pushed by the internal server through the
// Dabada hub to the PC registered for each person.
export default function CalendarReminderEditor({
  entry,
  readOnly,
  onSaved,
  ref,
}: {
  entry: CalendarEntry;
  readOnly: boolean;
  onSaved: (saved: CalendarEntry) => void;
  ref: Ref<CalendarReminderHandle>;
}) {
  const path = `/calendar/entries/${entry.id}`;
  const site = useSite();
  const base = useRef(scheduleOf(entry));
  const draft = useRef(base.current);
  const [schedule, setSchedule] = useState(base.current);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function change(next: Schedule) {
    draft.current = next;
    setSchedule(next);
    setSaved(false);
  }
  async function flush(): Promise<boolean> {
    if (inFlight.current) return (await inFlight.current) ? flush() : false;
    if (same(draft.current, base.current)) return true;
    if (readOnly) return false;
    // A time still being typed is not a time yet.
    if (
      draft.current.time !== null &&
      !CALENDAR_TIME_PATTERN.test(draft.current.time)
    ) {
      setError("시작 시각을 시:분으로 입력하세요.");
      return false;
    }
    const submitted = { ...draft.current };
    setSaving(true);
    inFlight.current = (async () => {
      try {
        const result = await send<CalendarEntry>(
          path,
          {
            ...submitted,
            expectedTime: base.current.time,
            expectedRemindMinutes: base.current.remindMinutes,
          },
          "PATCH",
        );
        base.current = scheduleOf(result);
        onSaved(result);
        if (alive.current) {
          setError("");
          setSaved(true);
        }
        return true;
      } catch (e) {
        // Another change won: show it instead of this one.
        if (e instanceof ApiError && e.status === 409) {
          try {
            const latest = await api<CalendarEntry>(path);
            base.current = scheduleOf(latest);
            draft.current = base.current;
            onSaved(latest);
            if (alive.current) setSchedule(base.current);
          } catch {
            /* The message below still tells what happened. */
          }
        }
        if (alive.current) setError((e as Error).message);
        return false;
      } finally {
        inFlight.current = null;
        if (alive.current) setSaving(false);
      }
    })();
    return (await inFlight.current) ? flush() : false;
  }
  useImperativeHandle(ref, () => ({ flush }));
  const reminding = schedule.remindMinutes !== null;
  return (
    <div className="calendar-range-editor calendar-reminder-editor">
      <fieldset
        disabled={saving}
        aria-label="일정 시각과 알림"
        onBlur={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null) &&
            !readOnly
          )
            void flush();
        }}
      >
        <label>
          시작 시각
          <input
            type="time"
            aria-label="일정 시작 시각"
            value={schedule.time ?? ""}
            readOnly={readOnly}
            onChange={(e) =>
              change(
                e.target.value
                  ? { ...draft.current, time: e.target.value }
                  : { time: null, remindMinutes: null },
              )
            }
          />
        </label>
        <label>
          알림
          <Select
            aria-label="일정 알림"
            value={schedule.remindMinutes ?? ""}
            disabled={readOnly || schedule.time === null}
            onChange={(e) => {
              change({
                ...draft.current,
                remindMinutes:
                  e.target.value === "" ? null : Number(e.target.value),
              });
              void flush();
            }}
          >
            <option value="">알림 없음</option>
            {CALENDAR_REMINDER_OPTIONS.map((minutes: number) => (
              <option key={minutes} value={minutes}>
                {calendarReminderLabel(minutes)}
              </option>
            ))}
          </Select>
        </label>
        {schedule.time !== null && !readOnly && (
          <Button
            className="calendar-reminder-clear"
            title="시작 시각 지우기"
            onClick={() => {
              change({ time: null, remindMinutes: null });
              void flush();
            }}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        )}
        {saving && <span role="status">시각 저장 중…</span>}
        {saved && same(schedule, base.current) && (
          <span role="status">시각 저장됨</span>
        )}
      </fieldset>
      <ErrorNote error={error} />
      {reminding &&
        (site.external ? (
          <p className="calendar-reminder-note">
            알림은 사내망에서 다바다 푸시로 전달됩니다. 받을 PC는 사내
            그래보드에 접속하면 등록됩니다.
          </p>
        ) : (
          <CalendarPushAddress teamEntry={entry.userId === null} />
        ))}
    </div>
  );
}

// Where this person's reminders are pushed: the PC they use the internal site
// from, unless they name another address.
function CalendarPushAddress({ teamEntry }: { teamEntry: boolean }) {
  const [address, setAddress] = useState<PushAddress | null>(null);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<PushAddress>("/push-address", { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setAddress(data);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const save = (ip: string | null) =>
    run(async () => {
      setAddress(await send<PushAddress>("/push-address", { ip }, "PUT"));
      setEditing(false);
    });
  if (!address) return <ErrorNote error={error} />;
  return (
    <div className="calendar-reminder-note">
      {!address.enabled ? (
        <p>
          이 서버에는 다바다 푸시가 설정되지 않아 알림이 전달되지 않습니다.
          관리자에게 문의하세요.
        </p>
      ) : (
        <>
          <p>
            {teamEntry
              ? "팀 일정 알림은 팀원 모두에게 다바다 푸시로 전달됩니다. "
              : "알림은 다바다 푸시로 전달됩니다. "}
            내 알림을 받는 PC:{" "}
            <strong>{address.ip ?? "아직 등록되지 않음"}</strong>
            {address.ip && (address.manual ? " (직접 지정)" : " (자동)")}
          </p>
          {editing ? (
            <form
              className="calendar-reminder-address"
              onSubmit={(event) => {
                event.preventDefault();
                void save(input.trim());
              }}
            >
              <input
                aria-label="알림을 받을 PC의 IP 주소"
                placeholder="예: 10.0.0.12"
                value={input}
                maxLength={45}
                onChange={(e) => setInput(e.target.value)}
              />
              <Button type="submit" disabled={busy || !input.trim()}>
                저장
              </Button>
              <Button disabled={busy} onClick={() => setEditing(false)}>
                취소
              </Button>
            </form>
          ) : (
            <div className="calendar-reminder-address">
              <Button
                disabled={busy}
                onClick={() => {
                  setInput(address.ip ?? address.detectedIp ?? "");
                  setEditing(true);
                }}
              >
                주소 변경
              </Button>
              {address.manual && (
                <Button disabled={busy} onClick={() => void save(null)}>
                  접속한 PC로 자동 지정
                </Button>
              )}
              {address.ip && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await send("/push-address/test", {});
                      setNotice("테스트 알림을 보냈습니다.");
                    })
                  }
                >
                  테스트 알림
                </Button>
              )}
              {notice && <span role="status">{notice}</span>}
            </div>
          )}
        </>
      )}
      <ErrorNote error={error} />
    </div>
  );
}
