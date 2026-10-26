import { useEffect, useState } from "react";
import { api } from "./api";
import { syncTime, type SyncStatus } from "./TeamSyncSettings";

export default function TeamSyncIndicator({
  teamId,
  saving,
  failed,
}: {
  teamId: string;
  saving: boolean;
  failed: boolean;
}) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      try {
        const next = await api<SyncStatus>(`/teams/${teamId}/sync`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setStatus(next);
          setUnavailable(false);
        }
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
      } finally {
        running = false;
      }
    };
    setStatus(null);
    void refresh();
    const timer = setInterval(refresh, 15000);
    window.addEventListener("graeboard:local-save", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("graeboard:local-save", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [teamId]);
  if (!status || status.mode === "unlinked") return null;
  const remote = status.remoteStatus;
  const reflected =
    remote?.verified &&
    remote.mode === "active" &&
    remote.appliedCanonicalHead === status.canonicalHead &&
    Date.now() - Date.parse(remote.observedAt) < 180000 &&
    status.pending === 0;
  const local = failed
    ? "로컬 저장 실패"
    : saving
      ? "로컬 저장 중"
      : "로컬 저장";
  const git = status.pending
    ? `Git 대기 ${status.pending}`
    : status.lastPublishedAt
      ? "Git 반영"
      : "Git 확인 대기";
  const peer = reflected && !unavailable ? "상대 반영 확인" : "상대 확인 대기";
  const detail = `${local} · ${git} · ${peer}\n로컬 저장: ${syncTime(status.lastLocalSavedAt)}\nGit 반영: ${syncTime(status.lastPublishedAt)}\n상대 마지막 확인: ${syncTime(remote?.observedAt)}${status.lastError ? `\n${status.lastError}` : ""}`;
  return (
    <span
      className="tag"
      style={{
        minWidth: 0,
        maxWidth: "min(24vw, 280px)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        display: "block",
        flexShrink: 1,
      }}
      role="status"
      aria-label="팀 동기화 상태"
      title={detail}
    >
      {unavailable
        ? "동기화 확인 불가"
        : status.mode === "paused"
          ? "동기화 일시정지"
          : status.mode === "recovery"
            ? "복구 점검 필요"
            : status.mode === "disconnected"
              ? "동기화 연결 해제"
              : status.conflicts
                ? `공유 충돌 ${status.conflicts}`
                : `${local} · ${git} · ${peer}`}
    </span>
  );
}
