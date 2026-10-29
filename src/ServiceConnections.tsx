import { useSite } from "./site-context";
import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Database,
  GitBranch,
  Image,
  Plug,
  Server,
  ShieldCheck,
} from "lucide-react";
import { api, send } from "./api";
import { Button, ErrorNote } from "./components";
import LoadingState from "./LoadingState";
import Toast, { useToast } from "./Toast";
import { busyProps } from "./busyProps";
import type { Team, User } from "./types";
import Select from "./Select";
import SyncSetupWizard from "./SyncSetupWizard";
import TeamSyncSettings from "./TeamSyncSettings";
import SyncConnectionDetails from "./SyncConnectionDetails";
import "./service-connections.css";
import {
  ConnectionChecks,
  type ConnectionCheck,
  type ResourceProfile,
} from "./TeamSyncSettings";

type Service = {
  site: "internal" | "external";
  siteName: string;
  appOrigin?: string;
  access?: { issuer?: string; audience?: string; configured: boolean };
  database: { provider: string; version: string | number; status: string };
  profiles: ResourceProfile[];
  checks?: ConnectionCheck["checks"];
  guideUrl?: string;
};
const resource = (value: ResourceProfile["database"]) =>
  typeof value === "string" ? value : value?.provider || "미설치";
export default function ServiceConnections({
  teams,
  onRefresh,
  user,
}: {
  teams: Team[];
  onRefresh: () => Promise<unknown>;
  user: User;
}) {
  const site = useSite();
  const [service, setService] = useState<Service | null>(null);
  const [check, setCheck] = useState<ConnectionCheck | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupTeamId, setSetupTeamId] = useState(teams[0]?.id || "");
  const [message, setMessage] = useToast();
  const live = useRef(true);
  async function load(signal?: AbortSignal) {
    const data = await api<Service>("/admin/service-connections", { signal });
    if (live.current && !signal?.aborted) setService(data);
  }
  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => {
      live.current = false;
      controller.abort();
    };
  }, []);
  async function action(
    path: string,
    body: unknown,
    done: string,
    importing = false,
  ) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await send<ConnectionCheck>(path, body);
      if (!live.current) return;
      if (!importing) setCheck(result);
      await load();
      if (importing) await onRefresh();
      if (live.current) setMessage(done);
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  const setupTeam = teams.find((team) => team.id === setupTeamId);
  if (setupOpen && setupTeam)
    return (
      <>
        <SyncSetupWizard
          key={setupTeam.id}
          team={setupTeam}
          systemAdmin={user.systemRole === "admin"}
          onRefresh={onRefresh}
          onMessage={setMessage}
          onClose={() => {
            setSetupOpen(false);
            void load().catch((e) => setError(e.message));
          }}
        >
          <TeamSyncSettings
            team={setupTeam}
            user={user}
            onSaved={async () => {
              await onRefresh();
            }}
            onMessage={setMessage}
            embedded
          />
        </SyncSetupWizard>
        <Toast message={message} />
      </>
    );
  return (
    <section
      className="settings-section service-connections"
      aria-label="외부 동기화"
    >
      <div className="settings-team-header service-connections-header">
        <div>
          <h3>외부 동기화</h3>
          <p>
            {site.accountLinking
              ? "이 팀의 서비스와 저장소를 확인합니다."
              : "공통 서비스와 설치된 팀 자원을 확인합니다."}
          </p>
        </div>
        {service && (
          <div className="service-connections-actions">
            <Button
              {...busyProps(busy)}
              onClick={() =>
                void action(
                  "/admin/service-connections/check",
                  {},
                  "서비스 연결 검사를 마쳤습니다.",
                )
              }
            >
              <Plug size={15} aria-hidden="true" />
              공통 연결 검사
            </Button>
            <a
              href={service.guideUrl || "/api/admin/service-connections/guide"}
              target="_blank"
              rel="noreferrer"
            >
              <BookOpen size={15} aria-hidden="true" />
              설치 안내
            </a>
          </div>
        )}
      </div>
      <ErrorNote error={error} />
      <Toast message={message} />
      {!service && !error && (
        <LoadingState label="서비스 연결을 확인하고 있습니다." />
      )}
      {service && (
        <>
          <div className="sync-setup-launch service-connections-setup">
            <label htmlFor="sync-setup-team">설정할 팀</label>
            <Select
              id="sync-setup-team"
              value={setupTeamId}
              onChange={(event) => setSetupTeamId(event.target.value)}
            >
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
            <Button
              className="primary"
              disabled={!setupTeam}
              onClick={() => setSetupOpen(true)}
            >
              외부 동기화 설정
            </Button>
          </div>
          <div className="service-connections-overview">
            <div className="service-connections-heading">
              <h4>
                <Server size={16} aria-hidden="true" />
                현재 서버
              </h4>
              <span className="settings-role-badge">
                {!site.external ? "내부망" : "외부망"}
              </span>
            </div>
            <dl className="service-connections-facts">
              <div>
                <dt>서버 이름</dt>
                <dd>{service.siteName}</dd>
              </div>
              <div>
                <dt>서비스 주소</dt>
                <dd>{service.appOrigin || "미설정"}</dd>
              </div>
              <div>
                <dt>
                  {site.accountLinking
                    ? "팀 데이터베이스"
                    : "관리 데이터베이스"}
                </dt>
                <dd>
                  <span>{service.database.provider}</span>
                  <span className="service-connections-secondary">
                    v{service.database.version}
                  </span>
                  <span
                    className={`service-connections-state ${service.database.status === "ok" ? "is-ready" : ""}`}
                  >
                    {service.database.status === "ok"
                      ? "정상"
                      : service.database.status}
                  </span>
                </dd>
              </div>
              {site.external && (
                <div>
                  <dt>Google 로그인</dt>
                  <dd>{service.access?.configured ? "설정됨" : "미설정"}</dd>
                </div>
              )}
            </dl>
            {site.external && (
              <details className="service-connections-details">
                <summary>
                  <ShieldCheck size={14} aria-hidden="true" />
                  로그인 연결 정보
                </summary>
                <dl className="service-connections-facts">
                  <div>
                    <dt>발급자</dt>
                    <dd>{service.access?.issuer || "미설정"}</dd>
                  </div>
                  <div>
                    <dt>앱 Audience</dt>
                    <dd>{service.access?.audience || "미설정"}</dd>
                  </div>
                </dl>
              </details>
            )}
          </div>
          {busy && (
            <p className="field-help" role="status">
              처리 중…
            </p>
          )}
          {check && (
            <div className="service-connections-checks">
              <ConnectionChecks result={check} />
            </div>
          )}
          <div className="service-connections-profiles">
            <div className="service-connections-heading">
              <h4>
                <GitBranch size={16} aria-hidden="true" />
                설치된 팀 연결 프로필
              </h4>
              <span className="list-count">{service.profiles.length}</span>
            </div>
            {service.profiles.map((profile) => {
              const profileTeam = teams.find(
                (team) => team.id === profile.teamId,
              );
              const profileName =
                profile.name && profile.name !== profile.profileId
                  ? profile.name
                  : `${profileTeam?.name || "팀"} 연결 프로필`;
              return (
                <article
                  className="service-connection-profile"
                  key={profile.profileId}
                  aria-label={profileName}
                >
                  <div className="service-connection-profile-header">
                    <div>
                      <h5>{profileName}</h5>
                      {teams.find((team) => team.id === profile.teamId)
                        ?.name && (
                        <p>
                          {
                            teams.find((team) => team.id === profile.teamId)!
                              .name
                          }
                        </p>
                      )}
                    </div>
                    {site.external && (
                      <Button
                        {...busyProps(busy, profile.ready === false)}
                        onClick={() =>
                          void action(
                            "/admin/sync/import",
                            {
                              profileId: profile.profileId,
                              teamId: profile.teamId,
                            },
                            "팀 가져오기를 실행했습니다.",
                            true,
                          )
                        }
                      >
                        팀 가져오기
                      </Button>
                    )}
                  </div>
                  <dl className="service-connections-facts">
                    <div>
                      <dt>Git 저장소</dt>
                      <dd>{profile.repository || "미설정"}</dd>
                    </div>
                  </dl>
                  <dl className="service-connection-resources">
                    <div>
                      <dt>
                        <Database size={14} aria-hidden="true" />
                        업무 데이터베이스
                      </dt>
                      <dd>{resource(profile.database)}</dd>
                    </div>
                    <div>
                      <dt>
                        <Image size={14} aria-hidden="true" />
                        이미지 저장소
                      </dt>
                      <dd>{resource(profile.images)}</dd>
                    </div>
                  </dl>
                  <SyncConnectionDetails
                    teamId={profile.teamId}
                    profileId={profile.profileId}
                    systemAdmin={user.systemRole === "admin"}
                  />
                </article>
              );
            })}
            {!service.profiles.length && (
              <p className="service-connections-empty">
                설치된 팀 연결 프로필이 없습니다.
              </p>
            )}
          </div>
          <details className="service-connections-details service-connections-help">
            <summary>공통 설정과 팀 설정</summary>
            <p className="field-help">
              외부 서비스 주소와 Google 로그인은 한 번 설정합니다. 각 팀에는
              업무 데이터베이스, 비공개 이미지 저장소, 비공개 Git 저장소를
              연결합니다. 설치를 마친 프로필은 해당 팀의 외부 동기화 탭에서
              확인하고 연결합니다.
            </p>
            <p className="field-help">
              Access의 허용 정책과 그래보드 사용자·팀 권한은 각각 관리합니다.
              다른 서비스에 로그인할 수 있는 사용자도 그래보드에 등록되어 있어야
              합니다.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
