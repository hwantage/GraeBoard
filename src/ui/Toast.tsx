import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, CircleAlert, LoaderCircle, Trash2 } from "lucide-react";

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
  failed = false,
}: {
  message: string;
  pending?: boolean;
  failed?: boolean;
}) {
  return message ? (
    <div
      className="toast"
      role={failed ? "alert" : "status"}
      aria-atomic="true"
    >
      {pending ? (
        <LoaderCircle size={16} className="spin" aria-hidden="true" />
      ) : failed ? (
        <CircleAlert size={16} aria-hidden="true" />
      ) : (
        <Check size={16} aria-hidden="true" />
      )}
      <span>{message}</span>
    </div>
  ) : null;
}

export function UndoToast({
  message,
  icon = <Trash2 size={16} aria-hidden="true" />,
  actionLabel = "실행취소",
  disabled = false,
  onUndo,
}: {
  message: string;
  icon?: ReactNode;
  actionLabel?: string;
  disabled?: boolean;
  onUndo: () => void;
}) {
  return (
    <div className="toast" role="status" aria-atomic="true">
      {icon}
      <span>{message}</span>
      <button
        type="button"
        className="toast-action"
        disabled={disabled}
        onClick={onUndo}
      >
        {actionLabel}
      </button>
    </div>
  );
}
