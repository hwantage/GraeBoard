import { useEffect, useState } from "react";
import {
  readSecretCalendar,
  secretCalendarMode,
  secretCalendarModeKey,
  type SecretCalendarMode,
  secretCalendarChanged,
  secretCalendarKey,
  secretEntries,
  type SecretCalendarEntry,
} from "./secret-calendar";

import {
  secretDocumentSummaries,
  subscribeSecretDocuments,
} from "./secret-document-storage";

export default function useSecretCalendar(userId: string, teamId: string) {
  const key = `${userId}:${teamId}`;
  const [state, setState] = useState({
    key: "",
    entries: [] as SecretCalendarEntry[],
    mode: "all" as SecretCalendarMode,
    error: "",
  });
  useEffect(() => {
    let active = true;
    let sequence = 0;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const store = readSecretCalendar(userId);
        const entries = secretEntries(store, userId, teamId);
        let error = "";
        const summaries = await secretDocumentSummaries(userId, teamId).catch(
          (caught) => {
            error = (caught as Error).message;
            return new Map();
          },
        );
        if (!active || request !== sequence) return;
        setState({
          key,
          entries: entries.map((entry) => ({
            ...entry,
            ...summaries.get(entry.id),
          })),
          mode: secretCalendarMode(userId, store.visible),
          error,
        });
      } catch (error) {
        if (!active || request !== sequence) return;
        setState({
          key,
          entries: [],
          mode: "all" as SecretCalendarMode,
          error: (error as Error).message,
        });
      }
    };
    const storageChanged = (event: StorageEvent) => {
      if (
        event.storageArea === localStorage &&
        (event.key === secretCalendarKey(userId) ||
          event.key === secretCalendarModeKey(userId) ||
          event.key === null)
      )
        refresh();
    };
    const localChanged = (event: Event) => {
      if ((event as CustomEvent).detail === userId) refresh();
    };
    const unsubscribe = subscribeSecretDocuments(userId, () => void refresh());
    void refresh();
    window.addEventListener("storage", storageChanged);
    window.addEventListener(secretCalendarChanged, localChanged);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("storage", storageChanged);
      window.removeEventListener(secretCalendarChanged, localChanged);
    };
  }, [key, userId, teamId]);
  return state.key === key
    ? state
    : { entries: [], mode: "all" as SecretCalendarMode, error: "" };
}
