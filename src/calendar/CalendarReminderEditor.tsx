import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { api, ApiError, send } from "../platform/api";
import { useSite } from "../platform/site-context";
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

// The start time of an entry and its reminders. Both sites save the same
// setting; the reminders themselves are pushed by the internal server through
// the Dabada hub to the PC each person uses the internal site from.
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
          if (settled) void flush();
        }}
      />
      {saving && <span role="status">알림 저장 중…</span>}
      {saved && sameSchedule(schedule, base.current) && (
        <span role="status">알림 저장됨</span>
      )}
      <ErrorNote error={error} />
      {schedule.reminders.length > 0 &&
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
// from, which the server registers by itself.
function CalendarPushAddress({ teamEntry }: { teamEntry: boolean }) {
  const [address, setAddress] = useState<PushAddress | null>(null);
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
  if (!address) return <ErrorNote error={error} />;
  if (!address.enabled)
    return (
      <p className="calendar-reminder-note">
        이 서버에는 다바다 푸시가 설정되지 않아 알림이 전달되지 않습니다.
        관리자에게 문의하세요.
      </p>
    );
  return (
    <div className="calendar-reminder-note">
      <p>
        {teamEntry
          ? "팀 일정 알림은 팀원 모두에게 다바다 푸시로 전달됩니다. "
          : "알림은 다바다 푸시로 전달됩니다. "}
        내 알림을 받는 PC:{" "}
        <strong>
          {address.ip ?? "아직 등록되지 않음(사내 PC에서 접속하면 등록)"}
        </strong>
      </p>
      {address.ip && (
        <div className="calendar-reminder-address">
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              setNotice("");
              try {
                await send("/push-address/test", {});
                setNotice("테스트 알림을 보냈습니다.");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            테스트 알림
          </Button>
          {notice && <span role="status">{notice}</span>}
        </div>
      )}
      <ErrorNote error={error} />
    </div>
  );
}
