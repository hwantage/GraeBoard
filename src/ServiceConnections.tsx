import { useEffect, useRef, useState } from "react";
import { api, send, isTeamSite } from "./api";
import { Button, ErrorNote } from "./components";
import LoadingState from "./LoadingState";
import Toast, { useToast } from "./Toast";
import { busyProps } from "./busyProps";
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
  onRefresh,
}: {
  onRefresh: () => Promise<unknown>;
}) {
  const [service, setService] = useState<Service | null>(null);
  const [check, setCheck] = useState<ConnectionCheck | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
  return (
    <section className="settings-section" aria-label="서비스 연결">
      <div className="settings-team-header">
        <div>
          <h3>서비스 연결</h3>
          <p>
            {isTeamSite()
              ? "이 팀의 서비스와 저장소를 확인합니다."
              : "공통 서비스와 설치된 팀 자원을 확인합니다."}
          </p>
        </div>
      </div>
      <ErrorNote error={error} />
      <Toast message={message} />
      {!service && !error && (
        <LoadingState label="서비스 연결을 확인하고 있습니다." />
      )}
      {service && (
        <>
          <dl className="role-legend">
            <div>
              <dt>현재 서버</dt>
              <dd>
                {service.siteName} ·{" "}
                {service.site === "internal" ? "내부" : "외부"}
              </dd>
            </div>
            <div>
              <dt>서비스 주소</dt>
              <dd>{service.appOrigin || "미설정"}</dd>
            </div>
            <div>
              <dt>{isTeamSite() ? "팀 데이터베이스" : "관리 데이터베이스"}</dt>
              <dd>
                {service.database.provider} · v{service.database.version} ·{" "}
                {service.database.status}
              </dd>
            </div>
            {service.site === "external" && (
              <>
                <div>
                  <dt>Google Access</dt>
                  <dd>{service.access?.configured ? "설정됨" : "미설정"}</dd>
                </div>
                <div>
                  <dt>발급자</dt>
                  <dd>{service.access?.issuer || "미설정"}</dd>
                </div>
                <div>
                  <dt>앱 Audience</dt>
                  <dd>{service.access?.audience || "미설정"}</dd>
                </div>
              </>
            )}
          </dl>
          <div className="form-actions">
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
              공통 연결 검사
            </Button>
            <a
              href={service.guideUrl || "/api/admin/service-connections/guide"}
              target="_blank"
              rel="noreferrer"
            >
              설치 안내
            </a>
          </div>
          {busy && (
            <p className="field-help" role="status">
              처리 중…
            </p>
          )}
          <ConnectionChecks result={check} />
          <h4>설치된 팀 연결 프로필</h4>
          <div className="settings-table-scroll">
            <table className="settings-table">
              <thead>
                <tr>
                  <th scope="col">프로필</th>
                  <th scope="col">팀</th>
                  <th scope="col">저장소</th>
                  <th scope="col">자원</th>
                  {service.site === "external" && (
                    <th scope="col">최초 연결</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {service.profiles.map((profile) => (
                  <tr key={profile.profileId}>
                    <th scope="row">{profile.name || profile.profileId}</th>
                    <td>{profile.teamId}</td>
                    <td>{profile.repository || "미설정"}</td>
                    <td>
                      {resource(profile.database)} · {resource(profile.images)}
                    </td>
                    {service.site === "external" && (
                      <td>
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
                      </td>
                    )}
                  </tr>
                ))}
                {!service.profiles.length && (
                  <tr>
                    <td
                      colSpan={service.site === "external" ? 5 : 4}
                      className="table-empty"
                    >
                      설치된 팀 연결 프로필이 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <details>
            <summary>공통 설정과 팀 설정</summary>
            <p className="field-help">
              외부 서비스 주소와 Google 로그인은 한 번 설정합니다. 각 팀에는
              업무 데이터베이스, 비공개 이미지 저장소, 비공개 Git 저장소를
              연결합니다. 설치를 마친 프로필은 해당 팀의 동기화 탭에서
              선택합니다.
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
