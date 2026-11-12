import { useSite } from "../platform/site-context";
import { useEffect, useState } from "react";
import { api } from "../platform/api";
import { syncTime, type SyncStatus } from "./sync-types";
import SyncConflictBox from "./SyncConflictBox";
import type { User } from "../types";

export default function TeamSyncIndicator({
  teamId,
  saving,
  failed,
  canResolve = false,
  people = [],
}: {
  teamId: string;
  saving: boolean;
  failed: boolean;
  // Team leads and admins may open the conflict box from the warning.
  canResolve?: boolean;
  people?: User[];
}) {
  const { external } = useSite();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [conflictsOpen, setConflictsOpen] = useState(false);
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
  // 좁은 화면에서는 단계 이름(data-short)만 보이고 전체 문구는 툴팁·화면 낭독기로 전한다.
  const stages = [
    { label: local, short: external ? "외부" : "내부", complete: stored },
    { label: git, short: "Git", complete: published },
    { label: peer, short: external ? "내부" : "외부", complete: reflected },
  ];
  // 단계별 title은 상위 상세 툴팁을 가리므로, 전체 단계 문구를 상세 툴팁 첫 줄에 둔다.
  const title = problem
    ? detail
    : `${stages.map((stage) => stage.label).join(" · ")}\n${detail}`;
  const indicator = (
    <span
      className="team-sync-indicator"
      role="status"
      aria-label="팀 동기화 상태"
      aria-atomic="true"
      title={title}
    >
      {problem ? (
        <span className="tag team-sync-problem">{problem}</span>
      ) : (
        stages.map((stage, index) => (
          <span
            key={index}
            className={`tag team-sync-stage${stage.complete ? " is-complete" : ""}`}
            data-short={stage.short}
          >
            <span className="team-sync-label">{stage.label}</span>
          </span>
        ))
      )}
    </span>
  );
  if (!status?.conflicts || !canResolve) return indicator;
  return (
    <>
      {indicator}
      <button
        type="button"
        className="tag team-sync-conflict-open"
        onClick={() => setConflictsOpen(true)}
      >
        충돌 보관함
      </button>
      {conflictsOpen && (
        <SyncConflictBox
          teamId={teamId}
          people={people}
          onClose={() => setConflictsOpen(false)}
        />
      )}
    </>
  );
}
