import { useCallback, useEffect, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";

export function useToast() {
  const [notice, setNotice] = useState<{ message: string } | null>(null);
  const notify = useCallback((message: string) => {
    // 같은 문구를 연속으로 알려도 표시 시간을 다시 시작한다.
    setNotice(message ? { message } : null);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  return [notice?.message || "", notify] as const;
}

export default function Toast({
  message,
  pending = false,
}: {
  message: string;
  pending?: boolean;
}) {
  return message ? (
    <div className="toast" role="status" aria-atomic="true">
      {pending ? (
        <LoaderCircle size={16} className="spin" aria-hidden="true" />
      ) : (
        <Check size={16} aria-hidden="true" />
      )}
      <span>{message}</span>
    </div>
  ) : null;
}
