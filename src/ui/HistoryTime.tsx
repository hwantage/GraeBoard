import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const HistoryNow = createContext(0);

export function HistoryTimeline({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // A single clock updates timestamps without rendering the change details again.
  return (
    <HistoryNow.Provider value={now}>
      <div className="audit-list">{children}</div>
    </HistoryNow.Provider>
  );
}

function relativeTime(iso: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 1) return "방금";
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}일 전`;
  if (seconds < 86400 * 365)
    return `${Math.floor(seconds / (86400 * 30))}개월 전`;
  return `${Math.floor(seconds / (86400 * 365))}년 전`;
}

export default function HistoryTime({
  iso,
  timeZone,
}: {
  iso: string;
  timeZone?: string;
}) {
  const now = useContext(HistoryNow);
  return (
    <span className="audit-timestamp">
      <span className="audit-relative-time">{relativeTime(iso, now)}</span>
      <time dateTime={iso}>
        {new Date(iso).toLocaleString("ko-KR", { timeZone })}
      </time>
    </span>
  );
}
