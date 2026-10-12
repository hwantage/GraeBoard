import { useEffect, useState } from "react";
import { CloudOff, LoaderCircle } from "lucide-react";

export default function SaveStatus({
  pending,
  failed,
}: {
  pending: boolean;
  failed: boolean;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!pending) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), 250);
    return () => window.clearTimeout(timer);
  }, [pending]);
  return (
    <div className="save-status-slot">
      {(failed || (pending && visible)) && (
        <div className={`save-status ${failed ? "failed" : ""}`} role="status">
          {failed ? (
            <>
              <CloudOff size={14} />
              저장 실패
            </>
          ) : (
            <>
              <LoaderCircle size={14} className="spin" />
              저장 중
            </>
          )}
        </div>
      )}
    </div>
  );
}
