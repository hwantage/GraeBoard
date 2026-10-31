import { useEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { api, send } from "./api";
import { Button, ErrorNote } from "./components";
import LoadingState from "./LoadingState";
import { useSite } from "./site-context";
import TeamSetupKey from "./TeamSetupKey";
import {
  ConnectionChecks,
  type ConnectionCheck,
  type ResourceProfile,
} from "./TeamSyncSettings";
import { syncTime, type SyncStatus } from "./sync-types";
import type { Team } from "./types";
import {
  appSourceRepository,
  setupSteps,
  setupStep,
  externalSetupSteps,
  setupExamples,
  validateSetupStep,
  syncVerification,
} from "../shared/sync-setup.js";
import "./sync-setup.css";

type Setup = {
  revision: string;
  installationId: string;
  profile: {
    profileId: string;
    repository: string;
    peerInstallationId: string;
  } | null;
  installed: boolean;
  restartRequired: boolean;
  credentialReady: boolean;
  credentialStored: boolean;
  tokenEnvironment: boolean;
  tokenPreview: string;
};
const docs = {
  github:
    "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
  token: "https://github.com/settings/personal-access-tokens/new",
  access:
    "https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/",
  pages:
    "https://developers.cloudflare.com/pages/functions/bindings/#service-bindings",
  r2: "https://developers.cloudflare.com/r2/buckets/create-buckets/",
  database: "https://supabase.com/docs/guides/database/connecting-to-postgres",
  secrets: "https://supabase.com/docs/guides/functions/secrets",
  deploy: "https://supabase.com/docs/guides/functions/deploy",
};
// Team leads without system administration cannot read installation IDs, so
// the operator steps that produce deployment values are left to the operator.
const operatorSteps = [
  setupStep.repository,
  setupStep.cloudflare,
  setupStep.supabase,
  setupStep.deploy,
];
const repositoryUrl = (value: string) =>
  (value.startsWith("https://")
    ? value
    : `https://github.com/${value}`
  ).replace(/\.git$/, "");
function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}
function CopyValue({
  label,
  value,
  onMessage,
}: {
  label: string;
  value: string;
  onMessage: (message: string) => void;
}) {
  const [error, setError] = useState("");
  return (
    <div className="sync-setup-copy">
      <div>
        <strong>{label}</strong>
        <Button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setError("");
              onMessage(`${label}을 복사했습니다.`);
            } catch {
              setError("아래 값을 선택해 직접 복사하세요.");
            }
          }}
        >
          {label} 복사
        </Button>
      </div>
      <textarea
        aria-label={label}
        value={value}
        readOnly
        rows={Math.min(9, value.split("\n").length + 1)}
        onFocus={(event) => event.currentTarget.select()}
      />
      <ErrorNote error={error} />
    </div>
  );
}

export default function SyncSetupWizard({
  team,
  systemAdmin,
  lead,
  onClose,
  onRefresh,
  onMessage,
  children,
}: {
  team: Team;
  systemAdmin: boolean;
  lead: boolean;
  onClose: () => void;
  onRefresh: () => Promise<unknown>;
  onMessage: (message: string) => void;
  children: ReactNode;
}) {
  const { external } = useSite();
  const [step, setStep] = useState(
    external
      ? 0
      : team.sync?.configured || !systemAdmin
        ? setupStep.publish
        : setupStep.repository,
  );
  const [furthest, setFurthest] = useState(step);
  const [published, setPublished] = useState(false);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [profiles, setProfiles] = useState<ResourceProfile[]>([]);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [check, setCheck] = useState<ConnectionCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [token, setToken] = useState("");
  const [importing, setImporting] = useState("");
  const [credentialVersion, setCredentialVersion] = useState(0);
  const [confirmed, setConfirmed] = useState<Record<number, boolean>>({});
  const [manual, setManual] = useState({ internal: false, external: false });
  const [draft, setDraft] = useState({
    repository: "",
    appOrigin: "",
    issuer: "",
    audience: "",
    bucket: `graeboard-${team.id.slice(0, 8)}`,
    gateway: `graeboard-${team.id.slice(0, 8)}`,
    projectRef: "",
    resourceOrigin: "",
  });
  const live = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const section = useRef<HTMLElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const prefix = `/teams/${team.id}/sync`;
  const setupPath = `/admin/teams/${team.id}/sync-setup`;
  const steps = external ? externalSetupSteps : setupSteps;
  const available = steps
    .map((_, index) => index)
    .filter(
      (index) => external || systemAdmin || !operatorSteps.includes(index),
    );
  const previousStep = available.filter((index) => index < step).at(-1);
  const nextStep = available.find((index) => index > step);
  const servicesStep = available.find((index) => index >= setupStep.cloudflare);
  const inServices = !external && step >= setupStep.cloudflare;
  const phaseSteps = external
    ? available
    : available.filter((index) => index >= setupStep.cloudflare === inServices);
  // An already published team may revisit any external service step without
  // re-entering the values that only fill the copyable examples.
  const reachable = (index: number) =>
    index <= furthest || (published && index >= setupStep.cloudflare);
  const final = step === steps.length - 1;
  // The repository stays editable until the team has connection history; the
  // server enforces the same boundary.
  const editable = systemAdmin && !team.sync?.configured;
  const examples = setupExamples(team, setup, draft);
  const verified = syncVerification(status);
  const readsStatus =
    final || (!external && step === setupStep.account && lead);
  const goToStep = (index: number) => {
    setStep(index);
    setError("");
    setToken("");
  };
  // Internally the embedded connection settings read the sync status
  // themselves, so the wizard only reads it where a step depends on it.
  async function load(signal?: AbortSignal) {
    if (external) {
      const nextStatus = await api<SyncStatus>(prefix, { signal });
      if (!live.current || signal?.aborted) return null;
      setStatus(nextStatus);
    }
    let next: Setup | null = null;
    if (!external && systemAdmin) {
      next = await api<Setup>(setupPath, { signal });
      if (!live.current || signal?.aborted) return null;
      setSetup(next);
      if (next.profile)
        setDraft((value) => ({
          ...value,
          repository: repositoryUrl(next!.profile!.repository),
        }));
    } else {
      const connection = await api<{ profiles: ResourceProfile[] }>(
        `/admin/teams/${team.id}/connection`,
        { signal },
      );
      if (!live.current || signal?.aborted) return null;
      setProfiles(
        connection.profiles.filter((profile) => profile.teamId === team.id),
      );
    }
    setLoaded(true);
    return next;
  }
  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    if (!external && team.sync?.configured)
      // Only unlocks direct navigation; the embedded settings report status
      // errors themselves.
      void api<SyncStatus>(prefix, { signal: controller.signal })
        .then((current) => {
          if (!controller.signal.aborted) setPublished(!!current.canonicalHead);
        })
        .catch(() => {});
    void load(controller.signal)
      .then((loadedSetup) => {
        if (
          loadedSetup &&
          !(
            loadedSetup.profile &&
            loadedSetup.installed &&
            (loadedSetup.credentialStored || loadedSetup.tokenEnvironment)
          )
        ) {
          setStep(setupStep.repository);
          setFurthest(setupStep.repository);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => {
      live.current = false;
      controller.abort();
    };
  }, [team.id]);
  useEffect(() => {
    section.current?.scrollIntoView({ block: "start" });
    heading.current?.focus({ preventScroll: true });
  }, [step]);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  useEffect(() => {
    if (!readsStatus) return;
    const controller = new AbortController();
    void api<SyncStatus>(prefix, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setStatus(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [readsStatus, prefix]);
  async function action(work: () => Promise<unknown>, message = "") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      if (!live.current) return;
      if (message) onMessage(message);
    } catch (cause) {
      if (live.current) setError((cause as Error).message);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  const update = (key: keyof typeof draft, value: string) => {
    setDraft((previous) => ({ ...previous, [key]: value.trim() }));
    setConfirmed({});
    setFurthest(step);
    setCheck(null);
    setError("");
  };
  const input = (label: string, key: keyof typeof draft, placeholder = "") => (
    <label>
      {label}
      <input
        value={draft[key]}
        placeholder={placeholder}
        onChange={(event) => update(key, event.target.value)}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
      />
    </label>
  );
  const copy = (label: string, value: string) => (
    <CopyValue label={label} value={value} onMessage={onMessage} />
  );
  const acknowledge = (label: string) => (
    <label className="sync-setup-ack">
      <input
        type="checkbox"
        checked={!!confirmed[step]}
        onChange={(event) =>
          setConfirmed({ ...confirmed, [step]: event.target.checked })
        }
      />
      {label}
    </label>
  );
  async function next() {
    await action(async () => {
      if (external) {
        if (step === 0 && !check?.ready)
          throw new Error(
            "공통 연결 검사를 실행하고 오류 항목을 해결한 뒤 다시 검사하세요.",
          );
        if (step === 1) {
          const current = await api<SyncStatus>(prefix);
          if (!live.current) return;
          setStatus(current);
          if (!current.canonicalHead || current.mode === "importing")
            throw new Error("팀 가져오기를 완료한 뒤 다음으로 진행하세요.");
        }
      } else if (step === setupStep.repository) {
        const invalid = validateSetupStep(step, draft);
        if (invalid) throw new Error(invalid);
        if (!setup?.profile)
          throw new Error(
            "내부 프로필 생성 버튼으로 프로필을 먼저 생성하세요. 생성은 시스템 관리자가 진행합니다.",
          );
        if (
          draft.repository.replace(/\.git$/, "") !==
          repositoryUrl(setup.profile.repository)
        )
          throw new Error(
            "내부 프로필 수정 저장 버튼으로 수정한 저장소 주소를 저장한 뒤 진행하세요.",
          );
        if (!setup.profile.peerInstallationId)
          throw new Error(
            "기존 프로필의 외부 설치 UUID를 서버 관리자에게 확인하세요. 기존 ID를 임의로 바꾸지 마세요.",
          );
        if (!setup.installed)
          throw new Error(
            "프로필이 아직 서버에 적용되지 않았습니다. 시스템 관리자에게 Node 서비스 재시작을 요청한 뒤 서버 적용 확인을 누르세요.",
          );
        if (!setup.credentialStored && !setup.tokenEnvironment)
          throw new Error("내부 GitHub 토큰을 저장한 뒤 진행하세요.");
      } else if (step === setupStep.publish) {
        const current = await api<SyncStatus>(prefix);
        if (!live.current) return;
        setStatus(current);
        setPublished(!!current.canonicalHead);
        if (!current.canonicalHead)
          throw new Error(
            "이 팀에 연결 → 연결 검사 → 초기 게시를 완료한 뒤 진행하세요.",
          );
      } else if (step < setupStep.account) {
        const invalid = validateSetupStep(step, draft);
        if (invalid) throw new Error(invalid);
        if (!confirmed[step])
          throw new Error(
            "이 단계의 작업과 확인 항목을 완료한 뒤 체크하세요. 체크는 실제 연결 검사를 대신하지 않습니다.",
          );
      } else if (!confirmed[step])
        throw new Error("외부 계정 연결과 팀 가져오기를 완료한 뒤 체크하세요.");
      if (live.current && nextStep !== undefined) {
        setStep(nextStep);
        setFurthest(Math.max(furthest, nextStep));
      }
    });
  }
  return (
    <section
      className="sync-setup"
      ref={section}
      aria-label={`${team.name} 외부 동기화 설정`}
    >
      <div className="sync-setup-header">
        <div>
          <h3>외부 동기화 설정</h3>
          <p>
            {team.name} · {external ? "외부망" : "내부망"}
          </p>
        </div>
        <Button disabled={busy} onClick={onClose}>
          설정 안내 닫기
        </Button>
      </div>
      {!external && (
        <ol className="sync-setup-phases" aria-label="설정 과정">
          <li>
            <button
              type="button"
              aria-current={!inServices ? "true" : undefined}
              disabled={busy}
              onClick={() => goToStep(available[0])}
            >
              <strong>1. 내부 프로필 설정</strong>
              <span>
                {setup?.profile && !setup.installed
                  ? "생성됨 · 재시작 요청 필요"
                  : published
                    ? "GitHub 초기 게시 완료"
                    : "GitHub 저장소 · 토큰 · 초기 게시"}
              </span>
            </button>
          </li>
          <li>
            <button
              type="button"
              aria-current={inServices ? "true" : undefined}
              disabled={
                busy ||
                !loaded ||
                servicesStep === undefined ||
                !reachable(servicesStep)
              }
              onClick={() => goToStep(Math.max(furthest, servicesStep!))}
            >
              <strong>2. 외부 서비스 설정</strong>
              <span>Cloudflare · Supabase · 배포 · 연결 확인</span>
            </button>
          </li>
        </ol>
      )}
      <ol className="sync-setup-steps" aria-label="설정 단계">
        {phaseSteps.map((index, position) => (
          <li key={steps[index]}>
            <button
              type="button"
              aria-current={index === step ? "step" : undefined}
              disabled={busy || !reachable(index)}
              onClick={() => goToStep(index)}
            >
              {position + 1}. {steps[index]}
            </button>
          </li>
        ))}
      </ol>
      <p className="field-help">
        {external
          ? "안내 진행"
          : inServices
            ? "외부 서비스 설정"
            : "내부 프로필 설정"}{" "}
        {phaseSteps.indexOf(step) + 1} / {phaseSteps.length} · 연결 상태는 실제
        검사 결과로 확인합니다.
      </p>
      <h4 ref={heading} tabIndex={-1}>
        {steps[step]}
      </h4>
      {!loaded && !error && (
        <LoadingState label="현재 팀 설정을 확인하고 있습니다." />
      )}
      {!external && step === setupStep.repository && (
        <>
          <p>
            내부 서버가 팀 자료를 게시할 GitHub 데이터 저장소와 토큰을
            등록합니다. 다음 <b>GitHub 연결</b> 단계에서 초기 게시를 마치면 팀
            자료가 이 저장소에 올라갑니다.
          </p>
          {setup && (
            <dl className="sync-setup-status" aria-label="내부 프로필 상태">
              <div>
                <dt>프로필 상태</dt>
                <dd>
                  {setup.installed
                    ? "서버 적용됨"
                    : setup.profile
                      ? "생성됨 · 시스템 관리자 재시작 필요"
                      : "아직 생성되지 않음"}
                </dd>
              </div>
            </dl>
          )}
          <p>
            인터넷이 되는 운영자 PC에서 GitHub 팀 전용 <b>Private repository</b>
            를 만들고 README를 추가하세요. 앱 소스 저장소와 분리합니다.
          </p>
          {editable ? (
            input(
              "GitHub 데이터 저장소",
              "repository",
              "https://github.com/organization/team-data",
            )
          ) : (
            <dl className="sync-setup-status">
              <div>
                <dt>GitHub 데이터 저장소</dt>
                <dd>{draft.repository || "미설정"}</dd>
              </div>
            </dl>
          )}
          {systemAdmin ? (
            <>
              {editable && (
                <Button
                  className="primary"
                  disabled={!loaded || busy}
                  onClick={() =>
                    void action(async () => {
                      const invalid = validateSetupStep(
                        setupStep.repository,
                        draft,
                      );
                      if (invalid) throw new Error(invalid);
                      const creating = !setup?.profile;
                      const saved = await send<Setup>(
                        setupPath,
                        {
                          repository: draft.repository,
                          expectedRevision: setup?.revision,
                        },
                        "PUT",
                      );
                      if (!live.current) return;
                      setSetup(saved);
                      onMessage(
                        `내부 프로필을 ${creating ? "생성" : "수정"}했습니다. ${
                          saved.restartRequired
                            ? "시스템 관리자에게 Node 서비스 재시작을 요청하세요."
                            : "서버에 바로 적용되었습니다."
                        }`,
                      );
                    })
                  }
                >
                  {setup?.profile
                    ? "내부 프로필 수정 저장"
                    : "내부 프로필 생성"}
                </Button>
              )}
              <p className="field-help">
                외부 서비스에 필요한 연결 정보는 배포 단계의 설정값에 자동으로
                채워집니다.
              </p>
              {setup?.restartRequired && (
                <p role="status">
                  이 서버의 최초 설치 식별자를 적용하려면 시스템 관리자에게 Node
                  서비스 재시작을 요청하세요. 이후 팀 프로필은 재시작 없이
                  적용됩니다. 재시작한 뒤 <b>서버 적용 확인</b>을 누르면 토큰을
                  저장할 수 있습니다.
                </p>
              )}
              {setup?.profile &&
                !setup.credentialReady &&
                !setup.restartRequired && (
                  <p>
                    토큰을 암호화해 저장하려면 서버 관리자가
                    GRAEBOARD_SYNC_KEY를 등록하고 재시작해야 합니다. 기존
                    암호문이 있으면 원래 키를 복원하세요.
                  </p>
                )}
              {setup?.profile &&
                (!setup.installed ||
                  !setup.credentialReady ||
                  setup.restartRequired) && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await load();
                        if (live.current)
                          setCredentialVersion((value) => value + 1);
                      })
                    }
                  >
                    서버 적용 확인
                  </Button>
                )}
              <div className="sync-setup-credential">
                <h5>내부 GitHub 토큰</h5>
                <p>
                  내부 서버가 이 저장소에 자료를 게시할 때 사용하는 토큰입니다.
                  다음 순서로 발급합니다.{" "}
                  <Link href={docs.github}>GitHub 안내</Link>
                </p>
                <ol>
                  <li>
                    GitHub 오른쪽 위 프로필 →{" "}
                    <b>
                      Settings → Developer settings → Personal access tokens →
                      Fine-grained tokens → Generate new token
                    </b>{" "}
                    (<Link href={docs.token}>바로 가기</Link>)
                  </li>
                  <li>
                    <b>Resource owner</b>는 저장소 소유자로,{" "}
                    <b>Repository access</b>는 <b>Only select repositories</b>
                    에서 위 데이터 저장소 하나만 선택합니다.
                  </li>
                  <li>
                    <b>Repository permissions → Contents</b>를{" "}
                    <b>Read and write</b>로 지정하고 만료일을 정해 생성합니다.
                    외부 서버용 토큰은 배포 단계에서 같은 방법으로 따로
                    발급합니다.
                  </li>
                </ol>
                {setup && (setup.credentialStored || !!setup.tokenPreview) && (
                  <div className="sync-setup-token">
                    <dl className="sync-setup-status">
                      <div>
                        <dt>등록된 토큰</dt>
                        <dd>
                          {setup.tokenPreview ? (
                            <code>{setup.tokenPreview}…</code>
                          ) : (
                            "현재 암호화 키로 확인할 수 없음"
                          )}
                          {!setup.credentialStored && " · 서버 환경 변수"}
                        </dd>
                      </div>
                    </dl>
                    {setup.credentialStored && (
                      <Button
                        disabled={busy || !setup.installed}
                        onClick={() =>
                          void action(async () => {
                            await send(
                              `/admin/teams/${team.id}/sync-credential`,
                              { profileId: setup.profile?.profileId },
                              "DELETE",
                            );
                            if (!live.current) return;
                            setCheck(null);
                            setCredentialVersion((value) => value + 1);
                            await load();
                          }, "토큰을 삭제했습니다.")
                        }
                      >
                        토큰 삭제
                      </Button>
                    )}
                  </div>
                )}
                {!setup?.credentialStored && (
                  <>
                    <p className="field-help">
                      {!setup?.profile
                        ? "내부 프로필을 생성한 뒤 저장할 수 있습니다."
                        : setup.tokenEnvironment
                          ? "여기에 저장하면 서버 환경 변수 토큰 대신 사용합니다."
                          : "토큰을 저장한 뒤 다음 단계에서 연결 검사를 실행하세요. 저장 성공은 GitHub 권한 검사와 별개입니다."}
                    </p>
                    <label>
                      내부 GitHub 토큰
                      <input
                        type="password"
                        value={token}
                        autoComplete="new-password"
                        spellCheck={false}
                        onChange={(event) => setToken(event.target.value)}
                        disabled={busy}
                      />
                    </label>
                    <Button
                      disabled={
                        busy ||
                        !token ||
                        !setup?.installed ||
                        !setup.credentialReady
                      }
                      onClick={() =>
                        void action(async () => {
                          await send(
                            `/admin/teams/${team.id}/sync-credential`,
                            { profileId: setup?.profile?.profileId, token },
                            "PUT",
                          );
                          if (!live.current) return;
                          setToken("");
                          setCheck(null);
                          setCredentialVersion((value) => value + 1);
                          await load();
                        }, "토큰을 암호화해 저장했습니다. 다음 단계에서 연결 검사를 실행하세요.")
                      }
                    >
                      토큰 저장
                    </Button>
                  </>
                )}
              </div>
            </>
          ) : (
            <p>
              내부 프로필 등록·토큰 교체는 시스템 관리자가 같은 팀의 설정
              안내에서 수행합니다. 설치된 프로필의 연결·초기 게시는 팀장이
              GitHub 연결 단계에서 진행할 수 있습니다.
            </p>
          )}
        </>
      )}
      {!external && step === setupStep.publish && (
        <>
          <p>
            <b>이 팀에 연결 → 연결 검사 → 초기 게시</b> 순서로 진행합니다. 초기
            게시가 끝나면 팀 자료가 GitHub 저장소에 올라가며 외부 서비스
            설정으로 넘어갈 수 있습니다. 이미 연결한 팀은 현재 상태에서
            이어갑니다.
          </p>
          <div key={credentialVersion}>{children}</div>
        </>
      )}
      {!external && step === setupStep.cloudflare && (
        <>
          <p>
            이 팀의 외부 사이트를 Cloudflare에 준비합니다. 아래 순서대로 만든 뒤
            값을 입력하면 배포 단계의 설정 파일에 자동으로 채워집니다.
          </p>
          <h5>① Pages 프로젝트 (외부 접속 주소)</h5>
          <ol>
            <li>
              Cloudflare 대시보드 <b>Workers & Pages → Create application</b>
              에서 <b>Pages</b>(화면 아래 “Looking to deploy Pages?”로 표시될 수
              있음) → <b>Import an existing Git repository</b>를 선택합니다.
            </li>
            <li>
              GitHub 연결 화면에서 Cloudflare 앱의 저장소 범위를{" "}
              <b>Only select repositories</b>로 두고 앱 소스 저장소{" "}
              <Link href={appSourceRepository}>{appSourceRepository}</Link>를
              선택합니다. 팀 데이터 저장소가 아닙니다. 앱은 설치하는 GitHub
              계정이 소유한 저장소만 고를 수 있으므로, 다른 계정으로 연결할 때는
              먼저 이 저장소를 그 계정으로 Fork한 뒤 Fork한 저장소를 선택합니다.
              Fork할 때 <b>Copy the main branch only</b> 체크를 해제해 release
              브랜치도 함께 복사합니다.
            </li>
            <li>
              <b>Set up builds and deployments</b>에 다음 값을 입력합니다.
              <dl className="sync-setup-status">
                <div>
                  <dt>Project name</dt>
                  <dd>
                    원하는 이름. <code>https://이름.pages.dev</code>가 외부 접속
                    주소가 됩니다.
                  </dd>
                </div>
                <div>
                  <dt>Production branch</dt>
                  <dd>
                    <code>release</code> (원본 저장소의 release에 올린 버전만
                    외부 사이트에 반영됩니다)
                  </dd>
                </div>
                <div>
                  <dt>Framework preset</dt>
                  <dd>None</dd>
                </div>
                <div>
                  <dt>Build command</dt>
                  <dd>
                    <code>npm run build</code>
                  </dd>
                </div>
                <div>
                  <dt>Build output directory</dt>
                  <dd>
                    <code>dist</code>
                  </dd>
                </div>
                <div>
                  <dt>Environment variables</dt>
                  <dd>
                    Variable name <code>NODE_VERSION</code>, Value{" "}
                    <code>22</code> (앱이 Node.js 22 이상에서만 빌드됩니다)
                  </dd>
                </div>
              </dl>
            </li>
            <li>
              <b>Save and Deploy</b>를 누릅니다. 프로젝트를 만든 뒤 변수를
              추가할 때는 <b>Settings → Variables and Secrets → Add</b>에서 Type{" "}
              <b>Text</b>, Variable name <code>NODE_VERSION</code>, Value{" "}
              <code>22</code>로 저장하고 <b>Deployments</b>에서 다시 배포해야
              적용됩니다.
            </li>
            <li>
              배포된 주소에 접속하면 “외부 서버에 연결할 수 없습니다”(503)가
              보입니다. gateway를 연결하기 전이라 정상입니다.
            </li>
          </ol>
          {input(
            "외부 접속 주소(Pages 도메인)",
            "appOrigin",
            "https://team.pages.dev",
          )}
          <h5>② R2 bucket (문서 이미지 저장소)</h5>
          <ol>
            <li>
              <Link href={docs.r2}>R2 Object Storage → Create bucket</Link>에서
              아래 이름 그대로 bucket을 만듭니다. R2를 처음 쓰는 계정은 결제
              수단 등록을 요구할 수 있습니다.
            </li>
            <li>
              bucket은 기본이 비공개입니다. bucket Settings의 공개 접근(r2.dev
              주소·Custom Domains)은 켜지 않습니다.
            </li>
          </ol>
          <div className="sync-setup-fields">
            <div>
              {input("비공개 R2 bucket 이름", "bucket")}
              <p className="field-help">
                추천 이름이 채워져 있습니다. 다른 이름으로 만들었다면 실제
                이름으로 바꾸세요.
              </p>
            </div>
            <div>
              {input("gateway Worker 이름", "gateway")}
              <p className="field-help">
                대시보드에서 만들지 않습니다. 배포 단계의{" "}
                <code>wrangler deploy</code>가 이 이름으로 Worker를 만들고
                R2·이미지 연결(R2_TEAM·IMAGES)도 설정합니다. 계정 안에서 겹치지
                않으면 그대로 씁니다.
              </p>
            </div>
          </div>
          <h5>③ Google 로그인 보호 (Access)</h5>
          <ol>
            <li>
              Cloudflare One(Zero Trust)을 처음 열면 팀 이름을 정합니다.{" "}
              <code>https://팀이름.cloudflareaccess.com</code>이 아래 Access
              발급자입니다.
            </li>
            <li>
              Zero Trust의 로그인 방법(Login methods) 설정에서 <b>Google</b>을
              추가합니다. Google Cloud에서 만든 OAuth 클라이언트 ID·Secret이
              필요합니다.
            </li>
            <li>
              Pages 프로젝트 <b>Settings → General → Enable access policy</b>를
              켜면 미리보기 주소(<code>*.프로젝트.pages.dev</code>)용 Access
              앱이 생깁니다. <b>Manage</b>로 그 앱을 열어 Public hostname의
              Subdomain 칸에서 <code>*</code>를 지우고 저장하면 운영 주소를
              보호합니다. 이어서 Enable access policy를 다시 켜 미리보기 보호도
              복원합니다. 미리보기 정책만으로는 운영 주소가 보호되지 않습니다.{" "}
              <Link href="https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain">
                Pages 운영·미리보기 보호
              </Link>
            </li>
            <li>
              운영 주소 앱의 정책은 <b>Allow</b>로 팀 Google 계정만 허용하고,
              Login methods는 <b>Google</b>만 선택합니다(One-time PIN 등은
              끕니다). 자체 도메인을 쓰면{" "}
              <b>
                Access controls → Applications → Create new application →
                Self-hosted and private → Add public hostname
              </b>
              에서 그 호스트 전체를 보호합니다.{" "}
              <Link href={docs.access}>Access 설정</Link>
            </li>
            <li>
              앱의 <b>Application Audience (AUD) Tag</b>를 복사해 아래에
              입력합니다.
            </li>
          </ol>
          <div className="sync-setup-fields">
            {input(
              "Access 발급자",
              "issuer",
              "https://organization.cloudflareaccess.com",
            )}
            {input("Application Audience", "audience")}
          </div>
          {acknowledge(
            "운영·미리보기 Access 정책, Google 로그인과 비공개 bucket을 콘솔에서 확인했습니다.",
          )}
        </>
      )}
      {!external && step === setupStep.supabase && (
        <>
          <p>
            Supabase에서 이 팀 전용 프로젝트 하나를 만드세요. Project
            Settings에서 Reference ID를 확인하고{" "}
            <b>Connect → Direct connection</b>의 PostgreSQL 주소를 운영자 PC에서
            사용합니다. IPv4 전용 환경이면 지원되는 연결 방식을{" "}
            <Link href={docs.database}>공식 안내</Link>에서 확인하세요.
          </p>
          {input("Supabase Reference ID", "projectRef")}
          <p>
            아래 명령은 <b>신규 외부 DB</b>용입니다. DB 주소는 숨김 입력으로
            받으며 먼저 dry-run 결과를 확인합니다. 기존 운영 프로젝트는 설치
            안내의 업그레이드·복구 절차를 사용하세요.
          </p>
          {copy("외부 DB 초기화 명령", examples.migration)}
          <p>
            완료 후 site v3·team v2와 위 팀 UUID가 일치하는지 확인합니다.
            graeboard·graeboard_site를 공개 Data API 스키마에 추가하지 않습니다.
            Edge Function(<code>graeboard</code>)은 gateway 주소가 정해진 뒤
            배포 단계에서 Secrets와 함께 배포합니다.
          </p>
          {acknowledge(
            "외부 DB 초기화 결과의 팀 UUID와 스키마 버전을 확인했습니다.",
          )}
        </>
      )}
      {!external && step === setupStep.deploy && (
        <>
          <p>
            외부 사이트의 화면은 gateway Worker(Cloudflare), 업무 API는 Supabase
            Edge 함수가 제공합니다. 둘 다 Pages와 별도로 배포해야 하며, 팀
            Fork가 원본 저장소의 <b>release</b>를 따라 자동으로 배포하게 하는
            방법(권장)과 운영자 PC에서 직접 배포하는 방법이 있습니다. 입력값은
            자원 생성·배포를 자동 실행하지 않습니다.
          </p>
          <h5>① gateway 설정</h5>
          <p>
            자동 배포는 아래 JSON 전체를 Fork의 Variables{" "}
            <code>GATEWAY_CONFIG</code>에, 수동 배포는 앱 소스 루트의{" "}
            <b>.env.gateway.json</b>(Git 제외 대상)으로 저장합니다.
          </p>
          {copy("gateway 설정", examples.gateway)}
          {input(
            "gateway 자원 주소",
            "resourceOrigin",
            "https://graeboard-team.account.workers.dev",
          )}
          <p className="field-help">
            Workers & Pages 화면에 표시되는 계정의 workers.dev 하위 도메인으로{" "}
            <code>https://gateway이름.하위도메인.workers.dev</code> 형태로
            입력합니다.
          </p>
          <h5>② Supabase Edge Secrets (처음 한 번)</h5>
          <p>
            Supabase <b>Edge Functions → Secrets</b>에 다음 이름과 값을 각각
            등록하세요. SYNC_PROFILES는 아래 JSON 전체를 그대로 붙여 넣습니다.{" "}
            <Link href={docs.secrets}>Secrets 안내</Link>
          </p>
          {Object.entries(examples.edge).map(([name, value]) => (
            <CopyValue
              key={name}
              label={name}
              value={value}
              onMessage={onMessage}
            />
          ))}
          <p>
            별도로 <b>GIT_TEAM</b>에는 내부 토큰과 같은 방법으로 따로 발급한
            외부 GitHub 토큰을 등록합니다. <b>GRAEBOARD_GATEWAY_SECRET</b>과{" "}
            <b>GRAEBOARD_RESOURCE_SECRET</b>은 서로 다른 32바이트 이상 난수를
            생성하여 gateway와 Edge 양쪽에 같은 값을 등록하세요.{" "}
            <b>GRAEBOARD_ACCESS_TOKEN_KEY</b>는 base64 32바이트 키를 생성해
            Edge에 등록하고 보존합니다. 이 비밀값들은 이 화면에 입력하지
            않습니다.
          </p>
          {copy(
            "난수 생성 명령 (각 키마다 별도 실행)",
            "openssl rand -base64 32",
          )}
          <p>
            gateway 쪽 두 Secret은 Worker가 만들어진 뒤(첫 배포 후){" "}
            <b>
              Workers & Pages → 해당 Worker → Settings → Variables and Secrets →
              Add
            </b>
            에서 Type <b>Secret</b>으로 등록하거나 아래 수동 배포 명령의{" "}
            <code>wrangler secret put</code>으로 등록합니다.
          </p>
          <h5>③ 자동 배포: 팀 Fork가 release를 따라감 (권장)</h5>
          <ol>
            <li>
              Fork의 <b>Actions</b> 탭에서 워크플로 실행을 허용하고{" "}
              <b>팀 사이트 release 배포</b> 워크플로를 켭니다.
            </li>
            <li>
              Fork <b>Settings → Secrets and variables → Actions</b>에
              등록합니다.
              <dl className="sync-setup-status">
                <div>
                  <dt>Variables</dt>
                  <dd>
                    <code>TEAM_SITE_DEPLOY</code> = <code>enabled</code>,{" "}
                    <code>CLOUDFLARE_ACCOUNT_ID</code> = Cloudflare 계정 ID,{" "}
                    <code>SUPABASE_PROJECT_REF</code> ={" "}
                    <code>{draft.projectRef || "Supabase Reference ID"}</code>,{" "}
                    <code>GATEWAY_CONFIG</code> = 위 gateway 설정 JSON 전체
                  </dd>
                </div>
                <div>
                  <dt>Secrets</dt>
                  <dd>
                    <code>CLOUDFLARE_API_TOKEN</code> = Cloudflare{" "}
                    <b>My Profile → API Tokens → Create Token</b>의 “Edit
                    Cloudflare Workers” 템플릿으로 만든 토큰,{" "}
                    <code>SUPABASE_ACCESS_TOKEN</code> = Supabase{" "}
                    <b>Account → Access Tokens</b>에서 만든 토큰
                  </dd>
                </div>
              </dl>
            </li>
            <li>
              Actions에서 <b>Run workflow</b>로 첫 배포를 실행합니다. 이후 원본
              저장소의 release가 바뀌면 30분 안에 자동으로 API → 화면 순서로
              배포하고, Pages도 release를 따라 다시 빌드합니다. 사내 서버는
              별도로 배포합니다.
            </li>
            <li>
              원본의 워크플로 파일이 바뀐 release는 기본 토큰으로 동기화할 수
              없어 실패로 표시됩니다. 그때는 Fork 화면의 <b>Sync fork</b>로
              맞추거나, Contents·Workflows 쓰기 권한이 있는 토큰을 Secret{" "}
              <code>SYNC_TOKEN</code>으로 등록합니다.
            </li>
          </ol>
          <h5>④ 수동 배포: 운영자 PC</h5>
          <p>
            아래 wrangler secret put의 숨김 입력에 같은 Secret을 넣습니다.
            Supabase CLI는 운영자 계정으로 인증하고, 저장소의 verify_jwt=false와
            gateway·Access 검증 코드를 함께 배포합니다. 새 버전마다 최신 release
            소스에서 다시 실행해야 합니다.
          </p>
          {copy("빌드·배포 명령", examples.deploy)}
          <h5>⑤ Pages 연결과 확인</h5>
          <p>
            Pages <b>Settings → Bindings → Add → Service binding</b>에 이름{" "}
            <b>GRAEBOARD_BACKEND</b>, 대상은 위 gateway를 지정하고
            Production/Preview를 각각 확인한 뒤 Pages를 재배포합니다.{" "}
            <Link href={docs.pages}>Pages binding</Link> ·{" "}
            <Link href={docs.deploy}>Edge 배포</Link>
          </p>
          <p>
            미인증 요청이 거절되고 Google 로그인 뒤 계정 연결 화면이 뜨는지
            확인하세요. 503이면 binding·Edge URL·Secret을, 인증 오류면 운영
            origin·Access Audience를 확인하여 같은 단계부터 재배포합니다. Cron은
            양방향 확인 후 켭니다.
          </p>
          {acknowledge(
            "Edge·gateway·Pages 배포와 미인증 접근 차단을 직접 확인했습니다.",
          )}
        </>
      )}
      {!external && step === setupStep.account && (
        <>
          <p>
            외부 사이트에 처음 접속할 팀장 계정을 연결하고 팀 자료를 가져옵니다.
          </p>
          <ol>
            <li>
              팀장이 아래에서 <b>팀장 연결 키</b>를 발급해 복사합니다. 키는
              GitHub를 거쳐 외부에 반영된 뒤 24시간 동안 한 번 사용할 수
              있습니다.
            </li>
            <li>
              외부 접속 주소에서 Google로 로그인한 뒤 자신의 사내 팀장 계정을
              선택하고 키를 입력합니다.
            </li>
            <li>
              외부 <b>설정 → 시스템 → 외부 동기화 → 외부 동기화 설정</b>에서{" "}
              <b>공통 연결 검사 → 팀 가져오기</b>를 진행합니다. 팀장이 보이지
              않으면 연결 키의 외부 반영 상태부터 확인하세요.
            </li>
          </ol>
          {lead ? (
            status && (
              <TeamSetupKey
                key={team.id}
                teamId={team.id}
                enabled={
                  !!status.canonicalHead &&
                  ["active", "paused"].includes(status.mode)
                }
                onMessage={onMessage}
              />
            )
          ) : (
            <p className="field-help">
              팀장 연결 키는 이 팀의 팀장 계정으로 로그인해 발급합니다.
            </p>
          )}
          {acknowledge(
            "외부 팀장 계정을 연결하고 해당 팀 자료를 가져왔습니다.",
          )}
        </>
      )}
      {external && step === 0 && (
        <>
          <p>
            현재 외부 사이트에 설치된 이 팀의 자원을 검사합니다. 클라우드 설치값
            변경은 인터넷이 되는 운영자 환경에서 진행합니다.
          </p>
          {profiles.map((profile) => (
            <dl className="sync-setup-status" key={profile.profileId}>
              <div>
                <dt>GitHub 데이터 저장소</dt>
                <dd>{profile.repository || "미설정"}</dd>
              </div>
            </dl>
          ))}
          <Button
            disabled={busy || !loaded}
            onClick={() =>
              void action(async () => {
                setCheck(null);
                const result = await send<{
                  checks: ConnectionCheck["checks"];
                  profiles: ResourceProfile[];
                }>("/admin/service-connections/check", {});
                if (!live.current) return;
                const ready =
                  result.checks.length > 0 &&
                  result.checks.every((item) => item.status === "ok") &&
                  result.profiles.some(
                    (profile) => profile.teamId === team.id && profile.ready,
                  );
                setProfiles(
                  result.profiles.filter(
                    (profile) => profile.teamId === team.id,
                  ),
                );
                setCheck({ checks: result.checks, ready });
                if (!ready)
                  throw new Error(
                    "오류 항목의 binding·Secret·DB 설정을 수정한 뒤 공통 연결 검사를 다시 실행하세요.",
                  );
              })
            }
          >
            공통 연결 검사
          </Button>
          <ConnectionChecks result={check} />
        </>
      )}
      {external && step === 1 && (
        <>
          <p>
            {status?.canonicalHead && status.mode !== "importing"
              ? "이미 가져온 팀입니다. 아래에서 기존 연결을 관리하고 다음 단계에서 양방향 반영을 확인하세요."
              : "내부에서 초기 게시한 이 팀 자료를 가져옵니다. 다른 팀 프로필은 선택할 수 없습니다. 실패하면 원인을 해결하고 팀 가져오기를 다시 실행하세요."}
          </p>
          {(!status?.canonicalHead || status.mode === "importing") &&
            profiles
              .filter((profile) => !profile.replaces)
              .map((profile) => (
                <Button
                  key={profile.profileId}
                  disabled={busy || profile.ready === false}
                  aria-busy={importing === profile.profileId || undefined}
                  onClick={() =>
                    void action(async () => {
                      setImporting(profile.profileId);
                      try {
                        await send("/admin/sync/import", {
                          profileId: profile.profileId,
                          teamId: team.id,
                        });
                        if (!live.current) return;
                        await onRefresh();
                        await load();
                      } finally {
                        if (live.current) setImporting("");
                      }
                    }, "팀 가져오기를 실행했습니다.")
                  }
                >
                  {importing === profile.profileId ? (
                    <>
                      <LoaderCircle size={14} className="spin" />팀 가져오기
                      처리 중…
                    </>
                  ) : (
                    "팀 가져오기"
                  )}
                </Button>
              ))}
          {children}
        </>
      )}
      {final && (
        <>
          <p>
            내부와 외부에서 각각 작은 업무 변경과 문서 이미지를 저장하고
            반대쪽에서 내용을 확인하세요. 앱의 적용 확인과 실제 내용 확인을 모두
            마쳐야 완료할 수 있습니다.
          </p>
          <dl className="sync-setup-status">
            <div>
              <dt>현재 연결</dt>
              <dd>{status?.mode || "확인 전"}</dd>
            </div>
            <div>
              <dt>미전송 / 충돌</dt>
              <dd>
                {status ? `${status.pending} / ${status.conflicts}` : "확인 전"}
              </dd>
            </div>
            <div>
              <dt>Git 반영</dt>
              <dd>{syncTime(status?.lastPublishedAt)}</dd>
            </div>
            <div>
              <dt>상대 서버 적용</dt>
              <dd>
                {verified
                  ? "최신 공유본 적용 확인"
                  : "확인 대기 · 양쪽 동기화 후 설정 완료로 확인하세요."}
              </dd>
            </div>
          </dl>
          <ErrorNote error={status?.lastError || ""} />
          <label className="sync-setup-ack">
            <input
              type="checkbox"
              checked={manual.internal}
              onChange={(event) =>
                setManual({ ...manual, internal: event.target.checked })
              }
            />
            내부에서 저장한 업무·이미지가 외부에 보입니다.
          </label>
          <label className="sync-setup-ack">
            <input
              type="checkbox"
              checked={manual.external}
              onChange={(event) =>
                setManual({ ...manual, external: event.target.checked })
              }
            />
            외부에서 저장한 업무·이미지가 내부에 보입니다.
          </label>
          <p className="field-help">
            상대 확인은 최근 3분 이내의 동일 공유본 적용 영수증으로 검사합니다.
            대기 중이면 양쪽 연결 상태·미전송·충돌을 확인하고 설정 완료를 다시
            누르세요. 완료 후 gateway의 triggers.crons를 ["* * * * *"]로
            설정하여 재배포하고 실행 로그를 확인합니다.
          </p>
        </>
      )}
      <div ref={errorRef}>
        <ErrorNote error={error} />
        {error && !loaded && (
          <Button disabled={busy} onClick={() => void action(() => load())}>
            다시 불러오기
          </Button>
        )}
      </div>
      {busy && <p role="status">처리 중…</p>}
      <div className="sync-setup-footer">
        <Button
          disabled={busy || previousStep === undefined}
          onClick={() => goToStep(previousStep!)}
        >
          {!external && step === servicesStep ? "내부 프로필 설정으로" : "이전"}
        </Button>
        {final ? (
          <Button
            className="primary"
            disabled={busy || !manual.internal || !manual.external}
            onClick={() =>
              void action(async () => {
                const current = await api<SyncStatus>(prefix);
                if (!live.current) return;
                setStatus(current);
                if (!syncVerification(current))
                  throw new Error(
                    "최신 공유본의 상대 적용을 아직 확인하지 못했습니다. 양쪽에서 동기화를 실행한 뒤 다시 확인하세요.",
                  );
                onMessage("양방향 동기화 확인을 마쳤습니다.");
                onClose();
              })
            }
          >
            설정 완료
          </Button>
        ) : (
          <Button
            className="primary"
            disabled={busy || !loaded}
            onClick={() => void next()}
          >
            {!external && nextStep === servicesStep
              ? "외부 서비스 설정으로"
              : "다음"}
          </Button>
        )}
      </div>
    </section>
  );
}
