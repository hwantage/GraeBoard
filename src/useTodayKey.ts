import { useEffect, useState } from "react";
import { todayKey } from "../shared/domain.js";

// Keep the period picker and sheet highlight aligned across Seoul midnight,
// including an open copy sheet and tabs resumed after the browser was asleep.
export function useTodayKey() {
  const [today, setToday] = useState(todayKey);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      clearTimeout(timer);
      const date = todayKey();
      setToday(date);
      const nextMidnight = Date.parse(`${date}T00:00:00+09:00`) + 86400000;
      timer = setTimeout(refresh, Math.max(1, nextMidnight - Date.now()));
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return today;
}
