import { useEffect, useReducer } from "react";
import { serverNow } from "../platform/api";

// A task stays marked as new for 12 hours after it was created.
export const NEW_TASK_PERIOD_MS = 12 * 60 * 60 * 1000;

// Excel import derives task IDs from the import (stableId in
// shared/transfer/workbook.mjs), giving UUID version 5. Tasks added in the app
// use crypto.randomUUID (version 4). The ID reaches the other site unchanged,
// so both sites leave imported rows unmarked without a stored flag.
export const isImportedTaskId = (id: string) => id.charAt(14) === "5";

type NewTaskSource = { id: string; createdAt?: string | null };

// When the new mark ends, or null if the task is not a new app-added task.
export function newTaskUntil(task: NewTaskSource | null | undefined) {
  if (!task?.createdAt || isImportedTaskId(task.id)) return null;
  const created = Date.parse(task.createdAt);
  return Number.isFinite(created) ? created + NEW_TASK_PERIOD_MS : null;
}

// Uses the server clock, so a wrong device clock neither keeps nor hides the
// mark. Only new tasks hold a timer, which drops the mark when it expires.
export function useNewTask(task: NewTaskSource | null | undefined) {
  const until = newTaskUntil(task);
  const [, expire] = useReducer((count: number) => count + 1, 0);
  const active = until !== null && until > Date.parse(serverNow());
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    // Each API response re-anchors the server clock, so the timer can fire a
    // little early; it then waits for the rest instead of keeping the mark.
    const check = () => {
      const left = until! - Date.parse(serverNow());
      if (left > 0) timer = setTimeout(check, left + 50);
      else expire();
    };
    check();
    return () => clearTimeout(timer);
  }, [active, until]);
  return active;
}

// CSS draws the text, like the presence name tag, so it stays out of the
// cell and title text (textContent) that copy, search and checks read.
export default function NewTaskMark() {
  return <span className="task-new-mark" aria-hidden="true" />;
}

// For lists that render each task in a loop, where a hook cannot be called.
export function NewTaskMarkFor({ task }: { task: NewTaskSource }) {
  return useNewTask(task) ? <NewTaskMark /> : null;
}
