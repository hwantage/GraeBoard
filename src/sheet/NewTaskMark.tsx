import { useEffect, useReducer, type ReactNode } from "react";
import { serverNowMs } from "../platform/api";

// A task stays marked as new for 12 hours after it was created.
export const NEW_TASK_PERIOD_MS = 12 * 60 * 60 * 1000;

// Excel import derives task IDs from the import (stableId in
// shared/transfer/workbook.mjs), giving UUID version 5. Tasks added in the app
// use crypto.randomUUID (version 4). The ID reaches the other site unchanged,
// so both sites leave imported rows unmarked without a stored flag.
export const isImportedTaskId = (id: string) => id.charAt(14) === "5";

type NewTaskSource = { id: string; createdAt?: string | null };

// When the new mark ends, or null if the task is not a new app-added task.
export function newTaskUntil(task: NewTaskSource) {
  if (!task.createdAt || isImportedTaskId(task.id)) return null;
  const created = Date.parse(task.createdAt);
  return Number.isFinite(created) ? created + NEW_TASK_PERIOD_MS : null;
}

// Uses the server clock, so a wrong device clock neither keeps nor hides the
// mark. Only new tasks hold a timer, which drops the mark when it expires.
export function useNewTask(task: NewTaskSource) {
  return useNewUntil(newTaskUntil(task));
}

// Team files share the task marker's server clock and expiry, with no task ID rules.
export function useRecentCreation(createdAt: string) {
  const created = Date.parse(createdAt);
  return useNewUntil(
    Number.isFinite(created) ? created + NEW_TASK_PERIOD_MS : null,
  );
}

function useNewUntil(until: number | null) {
  const [, update] = useReducer((count: number) => count + 1, 0);
  const now = serverNowMs();
  const starts = until === null ? null : until - NEW_TASK_PERIOD_MS;
  const active =
    starts !== null && until !== null && starts <= now && now < until;
  const next = active ? until : starts !== null && starts > now ? starts : null;
  useEffect(() => {
    if (next === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const left = next - serverNowMs();
      if (left > 0) timer = setTimeout(check, Math.min(left, 60_000) + 50);
      else update();
    };
    check();
    return () => clearTimeout(timer);
  }, [next]);
  return active;
}

// What assistive technology hears for the mark.
export const NEW_TASK_LABEL = "새 업무";

// CSS draws the text, like the presence name tag, so it stays out of the
// cell and title text (textContent) that copy, search and checks read. Where
// the surrounding element already describes the task, the mark is hidden;
// standing alone it is announced through its label.
export default function NewTaskMark({ labelled = false }) {
  return labelled ? (
    <span className="task-new-mark" role="img" aria-label={NEW_TASK_LABEL} />
  ) : (
    <span className="task-new-mark" aria-hidden="true" />
  );
}

// For lists that render each task in a loop, where a hook cannot be called.
export function NewTaskState({
  task,
  children,
}: {
  task: NewTaskSource;
  children: (isNew: boolean) => ReactNode;
}) {
  return <>{children(useNewTask(task))}</>;
}
