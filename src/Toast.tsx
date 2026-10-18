import { useCallback, useEffect, useState } from "react";
import { Check, LoaderCircle, Trash2 } from "lucide-react";

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

export function UndoToast({
  message,
  disabled = false,
  onUndo,
}: {
  message: string;
  disabled?: boolean;
  onUndo: () => void;
}) {
  return (
    <div className="toast" role="status" aria-atomic="true">
      <Trash2 size={16} aria-hidden="true" />
      <span>{message}</span>
      <button
        type="button"
        className="toast-action"
        disabled={disabled}
        onClick={onUndo}
      >
        실행취소
      </button>
    </div>
  );
}
