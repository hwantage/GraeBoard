import { useSite } from "./site-context";
import { useEffect, useState } from "react";
import { api } from "./api";
import { syncTime, type SyncStatus } from "./sync-types";

export default function TeamSyncIndicator({
  teamId,
  saving,
  failed,
}: {
  teamId: string;
  saving: boolean;
  failed: boolean;
}) {
  const { external } = useSite();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    let unlinked = false;
    let timer: ReturnType<typeof setTimeout>;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      try {
        const next = await api<SyncStatus>(`/teams/${teamId}/sync`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          unlinked = next.mode === "unlinked";
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
    setUnavailable(false);
    const poll = async () => {
      await refresh();
      if (!controller.signal.aborted)
        timer = setTimeout(poll, !external && unlinked ? 60000 : 15000);
    };
    const saved = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(refresh, 2000);
    };
    void poll();
    if (external) window.addEventListener("graeboard:local-save", saved);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(saveTimer);
      if (external) window.removeEventListener("graeboard:local-save", saved);
      window.removeEventListener("focus", refresh);
    };
  }, [teamId, external]);
  const problem = unavailable
    ? "동기화 확인 불가"
    : status?.mode === "paused"
      ? "동기화 일시정지"
      : status?.mode === "recovery"
        ? "복구 점검 필요"
        : status?.mode === "disconnected"
          ? "동기화 연결 해제"
          : status?.conflicts
            ? `공유 충돌 ${status.conflicts}`
            : status?.lastError
              ? "외부 동기화 오류"
              : "";
  if (!problem && (!external || !status || status.mode === "unlinked"))
    return null;
  const remote = status?.remoteStatus;
  const stored = !saving && !failed;
  const published = stored && !status?.pending && !!status?.lastPublishedAt;
  const reflected =
    stored &&
    remote?.verified &&
    remote.mode === "active" &&
    remote.appliedCanonicalHead === status?.canonicalHead &&
    Date.now() - Date.parse(remote.observedAt) < 180000 &&
    status?.pending === 0;
  const storage = external ? "외부 클라우드 저장" : "내부 서버 저장";
  const target = external ? "내부망" : "외부망";
  const local = failed ? `${storage} 실패` : saving ? `${storage} 중` : storage;
  const git = status?.pending
    ? `Git 대기 ${status.pending}`
    : !stored
      ? "Git 대기"
      : status?.lastPublishedAt
        ? "Git 반영"
        : "Git 확인 대기";
  const peer = `${target} 반영 ${reflected ? "완료" : "대기"}`;
  const detail = status
    ? `${storage}: ${syncTime(status.lastLocalSavedAt)}\nGit 반영: ${syncTime(status.lastPublishedAt)}\n${target} 마지막 확인: ${syncTime(remote?.observedAt)}${status.lastError ? `\n${status.lastError}` : ""}`
    : "동기화 상태를 확인할 수 없습니다.";
  const stages = [
    { label: local, complete: stored },
    { label: git, complete: published },
    { label: peer, complete: reflected },
  ];
  return (
    <span
      className="team-sync-indicator"
      role="status"
      aria-label="팀 동기화 상태"
      aria-atomic="true"
      title={detail}
    >
      {problem ? (
        <span className="tag team-sync-problem">{problem}</span>
      ) : (
        stages.map((stage, index) => (
          <span
            key={index}
            className={`tag team-sync-stage${stage.complete ? " is-complete" : ""}`}
          >
            {stage.label}
          </span>
        ))
      )}
    </span>
  );
}
