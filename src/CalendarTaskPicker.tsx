import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { addDays } from "../shared/calendar.js";
import { normalizeSearchQuery } from "../shared/search.js";
import { api, send } from "./api";
import { busyProps } from "./busyProps";
import { Button, ErrorNote, Modal } from "./components";
import type {
  CalendarTaskOption,
  WeeklyAddResult,
  WeeklyItem,
} from "./calendar-types";

type TaskPage = { tasks: CalendarTaskOption[]; nextOffset: number | null };

export default function CalendarTaskPicker({
  teamId,
  userId,
  ownerName,
  weekStart,
  onAdded,
  onClose,
}: {
  teamId: string;
  userId: string;
  ownerName: string;
  weekStart: string;
  onAdded: (weekly: WeeklyItem[]) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<
    (TaskPage & { key: string; error: string }) | null
  >(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const alive = useRef(true);
  const q = normalizeSearchQuery(input);
  const key = JSON.stringify([teamId, userId, weekStart, q, offset, attempt]);
  const ready = result?.key === key;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        void api<TaskPage>(
          `/calendar/tasks?${new URLSearchParams({ teamId, userId, weekStart, q, offset: String(offset) })}`,
          { signal: controller.signal },
        )
          .then((page) => {
            if (!controller.signal.aborted)
              setResult({ ...page, key, error: "" });
          })
          .catch((e: Error) => {
            if (!controller.signal.aborted)
              setResult({ key, tasks: [], nextOffset: null, error: e.message });
          });
      },
      q ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);
  async function add() {
    if (saving.current || !selected.length) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await send<WeeklyAddResult>("/calendar/weekly", {
        teamId,
        userId,
        weekStart,
        taskIds: selected,
      });
      if (!alive.current) return;
      onAdded(saved.weekly);
      onClose();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Modal
      title="주간 업무 추가"
      initialFocus={search}
      onClose={() => {
        if (!saving.current) onClose();
      }}
    >
      <p className="calendar-hint">
        {ownerName} · {weekStart} ~ {addDays(weekStart, 6)}
      </p>
      <label className="user-search calendar-task-search">
        <Search size={15} aria-hidden="true" />
        <input
          ref={search}
          type="search"
          aria-label="업무 제목 검색"
          placeholder="업무 제목 검색"
          maxLength={120}
          value={input}
          {...busyProps(busy)}
          onChange={(event) => {
            setInput(event.target.value);
            setOffset(0);
          }}
        />
      </label>
      <div
        className="calendar-task-options"
        aria-label="추가할 업무"
        aria-busy={!ready}
      >
        {!ready ? (
          <p role="status" className="calendar-hint">
            업무를 불러오고 있습니다…
          </p>
        ) : (
          result.tasks.map((task) => (
            <label key={task.id} className="calendar-task-option">
              <input
                type="checkbox"
                aria-label={task.title}
                checked={task.added || selected.includes(task.id)}
                {...busyProps(
                  busy,
                  task.added ||
                    (selected.length >= 100 && !selected.includes(task.id)),
                )}
                onChange={(event) => {
                  setSelected((previous) =>
                    event.target.checked
                      ? [...previous, task.id]
                      : previous.filter((id) => id !== task.id),
                  );
                }}
              />
              <span>
                <strong>{task.title}</strong>
                <small>
                  {task.years.join(" · ")}
                  {task.added && " · 추가됨"}
                </small>
              </span>
            </label>
          ))
        )}
        {ready && !result.tasks.length && !result.error && (
          <p className="calendar-hint">
            {q ? "검색된 업무가 없습니다." : "추가할 업무가 없습니다."}
          </p>
        )}
      </div>
      {ready && result.error && (
        <>
          <ErrorNote error={result.error} />
          <Button
            {...busyProps(busy)}
            onClick={() => setAttempt((value) => value + 1)}
          >
            업무 목록 다시 불러오기
          </Button>
        </>
      )}
      {(offset > 0 || (ready && result.nextOffset !== null)) && (
        <div className="calendar-task-pages">
          <Button
            {...busyProps(busy || !ready, offset === 0)}
            onClick={() => setOffset((value) => Math.max(0, value - 50))}
          >
            이전
          </Button>
          <span>{offset / 50 + 1}페이지</span>
          <Button
            {...busyProps(busy || !ready, !ready || result.nextOffset === null)}
            onClick={() => {
              if (ready && result.nextOffset !== null)
                setOffset(result.nextOffset);
            }}
          >
            다음
          </Button>
        </div>
      )}
      <ErrorNote error={error} />
      <div className="calendar-actions">
        <Button
          {...busyProps(busy, !selected.length)}
          onClick={() => void add()}
        >
          {busy
            ? "추가 중…"
            : `선택한 업무 추가${selected.length ? ` (${selected.length})` : ""}`}
        </Button>
        <Button {...busyProps(busy)} onClick={onClose}>
          취소
        </Button>
      </div>
    </Modal>
  );
}
