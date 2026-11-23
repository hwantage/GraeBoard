import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { api, ApiError, send } from "../platform/api";
import { useSite } from "../platform/site-context";
import { Bell } from "lucide-react";
import { Button } from "../ui/Button";
import { ErrorNote } from "../ui/ErrorNote";
import CalendarScheduleFields, {
  sameSchedule,
  validSchedule,
  type CalendarSchedule,
} from "./CalendarScheduleFields";
import type { CalendarEntry } from "./calendar-types";

export type CalendarReminderHandle = { flush: () => Promise<boolean> };
type PushAddress = { enabled: boolean; ip: string | null };
const scheduleOf = (entry: CalendarEntry): CalendarSchedule => ({
  time: entry.time ?? null,
  reminders: entry.reminders ?? [],
});

// What each state of the bell says about the entry's reminders.
const REMINDER_STATES = {
  pending: "알림 대기 중",
  sent: "모든 알림 전송 성공",
  failed: "알림 전송 실패(받을 PC 없음 또는 시각이 지나도록 전송 못 함)",
} as const;

// The start time of an entry and its reminders. Both sites save the same
// setting; the reminders themselves are pushed by the internal server through
// the Dabada hub to the PC each person uses the internal site from. The
// switch sits beside the entry's dates and the rest opens on the next line.
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
  // Where this person's reminders are pushed, which the internal server
  // registers by itself.
  const [address, setAddress] = useState<PushAddress | null>(null);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState("");
  // How this entry's reminders stand, as the card's bell shows it.
  const [reminderStatus, setReminderStatus] = useState(
    entry.reminderStatus ?? null,
  );
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    if (!site.external)
      void api<PushAddress>("/push-address", { signal: controller.signal })
        .then((data) => {
          if (!controller.signal.aborted) setAddress(data);
        })
        .catch(() => {
          /* The reminders are saved all the same. */
        });
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [site.external]);
  async function flush(): Promise<boolean> {
    if (inFlight.current) return (await inFlight.current) ? flush() : false;
    if (sameSchedule(draft.current, base.current)) return true;
    if (readOnly) return false;
    // A time still being typed is not a time yet.
    if (!validSchedule(draft.current)) {
      setError("시작 시각을 시:분으로 입력하세요.");
      return false;
    }
    const submitted = draft.current;
    setSaving(true);
    inFlight.current = (async () => {
      try {
        const result = await send<CalendarEntry>(
          path,
          {
            ...submitted,
            expectedTime: base.current.time,
            expectedReminders: base.current.reminders,
          },
          "PATCH",
        );
        base.current = scheduleOf(result);
        setReminderStatus(result.reminderStatus ?? null);
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
  const on = schedule.time !== null;
  const reminding = on && schedule.reminders.length > 0;
  const destination = !reminding
    ? ""
    : site.external
      ? "알림은 사내망에서 다바다 푸시로 전달됩니다. 받을 PC는 사내 그래보드에 접속하면 등록됩니다."
      : !address
        ? ""
        : !address.enabled
          ? "이 서버에는 다바다 푸시가 설정되지 않아 알림이 전달되지 않습니다."
          : `${
              entry.userId === null
                ? "팀 일정 알림은 팀원 모두에게 다바다 푸시로 전달됩니다."
                : "알림은 다바다 푸시로 전달됩니다."
            } 내 알림을 받는 PC: ${address.ip ?? "아직 등록되지 않음"}`;
  // One line: where the reminders go and what was just saved or sent.
  const status = saving
    ? "알림 저장 중…"
    : notice ||
      (saved && sameSchedule(schedule, base.current) ? "알림 저장됨" : "");
  return (
    <div
      className="calendar-reminder-editor"
      onBlur={(event) => {
        // A typed time is saved on leaving the fields.
        if (
          !event.currentTarget.contains(event.relatedTarget as Node | null) &&
          !readOnly
        )
          void flush();
      }}
    >
      <CalendarScheduleFields
        value={schedule}
        readOnly={readOnly}
        onChange={(next, settled) => {
          draft.current = next;
          setSchedule(next);
          setSaved(false);
          setNotice("");
          if (settled) void flush();
        }}
        actions={
          reminding &&
          address?.enabled &&
          address.ip && (
            <Button
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                setError("");
                setNotice("");
                try {
                  await send("/push-address/test", {});
                  if (alive.current) setNotice("테스트 알림을 보냈습니다.");
                } catch (e) {
                  if (alive.current) setError((e as Error).message);
                } finally {
                  if (alive.current) setTesting(false);
                }
              }}
            >
              테스트 알림
            </Button>
          )
        }
      />
      {/* Nothing to tell once the start reminder is off. */}
      {on && (destination || status) && (
        <p className="calendar-reminder-note">
          {destination}
          {destination && status && " · "}
          {status && <span role="status">{status}</span>}
          {/* How this entry's reminders stand, with the bell its card shows. */}
          {reminding && reminderStatus && (
            <span
              className="calendar-reminder-current"
              data-status={reminderStatus}
            >
              {" · "}
              <span
                className="calendar-reminder-bell"
                data-status={reminderStatus}
              >
                <Bell size={11} aria-hidden="true" />
              </span>
              {REMINDER_STATES[reminderStatus]}
            </span>
          )}
        </p>
      )}
      <ErrorNote error={error} />
    </div>
  );
}
