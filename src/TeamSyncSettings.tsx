import { useSite } from "./site-context";
import TeamSetupKey from "./TeamSetupKey";
import SyncSetupWizard from "./SyncSetupWizard";
import SyncConnectionDetails from "./SyncConnectionDetails";
import { syncTime, type SyncStatus } from "./sync-types";
import { useEffect, useRef, useState } from "react";
import { Plug, RefreshCw } from "lucide-react";
import { api, send } from "./api";
import { Button, ErrorNote } from "./components";
import LoadingState from "./LoadingState";
import Select from "./Select";
import { busyProps } from "./busyProps";
import type { Team, User } from "./types";
import { canManageTeam } from "../shared/domain.js";
import { syncErrorMessage } from "../shared/sync-error-message.js";
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

const display = (value: unknown) =>
  typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? "없음");

type ErrorTarget = "connection" | "actions" | `conflict:${string}`;
const actionNames: Record<string, string> = {
  check: "연결 검사",
  enable: "초기 게시",
  run: "동기화 실행",
  reconnect: "다시 연결",
  disconnect: "연결 해제",
  pause: "일시정지",
  resume: "동기화 재개",
};
function SyncErrorNote({
  error,
  reveal = false,
}: {
  error: string;
  reveal?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error && reveal) ref.current?.scrollIntoView({ block: "nearest" });
  }, [error, reveal]);
  return error ? (
    <div ref={ref}>
      <ErrorNote error={error} />
    </div>
  ) : null;
}

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
  onSaved,
  onMessage,
  embedded = false,
}: {
  team: Team;
  user: User;
  onSaved: () => Promise<void>;
  onMessage: (message: string) => void;
  embedded?: boolean;
}) {
  const site = useSite();
  const admin = canManageTeam(user, team.id);
  const configured = team.sync?.configured === true;
  const [setupOpen, setSetupOpen] = useState(false);
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
  const [errorTarget, setErrorTarget] = useState<ErrorTarget>("actions");
  const [loadError, setLoadError] = useState("");
  const [switchJob, setSwitchJob] = useState<SwitchJob | null>(null);
  const switchStop = useRef(false);
  const live = useRef(true);
  const prefix = `/teams/${team.id}/sync`;
  function showError(target: ErrorTarget, cause: unknown, action: string) {
    setErrorTarget(target);
    setError(
      `${action} 실패: ${syncErrorMessage(cause) || (cause as Error).message}`,
    );
  }
  async function load(
    signal?: AbortSignal,
    includeConnection = false,
    readStatus = configured,
  ) {
    const [nextStatus, nextConflicts, nextConnection] = await Promise.all([
      readStatus ? api<SyncStatus>(prefix, { signal }) : Promise.resolve(null),
      readStatus
        ? api<{ conflicts: Conflict[] }>(`${prefix}/conflicts`, { signal })
        : Promise.resolve({ conflicts: [] }),
      admin && includeConnection
        ? api<Connection>(`/admin/teams/${team.id}/connection`, { signal })
        : Promise.resolve(null),
    ]);
    if (!live.current || signal?.aborted) return;
    setLoadError("");
    setStatus(nextStatus);
    setConflicts(nextConflicts.conflicts);
    if (nextConnection) {
      setConnection(nextConnection);
      const original = nextConnection.profiles.filter(
        (profile) => profile.teamId === team.id && !profile.replaces,
      );
      setProfileId(
        nextConnection.profileId ||
          (original.length === 1 ? original[0].profileId : ""),
      );
      setSwitchJob(nextConnection.switchJob || null);
    }
  }
  useEffect(() => {
    // The wizard embeds its own copy of this screen; polling here as well would
    // double every status read while it is open.
    if (setupOpen) return;
    live.current = true;
    if (!configured) {
      setStatus(null);
      setConflicts([]);
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh(initial = false) {
      try {
        await load(controller.signal, initial);
      } catch (e) {
        if (!controller.signal.aborted) setLoadError((e as Error).message);
      }
      if (!controller.signal.aborted && configured)
        timer = setTimeout(() => refresh(), 5000);
    }
    void refresh(true);
    return () => {
      live.current = false;
      switchStop.current = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [team.id, admin, configured, setupOpen]);
  async function perform(
    action: string,
    message: string,
    body: unknown = {},
    target: ErrorTarget = "actions",
  ) {
    if (busy) return;
    setBusy(true);
    setReconnecting(action === "reconnect");
    setError("");
    if (action === "check") setCheck(null);
    onMessage("");
    const actionName = actionNames[action] || "충돌 해결";
    let refreshing = false;
    try {
      const result = await send<ConnectionCheck>(`${prefix}/${action}`, body);
      if (!live.current) return;
      if (action === "check") {
        setCheck(result);
        if (!result.ready) {
          showError(
            target,
            new Error(
              "아래 검사 결과에서 오류가 발생한 연결을 확인한 뒤 다시 검사하세요.",
            ),
            "연결 검사",
          );
          return;
        }
      }
      refreshing = true;
      if (
        ["enable", "reconnect", "disconnect", "pause", "resume"].includes(
          action,
        )
      )
        await onSaved();
      if (!live.current) return;
      await load(undefined, true, true);
      if (live.current) onMessage(message);
    } catch (e) {
      if (live.current) {
        showError(
          target,
          e,
          refreshing ? `${actionName} 후 상태 조회` : actionName,
        );
        // Refresh failed initialization/status immediately; a polling failure
        // must not replace the action's more specific diagnostic.
        await load(undefined, true, true).catch(() => {});
      }
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
        showError(
          `conflict:${conflict.conflictId}`,
          new Error("적용할 내용의 형식을 확인하세요."),
          "충돌 해결",
        );
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
      `conflict:${conflict.conflictId}`,
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
    let refreshing = false;
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
      refreshing = true;
      await onSaved();
      if (!live.current) return;
      await load(undefined, true, true);
      onMessage(
        job.hasMore
          ? "현재 묶음까지 이관하고 중단했습니다. 이어서 진행할 수 있습니다."
          : "자료를 검증하고 팀 연결을 변경했습니다.",
      );
    } catch (e) {
      if (live.current) {
        showError(
          "connection",
          e,
          refreshing ? "연결 이관 상태 조회" : "연결 이관",
        );
        await load(undefined, true).catch(() => {});
        await onSaved().catch(() => {});
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }
  const selectedProfile = connection?.profiles.find(
    (profile) => profile.profileId === profileId,
  );
  const currentProfile = connection?.profiles.find(
    (profile) =>
      profile.teamId === team.id &&
      profile.profileId === (connection.profileId || profileId),
  );
  const replacementProfiles = connection?.profileId
    ? connection.profiles.filter(
        (profile) =>
          profile.teamId === team.id &&
          profile.replaces === connection.profileId,
      )
    : [];
  const changingProfile =
    !!connection?.profileId && profileId !== connection.profileId;
  const linked = status && !["unlinked", "disconnected"].includes(status.mode);
  const initialized = !!status?.canonicalHead;
  const external = site.external;
  const canReconnect =
    !external && status?.mode === "disconnected" && status.canReconnect;
  const needsRecovery =
    status?.mode === "disconnected" || status?.mode === "recovery";
  const replacing =
    external && !!connection?.profileId && profileId !== connection.profileId;
  if (setupOpen)
    return (
      <SyncSetupWizard
        key={team.id}
        team={team}
        systemAdmin={user.systemRole === "admin"}
        onClose={() => setSetupOpen(false)}
        onRefresh={onSaved}
        onMessage={onMessage}
      >
        <TeamSyncSettings
          team={team}
          user={user}
          onSaved={onSaved}
          onMessage={onMessage}
          embedded
        />
      </SyncSetupWizard>
    );
  return (
    <section
      className="settings-section team-sync-settings"
      aria-label={`${team.name} 외부 동기화`}
    >
      {admin && !embedded && (!external || user.systemRole === "admin") && (
        <div className="sync-setup-launch">
          <p className="field-help">
            GitHub 연동을 통해 외부에서 동기화 운영이 가능합니다.
          </p>
          <Button
            className={configured ? "" : "primary"}
            onClick={() => setSetupOpen(true)}
          >
            외부 동기화 설정
          </Button>
        </div>
      )}
      <ErrorNote error={loadError} />
      {!status && !connection && !loadError && (
        <LoadingState label="동기화 상태를 확인하고 있습니다." />
      )}
      {(status || connection) && (
        <>
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
                    {!busy && status.lastError && status.mode === "initializing"
                      ? "초기 게시 실패"
                      : modes[status.mode] || status.mode}
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
                    <dt>
                      {external ? "외부 클라우드 저장" : "내부 서버 저장"}
                    </dt>
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
                {status.receiptCapacity?.warning && (
                  <ErrorNote
                    error={
                      status.receiptCapacity.blocked
                        ? "동기화 확인 이력의 저장 한도에 도달했습니다. 기존 자료는 조회·백업할 수 있으며, 새 저장 전에 관리자 점검이 필요합니다."
                        : "동기화 확인 이력이 저장 한도에 가까워지고 있습니다. 관리자 점검이 필요합니다."
                    }
                  />
                )}
              </div>
              {needsRecovery && (
                <div className="team-sync-recovery" role="note">
                  {canReconnect ? (
                    <>
                      <strong>동기화 연결이 해제되어 있습니다.</strong>
                      <p>
                        <b>다시 연결</b>을 누르면 해제 중 저장한 내용을 보존하고
                        기존 프로필로 연결합니다. 서버를 종료하거나 명령어를
                        실행할 필요가 없습니다.
                      </p>
                    </>
                  ) : (
                    <>
                      <strong>다시 연결하려면 복구 점검이 필요합니다.</strong>
                      <p>
                        {status.mode === "disconnected"
                          ? "연결 해제 동안 저장한 변경을"
                          : "저장 자료와 Git 공유본을"}{" "}
                        대조해야 하므로 프로필 저장이나 연결 검사만으로는
                        재연결되지 않습니다. 서버 관리자가 쓰기를 중지하고
                        백업한 뒤 {external ? "외부 서버" : "내부 서버"} 복구
                        점검을 완료하면, 이 화면에서 <b>재개</b>할 수 있습니다.
                      </p>
                      <p>
                        잠시 동기화를 멈출 때는 <b>일시정지 → 재개</b>를
                        사용하세요.
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
            </>
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
                let refreshing = false;
                try {
                  await send(
                    `/admin/teams/${team.id}/connection`,
                    { profileId, expectedRevision: connection.revision },
                    "PUT",
                  );
                  if (!live.current) return;
                  setCheck(null);
                  refreshing = true;
                  await onSaved();
                  if (!live.current) return;
                  // This submit handler still holds the pre-save configured
                  // value even after the parent bootstrap has refreshed.
                  await load(undefined, true, true);
                  onMessage("팀 연결을 저장했습니다.");
                } catch (e) {
                  if (live.current)
                    showError(
                      "connection",
                      e,
                      refreshing ? "팀 연결 후 상태 조회" : "팀 연결",
                    );
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
                <dl className="team-sync-profile" aria-label="연결 프로필">
                  <dt>연결 프로필</dt>
                  <dd>
                    {currentProfile?.name &&
                    currentProfile.name !== currentProfile.profileId
                      ? currentProfile.name
                      : currentProfile || connection.profileId
                        ? `${team.name} 연결 프로필`
                        : "설치된 프로필 없음"}
                  </dd>
                </dl>
                {!needsRecovery && !connection.profileId && currentProfile && (
                  <Button
                    type="submit"
                    className="primary"
                    {...busyProps(busy, !profileId || !!switchJob?.hasMore)}
                  >
                    이 팀에 연결
                  </Button>
                )}
              </div>
              {currentProfile?.repository && (
                <p className="field-help">
                  저장소: {currentProfile.repository}
                </p>
              )}
              {replacementProfiles.length > 0 && (
                <details className="team-sync-replacement">
                  <summary>연결 이전·복구</summary>
                  <div className="team-sync-profile-controls">
                    <label>
                      교체용 프로필
                      <Select
                        aria-label="교체용 프로필"
                        value={changingProfile ? profileId : ""}
                        {...busyProps(
                          busy,
                          !!switchJob?.hasMore || needsRecovery,
                        )}
                        onChange={(event) => {
                          setProfileId(
                            event.target.value || connection.profileId,
                          );
                          setCheck(null);
                        }}
                      >
                        <option value="">현재 연결 유지</option>
                        {replacementProfiles.map((profile) => (
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
                          !changingProfile ||
                            !!switchJob?.hasMore ||
                            selectedProfile?.replaces !== connection.profileId,
                        )}
                      >
                        {external
                          ? "자료 이관 후 연결 변경"
                          : "검증 후 연결 변경"}
                      </Button>
                    )}
                  </div>
                  {changingProfile && selectedProfile?.repository && (
                    <p className="field-help">
                      교체 저장소: {selectedProfile.repository}
                    </p>
                  )}
                  <p className="field-help">
                    {external
                      ? "선택한 새 자원에 본문·이미지·미전송 변경을 옮기고 검증한 뒤 연결을 변경합니다. 이관 중에는 팀 편집이 잠시 대기하며 기존 자원은 보존됩니다."
                      : "기존 연결을 일시정지한 뒤 같은 팀의 검증된 저장소 복사본으로 교체합니다. 연결 변경 후 서버 관리자의 복구 점검을 거쳐 재개하세요."}
                  </p>
                </details>
              )}
              {!switchJob?.hasMore && (
                <SyncErrorNote
                  error={errorTarget === "connection" ? error : ""}
                  reveal
                />
              )}
              {!connection.profiles.some(
                (profile) => profile.teamId === team.id,
              ) && (
                <p className="field-help">
                  이 팀의 설치된 연결 프로필이 없습니다. 외부 동기화 설정에서
                  준비하거나 시스템 관리자에게 내부 프로필 등록을 요청하세요.
                </p>
              )}
              {!embedded && (
                <SyncConnectionDetails
                  key={team.id}
                  teamId={team.id}
                  profileId={connection.profileId || profileId || undefined}
                  systemAdmin={user.systemRole === "admin"}
                />
              )}
            </form>
          )}
          {admin && switchJob?.hasMore && (
            <div role="status" className="field-help">
              <p>
                팀 연결 자료 이관이 진행 중입니다. 작업 ID: {switchJob.jobId}
              </p>
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
              <SyncErrorNote
                error={
                  errorTarget === "connection" && error
                    ? error
                    : syncErrorMessage(switchJob.error) || switchJob.error || ""
                }
                reveal={errorTarget === "connection" && !!error}
              />
            </div>
          )}
          {status && !switchJob?.hasMore && (
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
              <SyncErrorNote
                error={
                  errorTarget === "actions" && error
                    ? error
                    : !busy && status.lastError
                      ? `동기화 오류: ${syncErrorMessage(status.lastError) || status.lastError}`
                      : ""
                }
                reveal={errorTarget === "actions" && !!error}
              />
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
          {status && !external && user.teamRoles[team.id] === "lead" && (
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
                    <SyncErrorNote
                      error={
                        errorTarget === `conflict:${conflict.conflictId}`
                          ? error
                          : ""
                      }
                      reveal
                    />
                  </details>
                ))}
            </section>
          )}
        </>
      )}
    </section>
  );
}
