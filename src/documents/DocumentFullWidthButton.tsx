import { useSyncExternalStore } from "react";
import { FoldHorizontal, UnfoldHorizontal } from "lucide-react";
import { Button } from "../components";

// Full-page documents use the window's whole width once this is turned on.
// The choice stays in this browser and applies to every full-page document:
// task details, calendar entries and memos.
const storageKey = "weekly-plan:document-full-width";
const listeners = new Set<() => void>();
// This page's choice when the browser blocks storage.
let current = false;
function stored() {
  try {
    return localStorage.getItem(storageKey) === "1";
  } catch {
    return current;
  }
}
function subscribe(listener: () => void) {
  const changed = (event: StorageEvent) => {
    if (
      event.storageArea === localStorage &&
      (event.key === storageKey || event.key === null)
    )
      listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", changed);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", changed);
  };
}
function setFullWidth(next: boolean) {
  current = next;
  try {
    localStorage.setItem(storageKey, next ? "1" : "0");
  } catch {
    // The width still changes for this page when storage is unavailable.
  }
  for (const listener of listeners) listener();
}

export function useDocumentFullWidth() {
  return useSyncExternalStore(subscribe, stored);
}

// Shown in a full-page header, left of its close button.
export default function DocumentFullWidthButton() {
  const fullWidth = useDocumentFullWidth();
  return (
    <Button
      className="document-full-width"
      tooltip={fullWidth ? "기본 너비로 보기" : "전체 너비로 보기"}
      aria-pressed={fullWidth}
      onClick={() => setFullWidth(!fullWidth)}
    >
      {fullWidth ? (
        <FoldHorizontal size={16} aria-hidden="true" />
      ) : (
        <UnfoldHorizontal size={16} aria-hidden="true" />
      )}
    </Button>
  );
}
