import TeamSetupKey from "./TeamSetupKey";
import { useEffect, useRef, useState } from "react";
import { Plug, RefreshCw } from "lucide-react";
import { api, send, isExternalSite } from "./api";
import { Button, ErrorNote } from "./components";
import LoadingState from "./LoadingState";
import Select from "./Select";
import { busyProps } from "./busyProps";
import type { Team, User } from "./types";
import { canManageTeam } from "../shared/domain.js";
import "./team-sync-settings.css";

export type ResourceProfile = {
  profileId: string;
  name?: string;
  teamId: string;
  repository?: string;
  database?: string | { provider?: string; binding?: string };
  images?: string | { provider?: string; binding?: string };
  ready?: boolean;
  replaces?: string;
};
export type ConnectionCheck = {
  ready: boolean;
  checks: {
    name: string;
    status: "ok" | "error" | "pending";
    message: string;
  }[];
};
export type SyncStatus = {
  mode:
    | "unlinked"
    | "initializing"
    | "importing"
    | "active"
    | "paused"
    | "recovery"
    | "disconnected";
  siteId?: string;
  siteName?: string;
  profileId?: string;
  canReconnect?: boolean;
  canonicalHead?: string | null;
  pending: number;
  conflicts: number;
  lastLocalSavedAt?: string | null;
  lastReceivedAt?: string | null;
  lastPublishedAt?: string | null;
  lastError?: string | null;
  remoteStatus?: {
    observedAt: string;
    mode: string;
    appliedCanonicalHead: string;
    verified: boolean;
  } | null;
};
type SwitchJob = {
  jobId: string;
  phase: string;
  hasMore: boolean;
  error?: string;
};
type Connection = {
  profileId: string;
  revision: number;
  profiles: ResourceProfile[];
  switchJob?: SwitchJob | null;
};
type Conflict = {
  conflictId: string;
  opId: string;
  createdAt: string;
  target: string;
  result: string;
  base: unknown;
  current: unknown;
  desired: unknown;
  expectedHead: string;
  frontier?: string[];
  resolved?: boolean;
};
const modes: Record<SyncStatus["mode"], string> = {
  unlinked: "미연결",
  initializing: "초기 게시 중",
  importing: "가져오는 중",
  active: "동기화 중",
  paused: "일시정지",
  recovery: "복구 점검 필요",
  disconnected: "연결 해제",
};
export const syncTime = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
    : "아직 없음";
const display = (value: unknown) =>
  typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? "없음");

export function ConnectionChecks({
  result,
}: {
  result: ConnectionCheck | null;
}) {
  if (!result) return null;
  return (
    <div className="settings-table-scroll">
      <table className="settings-table connection-checks-table">
        <caption>연결 검사 결과</caption>
        <thead>
          <tr>
            <th scope="col">대상</th>
            <th scope="col">결과</th>
            <th scope="col">내용</th>
          </tr>
        </thead>
        <tbody>
          {result.checks.map((check, index) => (
            <tr key={`${check.name}-${index}`}>
              <th scope="row">{check.name}</th>
              <td className={`connection-check-result is-${check.status}`}>
                {check.status === "ok"
                  ? "정상"
                  : check.status === "pending"
                    ? "대기"
                    : "오류"}
              </td>
              <td>{check.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TeamSyncSettings({
  team,
  user,
  onMessage,
}: {
  team: Team;
  user: User;
  onMessage: (message: string) => void;
}) {
  const admin = canManageTeam(user, team.id);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [profileId, setProfileId] = useState("");
  const [check, setCheck] = useState<ConnectionCheck | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [editing, setEditing] = useState<Conflict | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState("");
  const [switchJob, setSwitchJob] = useState<SwitchJob | null>(null);
  const switchStop = useRef(false);
  const live = useRef(true);
  const prefix = `/teams/${team.id}/sync`;
  async function load(signal?: AbortSignal, includeConnection = false) {
    const [nextStatus, nextConflicts, nextConnection] = await Promise.all([
      api<SyncStatus>(prefix, { signal }),
      api<{ conflicts: Conflict[] }>(`${prefix}/conflicts`, { signal }),
      admin && includeConnection
        ? api<Connection>(`/admin/teams/${team.id}/connection`, { signal })
        : Promise.resolve(null),
    ]);
    if (!live.current || signal?.aborted) return;
    setStatus(nextStatus);
    setConflicts(nextConflicts.conflicts);
    if (nextConnection) {
      setConnection(nextConnection);
      setProfileId(nextConnection.profileId || "");
      setSwitchJob(nextConnection.switchJob || null);
    }
  }
  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh(initial = false) {
      try {
        await load(controller.signal, initial);
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
      if (!controller.signal.aborted) timer = setTimeout(() => refresh(), 5000);
    }
    void refresh(true);
    return () => {
      live.current = false;
      switchStop.current = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [team.id, admin]);
  async function perform(action: string, message: string, body: unknown = {}) {
    if (busy) return;
    setBusy(true);
    setReconnecting(action === "reconnect");
    setError("");
    onMessage("");
    try {
      const result = await send<ConnectionCheck>(`${prefix}/${action}`, body);
      if (!live.current) return;
      if (action === "check") setCheck(result);
      await load(undefined, true);
      if (live.current) onMessage(message);
    } catch (e) {
      if (live.current) setError((e as Error).message);
      if (action === "reconnect") await load(undefined, true).catch(() => {});
    } finally {
      if (live.current) {
        setBusy(false);
        setReconnecting(false);
      }
    }
  }
  async function resolve(
    conflict: Conflict,
    choice: "current" | "submitted" | "edited",
  ) {
    let desired: unknown;
    if (choice === "edited") {
      try {
        desired =
          typeof conflict.desired === "string" ? draft : JSON.parse(draft);
      } catch {
        setError("적용할 내용의 형식을 확인하세요.");
        return;
      }
    }
    await perform(
      `conflicts/${encodeURIComponent(conflict.conflictId)}/resolve`,
      "충돌 해결 내용을 저장했습니다.",
      {
        choice,
        ...(choice === "edited" ? { desired } : {}),
        expectedHead: conflict.expectedHead,
        frontier: conflict.frontier || [conflict.opId],
      },
    );
    // Keep manually edited text on a rejected or interrupted resolution.
  }
  async function migrateConnection(resume = false) {
    if (busy || (!resume && !profileId) || (resume && !switchJob)) return;
    setBusy(true);
    setError("");
    onMessage("");
    switchStop.current = false;
    const path = `/admin/teams/${team.id}/connection/switch`;
    try {
      let job = await send<SwitchJob>(
        resume ? `${path}/${switchJob!.jobId}/resume` : path,
        resume ? {} : { profileId, expectedRevision: connection?.revision },
      );
      if (live.current) setSwitchJob(job);
      while (job.hasMore && !switchStop.current) {
        if (job.phase === "failed")
          throw new Error(
            job.error ||
              "자료 이관이 중단되었습니다. 연결을 확인한 뒤 이어서 진행하세요.",
          );
        job = await send<SwitchJob>(`${path}/${job.jobId}/resume`, {});
        if (live.current) setSwitchJob(job);
      }
      if (!live.current) return;
      await load(undefined, true);
      onMessage(
        job.hasMore
          ? "현재 묶음까지 이관하고 중단했습니다. 이어서 진행할 수 있습니다."
          : "자료를 검증하고 팀 연결을 변경했습니다.",
      );
    } catch (e) {
      if (live.current) {
        setError((e as Error).message);
        await load(undefined, true).catch(() => {});
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }
  const selectedProfile = connection?.profiles.find(
    (profile) => profile.profileId === profileId,
  );
  const linked = status && !["unlinked", "disconnected"].includes(status.mode);
  const initialized = !!status?.canonicalHead;
  const external = isExternalSite();
  const canReconnect =
    !external && status?.mode === "disconnected" && status.canReconnect;
  const needsRecovery =
    status?.mode === "disconnected" || status?.mode === "recovery";
  const replacing =
    external && !!connection?.profileId && profileId !== connection.profileId;
  return (
    <section
      className="settings-section team-sync-settings"
      aria-label={`${team.name} 동기화`}
    >
      <ErrorNote error={error} />
      {!status && !error && (
        <LoadingState label="동기화 상태를 확인하고 있습니다." />
      )}
      {status && (
        <>
          <div className="team-sync-overview">
            <div className="team-sync-heading">
              <h4>
                <RefreshCw size={16} aria-hidden="true" />
                동기화 상태
              </h4>
              <span
                className={`team-sync-mode ${needsRecovery || status.lastError ? "is-problem" : status.mode === "active" ? "is-active" : ""}`}
              >
                {modes[status.mode] || status.mode}
              </span>
            </div>
            <p className="team-sync-site">
              {status.siteName || "현재 서버"} ·{" "}
              {external ? "외부망" : "내부망"}
            </p>
            <dl
              className="team-sync-facts"
              aria-label="동기화 상태"
              aria-live="polite"
            >
              <div>
                <dt>{external ? "외부 클라우드 저장" : "내부 서버 저장"}</dt>
                <dd>{syncTime(status.lastLocalSavedAt)}</dd>
              </div>
              <div>
                <dt>Git 반영</dt>
                <dd>
                  {syncTime(status.lastPublishedAt)}
                  <span className="team-sync-secondary">
                    공유 대기 {status.pending}건
                  </span>
                </dd>
              </div>
              <div>
                <dt>마지막 수신</dt>
                <dd>{syncTime(status.lastReceivedAt)}</dd>
              </div>
              <div>
                <dt>{external ? "내부망 반영" : "외부망 반영"}</dt>
                <dd>
                  {status.remoteStatus?.verified &&
                  status.remoteStatus.mode === "active" &&
                  Date.now() - Date.parse(status.remoteStatus.observedAt) <
                    180000
                    ? `마지막 확인: ${syncTime(status.remoteStatus.observedAt)}`
                    : status.remoteStatus
                      ? `현재 확인 불가 · 마지막 상태: ${syncTime(status.remoteStatus.observedAt)}`
                      : "확인 대기"}
                </dd>
              </div>
              <div>
                <dt>충돌 보관</dt>
                <dd>{status.conflicts}건</dd>
              </div>
            </dl>
            <ErrorNote error={status.lastError || ""} />
          </div>
          {needsRecovery && (
            <div className="team-sync-recovery" role="note">
              {canReconnect ? (
                <>
                  <strong>동기화 연결이 해제되어 있습니다.</strong>
                  <p>
                    <b>다시 연결</b>을 누르면 해제 중 저장한 내용을 보존하고
                    기존 프로필로 연결합니다. 서버를 종료하거나 명령어를 실행할
                    필요가 없습니다.
                  </p>
                </>
              ) : (
                <>
                  <strong>다시 연결하려면 복구 점검이 필요합니다.</strong>
                  <p>
                    {status.mode === "disconnected"
                      ? "연결 해제 동안 저장한 변경을"
                      : "저장 자료와 Git 공유본을"}{" "}
                    대조해야 하므로 프로필 저장이나 연결 검사만으로는 재연결되지
                    않습니다. 서버 관리자가 쓰기를 중지하고 백업한 뒤{" "}
                    {external ? "외부 서버" : "내부 서버"} 복구 점검을 완료하면,
                    이 화면에서 <b>재개</b>할 수 있습니다.
                  </p>
                  <p>
                    잠시 동기화를 멈출 때는 <b>일시정지 → 재개</b>를 사용하세요.
                  </p>
                  {user.systemRole === "admin" && (
                    <a
                      href="/api/admin/service-connections/guide"
                      target="_blank"
                      rel="noreferrer"
                    >
                      설치 안내의 복구 절차 보기
                    </a>
                  )}
                </>
              )}
            </div>
          )}
          {admin && connection && (
            <form
              className="team-sync-connection"
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy || !profileId || needsRecovery) return;
                if (replacing) {
                  await migrateConnection();
                  return;
                }
                setBusy(true);
                setError("");
                onMessage("");
                try {
                  await send(
                    `/admin/teams/${team.id}/connection`,
                    { profileId, expectedRevision: connection.revision },
                    "PUT",
                  );
                  if (!live.current) return;
                  setCheck(null);
                  await load(undefined, true);
                  onMessage("팀 연결을 저장했습니다.");
                } catch (e) {
                  if (live.current) setError((e as Error).message);
                } finally {
                  if (live.current) setBusy(false);
                }
              }}
            >
              <h4 className="team-sync-section-title">
                <Plug size={16} aria-hidden="true" />
                연결 설정
              </h4>
              <div className="team-sync-profile-controls">
                <label>
                  연결 프로필
                  <Select
                    aria-label="연결 프로필"
                    value={profileId}
                    {...busyProps(busy, !!switchJob?.hasMore || needsRecovery)}
                    onChange={(event) => {
                      setProfileId(event.target.value);
                      setCheck(null);
                    }}
                  >
                    <option value="">설치된 프로필 선택</option>
                    {connection.profiles
                      .filter((profile) => profile.teamId === team.id)
                      .map((profile) => (
                        <option
                          key={profile.profileId}
                          value={profile.profileId}
                        >
                          {profile.name || profile.profileId}
                        </option>
                      ))}
                  </Select>
                </label>
                {!needsRecovery && (
                  <Button
                    type="submit"
                    className="primary"
                    {...busyProps(
                      busy,
                      !profileId ||
                        profileId === connection.profileId ||
                        !!switchJob?.hasMore ||
                        (replacing &&
                          selectedProfile?.replaces !== connection.profileId),
                    )}
                  >
                    {replacing ? "자료 이관 후 연결 변경" : "연결 저장"}
                  </Button>
                )}
              </div>
              {selectedProfile?.repository && (
                <p className="field-help">
                  저장소: {selectedProfile.repository}
                </p>
              )}
              {replacing && (
                <p className="field-help">
                  선택한 새 자원에 본문·이미지·미전송 변경을 옮기고 검증한 뒤
                  연결을 변경합니다. 이관 중에는 팀 편집이 잠시 대기하며 기존
                  자원은 보존됩니다.
                </p>
              )}
              {!connection.profiles.some(
                (profile) => profile.teamId === team.id,
              ) && (
                <p className="field-help">
                  이 팀의 설치된 연결 프로필이 없습니다. 시스템 → 서비스
                  연결에서 설치 안내를 확인하세요.
                </p>
              )}
            </form>
          )}
          {admin && switchJob?.hasMore && (
            <div role="status" className="field-help">
              <p>
                팀 연결 자료 이관이 진행 중입니다. 작업 ID: {switchJob.jobId}
              </p>
              {switchJob.error && <p>{switchJob.error}</p>}
              {busy ? (
                <Button
                  onClick={() => {
                    switchStop.current = true;
                  }}
                >
                  중단
                </Button>
              ) : (
                <Button onClick={() => void migrateConnection(true)}>
                  이어서 연결 이관
                </Button>
              )}
            </div>
          )}
          {!switchJob?.hasMore && (
            <div className="team-sync-actions-section">
              <h4>연결 검사 및 실행</h4>
              <div className="team-sync-actions">
                <Button
                  {...busyProps(busy, !status.profileId)}
                  onClick={() =>
                    void perform("check", "연결 검사를 마쳤습니다.")
                  }
                >
                  연결 검사
                </Button>
                {admin && canReconnect && (
                  <Button
                    className="primary"
                    {...busyProps(busy)}
                    onClick={() =>
                      void perform(
                        "reconnect",
                        initialized
                          ? "연결을 복원했습니다. 동기화가 자동으로 이어집니다."
                          : "연결을 복원했습니다. 연결 검사 후 초기 게시를 진행하세요.",
                      )
                    }
                  >
                    {reconnecting ? "다시 연결 중…" : "다시 연결"}
                  </Button>
                )}
                {admin &&
                  !external &&
                  !initialized &&
                  status.mode !== "disconnected" && (
                    <Button
                      className="primary"
                      {...busyProps(busy, !status.profileId || !check?.ready)}
                      onClick={() =>
                        void perform("enable", "초기 게시를 시작했습니다.")
                      }
                    >
                      초기 게시
                    </Button>
                  )}
                {linked && initialized && (
                  <Button
                    {...busyProps(
                      busy,
                      status.mode === "recovery" || status.mode === "importing",
                    )}
                    onClick={() =>
                      void perform("run", "동기화를 실행했습니다.")
                    }
                  >
                    지금 동기화
                  </Button>
                )}
                {status.mode === "active" && (
                  <Button
                    {...busyProps(busy)}
                    onClick={() =>
                      void perform("pause", "동기화를 일시정지했습니다.")
                    }
                  >
                    일시정지
                  </Button>
                )}
                {status.mode === "paused" && initialized && (
                  <Button
                    {...busyProps(busy)}
                    onClick={() =>
                      void perform("resume", "동기화를 재개했습니다.")
                    }
                  >
                    재개
                  </Button>
                )}
                {admin && linked && (
                  <Button
                    className="team-sync-disconnect"
                    {...busyProps(busy)}
                    onClick={() =>
                      void perform(
                        "disconnect",
                        "미전송 변경과 충돌을 보존하고 연결을 해제했습니다.",
                      )
                    }
                  >
                    연결 해제
                  </Button>
                )}
              </div>
              {admin && linked && (
                <p className="field-help">
                  잠시 멈출 때는 일시정지를 사용하세요.{" "}
                  {external
                    ? "연결 해제 후에는 서버 복구 점검이 필요합니다."
                    : "연결을 해제한 뒤에는 다시 연결 버튼으로 이어갈 수 있습니다."}
                </p>
              )}
            </div>
          )}
          {busy && (
            <p className="field-help" role="status">
              처리 중…
            </p>
          )}
          <ConnectionChecks result={check} />
          {!external && user.teamRoles[team.id] === "lead" && (
            <TeamSetupKey
              key={team.id}
              teamId={team.id}
              enabled={
                initialized && ["active", "paused"].includes(status.mode)
              }
              onMessage={onMessage}
            />
          )}
          {conflicts.filter((conflict) => !conflict.resolved).length > 0 && (
            <section aria-label="충돌 보관함">
              <h4>충돌 보관함</h4>
              {conflicts
                .filter((conflict) => !conflict.resolved)
                .map((conflict) => (
                  <details key={conflict.conflictId}>
                    <summary>
                      {conflict.target || "업무 변경"} ·{" "}
                      {syncTime(conflict.createdAt)}
                    </summary>
                    <dl>
                      <dt>기준 내용</dt>
                      <dd>
                        <pre
                          style={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {display(conflict.base)}
                        </pre>
                      </dd>
                      <dt>현재 공유 내용</dt>
                      <dd>
                        <pre
                          style={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {display(conflict.current)}
                        </pre>
                      </dd>
                      <dt>제출한 내용</dt>
                      <dd>
                        <pre
                          style={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {display(conflict.desired)}
                        </pre>
                      </dd>
                    </dl>
                    {editing?.conflictId === conflict.conflictId && (
                      <label>
                        적용할 내용
                        <textarea
                          aria-label="적용할 내용"
                          rows={8}
                          value={draft}
                          {...busyProps(busy)}
                          onChange={(event) => setDraft(event.target.value)}
                        />
                      </label>
                    )}
                    <div className="form-actions">
                      <Button
                        {...busyProps(busy)}
                        onClick={() => void resolve(conflict, "current")}
                      >
                        현재 공유 내용 유지
                      </Button>
                      <Button
                        {...busyProps(busy)}
                        onClick={() => void resolve(conflict, "submitted")}
                      >
                        제출한 내용 적용
                      </Button>
                      {editing?.conflictId === conflict.conflictId ? (
                        <Button
                          className="primary"
                          {...busyProps(busy)}
                          onClick={() => void resolve(conflict, "edited")}
                        >
                          편집 내용 적용
                        </Button>
                      ) : (
                        <Button
                          {...busyProps(busy)}
                          onClick={() => {
                            setEditing(conflict);
                            setDraft(display(conflict.desired));
                          }}
                        >
                          직접 편집
                        </Button>
                      )}
                    </div>
                  </details>
                ))}
            </section>
          )}
        </>
      )}
    </section>
  );
}
