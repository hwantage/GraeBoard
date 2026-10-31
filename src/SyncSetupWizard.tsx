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
  zeroTrust: "https://developers.cloudflare.com/cloudflare-one/setup/",
  google:
    "https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/",
  googleConsole: "https://console.cloud.google.com/",
  pagesAccess:
    "https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain",
  pages:
    "https://developers.cloudflare.com/pages/functions/bindings/#service-bindings",
  r2: "https://developers.cloudflare.com/r2/buckets/create-buckets/",
  secrets: "https://supabase.com/docs/guides/functions/secrets",
  deploy: "https://supabase.com/docs/guides/functions/deploy",
};
// Team leads without system administration cannot read installation IDs, so
// the operator steps that produce deployment values are left to the operator.
const operatorSteps = [
  setupStep.repository,
  setupStep.fork,
  setupStep.cloudflare,
  setupStep.supabase,
  setupStep.deploy,
];
const rememberedDraft = [
  "appOrigin",
  "issuer",
  "audience",
  "bucket",
  "projectRef",
  "accountId",
] as const;
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
  const [databaseSql, setDatabaseSql] = useState("");
  // Deploy tokens stay in this page's memory; only the generated values leave it.
  const [deployTokens, setDeployTokens] = useState({
    cloudflare: "",
    supabase: "",
    github: "",
  });
  const [deployValues, setDeployValues] = useState<{
    config: string;
    secrets: string;
  } | null>(null);
  const [importing, setImporting] = useState("");
  const [credentialVersion, setCredentialVersion] = useState(0);
  const [confirmed, setConfirmed] = useState<Record<number, boolean>>({});
  const [manual, setManual] = useState({ internal: false, external: false });
  // The console values typed in later steps are not secrets. Remember them per
  // team in this browser so a reload cannot empty the generated configuration.
  const draftKey = `graeboard:sync-setup:${team.id}`;
  const [draft, setDraft] = useState(() => {
    const initial = {
      repository: "",
      appOrigin: "",
      issuer: "",
      audience: "",
      bucket: `graeboard-${team.id.slice(0, 8)}`,
      gateway: `graeboard-${team.id.slice(0, 8)}`,
      projectRef: "",
      accountId: "",
    };
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || "{}");
      for (const key of rememberedDraft)
        if (typeof saved[key] === "string" && saved[key])
          initial[key] = saved[key];
    } catch {
      // Storage may be unavailable; the steps still work without it.
    }
    return initial;
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
  const servicesStep = available.find((index) => index >= setupStep.fork);
  const inServices = !external && step >= setupStep.fork;
  const phaseSteps = external
    ? available
    : available.filter((index) => index >= setupStep.fork === inServices);
  // An already published team may revisit any external service step without
  // re-entering the values that only fill the copyable examples.
  const reachable = (index: number) =>
    index <= furthest || (published && index >= setupStep.fork);
  const final = step === steps.length - 1;
  // The repository stays editable until the team has connection history; the
  // server enforces the same boundary.
  const editable = systemAdmin && !team.sync?.configured;
  const examples = setupExamples(team, setup, draft);
  // The Google OAuth client needs the Access team domain verbatim.
  const accessTeam = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(
    draft.issuer,
  )
    ? draft.issuer
    : "";
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
    if (!team.sync?.configured) setPublished(false);
  }, [team.sync?.configured]);
  useEffect(() => {
    section.current?.scrollIntoView({ block: "start" });
    heading.current?.focus({ preventScroll: true });
  }, [step]);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  useEffect(() => {
    if (external || !systemAdmin || step !== setupStep.supabase || databaseSql)
      return;
    const controller = new AbortController();
    void api<{ sql: string }>(`/admin/teams/${team.id}/external-db-sql`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setDatabaseSql(value.sql);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [external, systemAdmin, step, team.id, databaseSql]);
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
  useEffect(() => {
    try {
      localStorage.setItem(
        draftKey,
        JSON.stringify(
          Object.fromEntries(rememberedDraft.map((key) => [key, draft[key]])),
        ),
      );
    } catch {
      // Remembering is a convenience only.
    }
  }, [draftKey, draft]);
  const update = (key: keyof typeof draft, value: string) => {
    setDraft((previous) => ({ ...previous, [key]: value.trim() }));
    setDeployValues(null);
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
  const secretInput = (label: string, key: keyof typeof deployTokens) => (
    <label>
      {label}
      <input
        type="password"
        value={deployTokens[key]}
        onChange={(event) => {
          setDeployTokens({
            ...deployTokens,
            [key]: event.target.value.trim(),
          });
          setDeployValues(null);
        }}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
      />
    </label>
  );
  function makeDeployValues() {
    setError("");
    for (const [index, name] of [
      [setupStep.cloudflare, "Cloudflare"],
      [setupStep.supabase, "Supabase"],
    ] as const) {
      const invalid = validateSetupStep(index, draft);
      if (invalid)
        return setError(`${name} 단계의 값을 먼저 입력하세요. ${invalid}`);
    }
    const invalid = validateSetupStep(setupStep.deploy, draft);
    if (invalid) return setError(invalid);
    const absent = (
      [
        ["Cloudflare API 토큰", deployTokens.cloudflare],
        ["Supabase 액세스 토큰", deployTokens.supabase],
        ["외부용 GitHub 토큰", deployTokens.github],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (absent.length) return setError(`${absent.join(", ")}을 입력하세요.`);
    if (!/^[A-Za-z0-9_]+$/.test(deployTokens.github))
      return setError("외부용 GitHub 토큰 형식을 확인하세요.");
    // Fresh keys each time; the deployment keeps an access token key in use.
    const random = () =>
      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    setDeployValues({
      config: examples.siteConfig,
      secrets: JSON.stringify({
        CLOUDFLARE_API_TOKEN: deployTokens.cloudflare,
        SUPABASE_ACCESS_TOKEN: deployTokens.supabase,
        GIT_TEAM: deployTokens.github,
        GRAEBOARD_GATEWAY_SECRET: random(),
        GRAEBOARD_RESOURCE_SECRET: random(),
        GRAEBOARD_ACCESS_TOKEN_KEY: random(),
      }),
    });
  }
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
            "저장소 주소와 내부 GitHub 토큰을 입력하고 저장소·토큰 저장을 누르세요. 저장은 시스템 관리자가 진행합니다.",
          );
        if (
          draft.repository.replace(/\.git$/, "") !==
          repositoryUrl(setup.profile.repository)
        )
          throw new Error(
            "수정한 저장소 주소를 저장소·토큰 저장으로 저장한 뒤 진행하세요.",
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
          throw new Error("내부 GitHub 토큰을 입력해 저장한 뒤 진행하세요.");
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
  const repositoryChanged =
    editable &&
    (!setup?.profile ||
      draft.repository.replace(/\.git$/, "") !==
        repositoryUrl(setup.profile.repository));
  // The repository and its token only work as a pair, so one save stores both:
  // the profile first, then the token once the profile is applied.
  async function saveConnection() {
    await action(async () => {
      const invalid = validateSetupStep(setupStep.repository, draft);
      if (invalid) throw new Error(invalid);
      const value = token.trim();
      if (!value && !setup?.credentialStored && !setup?.tokenEnvironment)
        throw new Error(
          "내부 GitHub 토큰도 함께 입력하세요. 저장소와 토큰이 함께 있어야 연결할 수 있습니다.",
        );
      // Checked before the profile save so a rejected token never leaves a
      // half-saved pair behind.
      if (value && !/^[A-Za-z0-9_]+$/.test(value))
        throw new Error(
          "GitHub 토큰 형식을 확인하세요. 발급 화면에서 복사한 토큰 전체를 붙여 넣으세요.",
        );
      if (!value && !repositoryChanged)
        throw new Error("바뀐 내용이 없습니다.");
      let current = setup;
      if (repositoryChanged) {
        current = await send<Setup>(
          setupPath,
          { repository: draft.repository, expectedRevision: setup?.revision },
          "PUT",
        );
        if (!live.current) return;
        setSetup(current);
      } else if (!current?.installed) {
        // The operator may have restarted the service since the last save.
        current = await load();
        if (!live.current) return;
      }
      if (!value) {
        onMessage(
          current?.restartRequired
            ? "저장소 주소를 저장했습니다. 시스템 관리자에게 Node 서비스 재시작을 요청하세요."
            : "저장소 주소를 저장했습니다. 등록된 토큰이 이 저장소에 접근할 수 있는지 다음 단계의 연결 검사로 확인하세요.",
        );
        return;
      }
      if (!current?.installed) {
        onMessage(
          "저장소 주소를 저장했습니다. 이 서버의 최초 설정이라 Node 서비스를 재시작한 뒤 다시 저장하면 토큰도 저장합니다.",
        );
        return;
      }
      if (!current.credentialReady)
        throw new Error(
          "토큰을 암호화할 키가 서버에 없습니다. 서버 관리자에게 GRAEBOARD_SYNC_KEY 등록과 재시작을 요청하세요.",
        );
      await send(
        `/admin/teams/${team.id}/sync-credential`,
        { profileId: current.profile?.profileId, token: value },
        "PUT",
      );
      if (!live.current) return;
      setToken("");
      setCheck(null);
      setCredentialVersion((version) => version + 1);
      await load();
      if (!live.current) return;
      onMessage(
        repositoryChanged
          ? "저장소와 토큰을 저장했습니다. 다음 단계에서 연결 검사를 실행하세요."
          : "토큰을 암호화해 저장했습니다. 다음 단계에서 연결 검사를 실행하세요.",
      );
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
              <span>Fork · Cloudflare · Supabase · 배포 · 연결 확인</span>
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
          <h5>데이터 저장소 만들기</h5>
          <p>
            인터넷이 되는 운영자 PC에서 GitHub 팀 전용 <b>Private repository</b>
            를 만들고 README를 추가하세요. 앱 소스 저장소와 분리합니다.
          </p>
          {systemAdmin ? (
            <>
              <h5>내부 GitHub 토큰 발급</h5>
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
                  <b>Resource owner</b>는 저장소 소유자(개인 계정 또는 조직)로,{" "}
                  <b>Repository access</b>는 <b>Only select repositories</b>
                  에서 만든 데이터 저장소 하나만 선택합니다.
                </li>
                <li>
                  <b>Repository permissions → Contents</b>를{" "}
                  <b>Read and write</b>로 지정하고 만료일을 정해 생성합니다.
                  외부 서버용 토큰은 배포 단계에서 같은 방법으로 따로
                  발급합니다.
                </li>
              </ol>
              <form
                className="sync-setup-credential"
                aria-label="저장소·토큰 등록"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveConnection();
                }}
              >
                <h5>저장소·토큰 등록</h5>
                <p className="field-help">
                  저장소와 토큰은 함께 있어야 연결할 수 있으므로 한 번에
                  저장합니다.
                </p>
                {editable ? (
                  input(
                    "GitHub 데이터 저장소",
                    "repository",
                    "https://github.com/organization/team-data",
                  )
                ) : (
                  <>
                    <dl className="sync-setup-status">
                      <div>
                        <dt>GitHub 데이터 저장소</dt>
                        <dd>{draft.repository || "미설정"}</dd>
                      </div>
                    </dl>
                    {team.sync?.configured && (
                      <p className="field-help">
                        연결한 팀의 저장소는 <b>GitHub 연결</b> 단계에서{" "}
                        <b>연결 해제 → 연결 기록 초기화</b>를 한 뒤 여기서 바꿀
                        수 있습니다.
                      </p>
                    )}
                  </>
                )}
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
                )}
                {setup?.tokenEnvironment && !setup.credentialStored && (
                  <p className="field-help">
                    서버 환경 변수 토큰을 그대로 쓰려면 비워 두세요. 입력하면
                    저장한 토큰을 우선 사용합니다.
                  </p>
                )}
                {(editable || !setup?.credentialStored) && (
                  <Button
                    type="submit"
                    className="primary"
                    disabled={!loaded || busy}
                  >
                    {editable ? "저장소·토큰 저장" : "토큰 저장"}
                  </Button>
                )}
                <p className="field-help">
                  저장한 뒤 다음 단계의 <b>연결 검사</b>로 토큰이 이 저장소에
                  접근할 수 있는지 확인합니다.
                </p>
              </form>
              <p className="field-help">
                외부 서비스에 필요한 연결 정보는 배포 단계의 설정값에 자동으로
                채워집니다.
              </p>
              {setup?.restartRequired && (
                <p role="status">
                  이 서버의 최초 설치 식별자를 적용하려면 시스템 관리자에게 Node
                  서비스 재시작을 요청하세요. 이후 팀 프로필은 재시작 없이
                  적용됩니다. 재시작한 뒤 <b>서버 적용 확인</b>을 누르고 토큰을
                  입력해 다시 저장하세요.
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
            </>
          ) : (
            <>
              <dl className="sync-setup-status">
                <div>
                  <dt>GitHub 데이터 저장소</dt>
                  <dd>{draft.repository || "미설정"}</dd>
                </div>
              </dl>
              <p>
                내부 프로필 등록·토큰 교체는 시스템 관리자가 같은 팀의 설정
                안내에서 수행합니다. 설치된 프로필의 연결·초기 게시는 팀장이
                GitHub 연결 단계에서 진행할 수 있습니다.
              </p>
            </>
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
      {!external && step === setupStep.fork && (
        <>
          <p>
            외부 사이트는 앱 소스 저장소를 Cloudflare Pages에 연결해 화면을
            빌드합니다. 원본 앱 소스 저장소{" "}
            <Link href={appSourceRepository}>{appSourceRepository}</Link>를 이
            팀이 쓰는 GitHub 계정으로 Fork하고, 다음 <b>Cloudflare</b> 단계에서
            그 Fork를 Pages에 연결합니다.
          </p>
          <h5>Fork가 필요한 이유</h5>
          <ul>
            <li>
              Cloudflare Pages는 Cloudflare GitHub 앱을 설치한 계정(또는 조직)이
              소유한 저장소만 고를 수 있습니다. 원본은 다른 계정 소유라 목록에
              나오지 않습니다.
            </li>
            <li>
              원본의 <b>release</b> 브랜치에 새 버전이 올라오면 Fork가 이를
              따라가 외부 사이트에 반영합니다. 자동 반영은 <b>배포</b> 단계에서
              켭니다.
            </li>
            <li>
              Fork에는 앱 소스만 있고 팀 자료는 들어가지 않습니다. 팀 자료는
              GitHub 저장소 단계에서 등록한 비공개 데이터 저장소에만 올라갑니다.
              Fork는 원본처럼 공개 저장소가 됩니다.
            </li>
          </ul>
          <h5>Fork 절차</h5>
          <ol>
            <li>
              외부 사이트를 운영할 GitHub 계정으로 로그인한 뒤{" "}
              <Link href={`${appSourceRepository}/fork`}>
                원본 저장소의 Fork 화면
              </Link>
              을 엽니다. 원본 저장소 오른쪽 위 <b>Fork</b> 버튼과 같습니다.
            </li>
            <li>
              <b>Owner</b>에서 이 팀이 쓸 계정 또는 조직을 고르고{" "}
              <b>Repository name</b>은 그대로 둡니다.
            </li>
            <li>
              <b>Copy the main branch only</b> 체크를 해제합니다. 외부 사이트는{" "}
              <b>release</b> 브랜치를 배포하므로 release도 함께 복사해야 합니다.
            </li>
            <li>
              <b>Create fork</b>를 누른 뒤 Fork 저장소의 브랜치 목록에{" "}
              <code>release</code>가 있는지 확인합니다. 만들어진 Fork(예:{" "}
              <code>https://github.com/계정/GraeBoard</code>)를 다음 단계에서
              Pages에 연결합니다.
            </li>
          </ol>
          <p className="field-help">
            체크를 해제하지 못해 release가 없다면 Fork 저장소의{" "}
            <b>Settings → Delete this repository</b>로 지운 뒤 다시 Fork하세요.
            원본 저장소를 소유한 계정으로 직접 운영한다면 Fork 없이 원본을
            연결합니다.
          </p>
          {acknowledge(
            "Fork를 만들고 release 브랜치가 함께 복사된 것을 확인했습니다.",
          )}
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
              GitHub 계정 연결 화면에서 앞 단계에서 <b>Fork를 만든 계정</b>을
              고르고, <b>Repository access</b>를 <b>Only select repositories</b>
              로 두어 <b>Fork한 저장소</b>(예: <code>계정/GraeBoard</code>)만
              선택한 뒤 <b>Install & Authorize</b>를 누릅니다. 원본 저장소나 팀
              데이터 저장소를 고르지 않습니다. 이미 Cloudflare 앱을 설치한
              계정이면 GitHub{" "}
              <b>
                Settings → Applications → Cloudflare Workers and Pages →
                Configure
              </b>
              에서 Fork를 추가합니다.
            </li>
            <li>
              Cloudflare로 돌아와 <b>Select a repository</b>에서 같은 계정의
              Fork 저장소를 고르고 <b>Begin setup</b>을 누릅니다.
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
                    <code>release</code> (Fork의 release 브랜치. 원본 release에
                    올린 버전이 Fork에 반영될 때마다 다시 빌드됩니다)
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
          {input("비공개 R2 bucket 이름", "bucket")}
          <p className="field-help">
            추천 이름이 채워져 있습니다. 다른 이름으로 만들었다면 실제 이름으로
            바꾸세요.
          </p>
          <h5>③ Google 로그인 보호 (Access)</h5>
          <p>
            Cloudflare Access가 외부 접속 주소 앞에서 Google 로그인을 요구해
            허용한 팀원만 들어오게 합니다. Zero Trust 무료(Free) 플랜으로
            충분하며 50명까지 쓸 수 있습니다.{" "}
            <Link href={docs.pagesAccess}>Pages 운영·미리보기 보호</Link>
          </p>
          <h6>1) Zero Trust 무료 가입 (처음 한 번)</h6>
          <ol>
            <li>
              Cloudflare 대시보드 왼쪽 메뉴에서 <b>Zero Trust</b>를 엽니다.{" "}
              <Link href={docs.zeroTrust}>가입 안내</Link>
            </li>
            <li>
              팀 이름을 정합니다.{" "}
              <code>https://팀이름.cloudflareaccess.com</code>이 이 팀의 Access
              주소(팀 도메인)이며 아래 <b>Access 발급자</b>에 넣습니다. 나중에는{" "}
              <b>Zero Trust → Settings</b>에서 확인합니다.
            </li>
            <li>
              요금제에서 <b>Free</b>를 고르고 결제 수단을 등록합니다. 무료
              플랜도 등록 절차는 필요하지만 0원으로 청구되지 않습니다.
            </li>
          </ol>
          {input(
            "Access 발급자",
            "issuer",
            "https://팀이름.cloudflareaccess.com",
          )}
          <h6>2) Google 로그인용 OAuth 클라이언트 만들기 (Google Cloud)</h6>
          <ol>
            <li>
              <Link href={docs.googleConsole}>Google Cloud 콘솔</Link> 위쪽
              프로젝트 선택에서 새 프로젝트를 만듭니다(예:{" "}
              <code>graeboard-access</code>).
            </li>
            <li>
              왼쪽 위 메뉴 ☰에서 <b>APIs & Services(API 및 서비스)</b> →{" "}
              <b>Credentials(사용자 인증 정보)</b>로 이동합니다. 노란 안내의{" "}
              <b>Configure consent screen(동의 화면 구성)</b> →{" "}
              <b>Get started</b>
              에서 App name·User support email을 입력하고, Audience(대상)는{" "}
              <b>External(외부)</b>, Contact information에 이메일을 넣은 뒤
              정책에 동의하고 <b>Create</b>를 누릅니다. 화면이{" "}
              <b>Google Auth Platform(Google 인증 플랫폼)</b>의{" "}
              <b>Overview(개요)</b>로 바뀌며, 이후 작업은 이 화면의 왼쪽
              메뉴에서 합니다.
            </li>
            <li>
              <b>Overview(개요)</b>의 <b>OAuth 클라이언트 만들기</b>(Create
              OAuth client) 또는 왼쪽 메뉴 <b>Clients(클라이언트)</b>의 만들기
              버튼을 누릅니다. <b>OAuth 클라이언트 ID 만들기</b> 화면에서
              애플리케이션 유형(Application type)은{" "}
              <b>웹 애플리케이션(Web application)</b>, 이름은 알아보기 쉬운
              이름으로 정합니다. <b>승인된 JavaScript 원본</b>과{" "}
              <b>승인된 리디렉션 URI</b>에서 각각 <b>URI 추가</b>를 눌러 아래
              값을 넣고 <b>만들기(Create)</b>를 누릅니다.
            </li>
            <li>
              표시되는 <b>Client ID</b>와 <b>Client secret</b>을 바로 복사해
              둡니다. Client secret은 이때만 전체가 보일 수 있습니다.
            </li>
          </ol>
          {accessTeam ? (
            <>
              {copy(
                "승인된 JavaScript 원본(Authorized JavaScript origins)",
                accessTeam,
              )}
              {copy(
                "승인된 리디렉션 URI(Authorized redirect URIs)",
                `${accessTeam}/cdn-cgi/access/callback`,
              )}
            </>
          ) : (
            <p className="field-help">
              승인된 JavaScript 원본은{" "}
              <code>https://팀이름.cloudflareaccess.com</code>, 승인된 리디렉션
              URI는{" "}
              <code>
                https://팀이름.cloudflareaccess.com/cdn-cgi/access/callback
              </code>
              입니다. 위 Access 발급자를 입력하면 복사할 값이 채워집니다.
            </p>
          )}
          <h6>3) Zero Trust에 Google 로그인 추가</h6>
          <ol>
            <li>
              <b>
                Zero Trust → Integrations → Identity providers → Add new
                identity provider → Google
              </b>
              을 고릅니다. <Link href={docs.google}>Google 연결 안내</Link>
            </li>
            <li>
              <b>App ID</b>에 Client ID, <b>Client secret</b>에 Client secret을
              넣고 <b>Save</b>를 누릅니다.
            </li>
            <li>
              목록의 Google 옆 <b>Test</b>를 눌러 Google로 로그인한 뒤 성공
              화면이 나오는지 확인합니다.
            </li>
          </ol>
          <h6>4) Pages 주소 보호</h6>
          <ol>
            <li>
              <b>Workers & Pages → Pages 프로젝트 → Settings</b> 맨 아래{" "}
              <b>General</b>의 <b>Preview access</b>에서{" "}
              <b>Restrict previews</b>를 누릅니다. 미리보기 주소(
              <code>*.프로젝트.pages.dev</code>)용 Access 앱이 생깁니다.
              설명처럼 이 앱은 미리보기 주소만 보호하므로 다음 순서로 운영 주소{" "}
              <code>프로젝트.pages.dev</code>도 보호합니다.
            </li>
            <li>
              Cloudflare 대시보드 왼쪽 메뉴{" "}
              <b>Zero Trust → Access controls → Applications</b>에서{" "}
              <b>프로젝트 - Cloudflare Pages</b> 앱 이름을 눌러 편집 화면을
              엽니다. <b>Destinations → Public hostnames</b>의 Subdomain 칸에서{" "}
              <code>*</code>를 지우고 오른쪽 아래 <b>Save</b>를 누릅니다. 목록의
              Destinations가 <code>프로젝트.pages.dev</code>로 바뀌면 이 앱이
              운영 주소를 보호합니다(이하 “운영 앱”).
            </li>
            <li>
              Pages <b>Settings → General → Preview access</b>로 돌아가면 다시{" "}
              <b>Restrict previews</b>가 보입니다. 한 번 더 눌러 미리보기 보호를
              복원하고, Applications 목록에 Destinations가{" "}
              <code>프로젝트.pages.dev</code>인 앱과{" "}
              <code>*.프로젝트.pages.dev</code>인 앱 두 개가 있는지 확인합니다.
            </li>
          </ol>
          <h6>5) 허용할 계정과 로그인 방법</h6>
          <p>
            아래 두 설정은 Applications 목록의 두 앱(운영{" "}
            <code>프로젝트.pages.dev</code>, 미리보기{" "}
            <code>*.프로젝트.pages.dev</code>)에 <b>모두 똑같이</b> 적용합니다.
            앱마다 정책과 로그인 방법이 따로 있어 한쪽만 바꾸면 다른 주소는 예전
            설정으로 남습니다.
          </p>
          <ol>
            <li>
              Applications 목록의 편집 화면에서 <b>Access policies</b>의 정책
              이름(예: <b>Allow Members - Cloudflare Pages</b>)을 눌러 정책을
              엽니다. 기본 정책은 Cloudflare 계정 구성원만 허용합니다. Action은{" "}
              <b>Allow</b>로 두고 Include 규칙을 Selector <b>Login Methods</b>,
              Value <b>Google</b> 하나로 바꿔 저장합니다. Google 계정이면 누구나
              로그인 화면을 통과하고, 업무 자료는 GraeBoard에서 사내 계정 연결
              신청을 팀장이 승인해야 볼 수 있습니다. 특정 계정만 들이려면{" "}
              <b>Emails</b>(주소 정확히 일치)나 <b>Emails ending in</b>(
              <code>@회사도메인</code>)을 씁니다. Zero Trust 무료 플랜은 이
              주소에 로그인한 사용자 50명까지이며 승인 전 사용자도 셉니다.
            </li>
            <li>
              Applications 목록의 편집 화면에서 <b>Authentication</b>(위쪽{" "}
              <b>Login methods</b> 버튼으로 이동)의 로그인 방법 선택 칸에서{" "}
              <b>One-time PIN</b>을 ×로 지우고 <b>Google</b>을 고릅니다.{" "}
              <b>Accept all available identity providers</b>가 켜져 있으면
              끕니다. <b>Apply instant authentication</b>을 켜면 로그인 방법
              선택 없이 바로 Google 로그인으로 넘어갑니다. 오른쪽 아래{" "}
              <b>Save</b>를 누릅니다.
            </li>
          </ol>
          <h6>6) Application Audience 복사와 확인</h6>
          <ol>
            <li>
              운영 앱(Destinations에 <code>*</code>가 없는{" "}
              <code>프로젝트.pages.dev</code>) 편집 화면 맨 위{" "}
              <b>Additional settings</b> 탭에 있는{" "}
              <b>Application Audience (AUD) Tag</b>(64자)를 복사해 아래에
              입력합니다. 미리보기 앱의 AUD는 쓰지 않습니다. 외부 서버가 이
              값으로 로그인 토큰을 검사하므로 미리보기 주소로는 운영 자료에
              접근하지 못합니다.
            </li>
            <li>
              시크릿 창에서 운영 주소를 열어 Google 로그인 화면이 나오는지
              확인합니다. 허용한 계정으로 로그인하면 “외부 서버에 연결할 수
              없습니다”(503)가 보이는 것이 정상이고(아직 gateway 연결 전),
              허용하지 않은 계정은 막혀야 합니다.
            </li>
          </ol>
          {input("Application Audience", "audience")}
          {acknowledge(
            "운영·미리보기 Access 정책, Google 로그인과 비공개 bucket을 콘솔에서 확인했습니다.",
          )}
        </>
      )}
      {!external && step === setupStep.supabase && (
        <>
          <p>
            이 팀 전용 Supabase 프로젝트를 만들고, 업무 자료를 담을 DB를 웹
            화면의 SQL Editor에서 초기화합니다. PC에서 명령을 실행할 필요가
            없습니다.
          </p>
          <h5>① Supabase 프로젝트 만들기</h5>
          <ol>
            <li>
              Supabase 대시보드에서 <b>New project</b>로 이 팀 전용 프로젝트를
              만듭니다. Region은 팀원과 가까운 곳(예: Northeast Asia (Seoul))을
              고르고, Database password는 Supabase가 요구하므로 안전한 곳에
              보관합니다.
            </li>
            <li>
              <b>Project Settings → General</b>의 <b>Project ID</b>(Reference
              ID, 20자)를 복사해 아래에 입력합니다.
            </li>
          </ol>
          {input("Supabase Reference ID", "projectRef")}
          <h5>② 외부 DB 초기화 (SQL Editor)</h5>
          <ol>
            <li>
              프로젝트 왼쪽 메뉴의 <b>SQL Editor</b>에서 새 쿼리를 엽니다.
            </li>
            <li>
              아래 <b>외부 DB 초기화 SQL</b>을 복사해 전체를 붙여 넣고{" "}
              <b>Run</b>을 누릅니다. RLS 관련 확인 창이 나오면{" "}
              <b>Run without RLS</b>를 고릅니다. 앱은 서버에서 권한을 검사하며
              이 DB를 공개 API에 노출하지 않습니다.
            </li>
            <li>
              결과 표의 <code>team_uuid</code>가 이 팀 UUID(
              <code>{team.id}</code>)이고 <code>site_version</code> 3,{" "}
              <code>team_version</code> 2이면 완료입니다. “이미 테이블이 있어
              초기화하지 않았습니다” 오류는 이미 초기화한 DB라는 뜻이며 아무것도
              바뀌지 않았습니다. 기존 외부 DB의 업그레이드는 설치 안내의
              업그레이드 절차를 따릅니다.
            </li>
          </ol>
          {databaseSql ? (
            copy("외부 DB 초기화 SQL", databaseSql)
          ) : (
            <LoadingState label="외부 DB 초기화 SQL을 준비하고 있습니다." />
          )}
          <p className="field-help">
            graeboard·graeboard_site 스키마를 Data API의 exposed schemas에
            추가하지 않습니다. Edge Function(<code>graeboard</code>)은 배포
            단계에서 배포합니다.
          </p>
          {acknowledge(
            "SQL Editor 결과 표에서 팀 UUID와 site 3·team 2를 확인했습니다.",
          )}
        </>
      )}
      {!external && step === setupStep.deploy && (
        <>
          <p>
            외부 사이트의 화면은 gateway Worker(Cloudflare), 업무 API는 Supabase
            Edge 함수가 제공합니다. 아래에 토큰 세 개와 Cloudflare Account ID를
            입력하고 <b>배포 설정 만들기</b>를 누르면, Fork에 붙여 넣을 값 두
            개가 만들어집니다. 이 두 값을 넣고 실행하면 GitHub Actions가 배포와
            Worker 주소·비밀 키·Edge 설정 반영을 모두 처리합니다. 사내망이나
            PC에서 할 일은 없습니다.
          </p>
          <h5>① 토큰과 계정 ID 입력</h5>
          <dl className="sync-setup-status" aria-label="앞 단계에서 입력한 값">
            {(
              [
                ["외부 접속 주소", draft.appOrigin, "Cloudflare"],
                ["Access 발급자", draft.issuer, "Cloudflare"],
                [
                  "Application Audience",
                  draft.audience && `${draft.audience.slice(0, 12)}…`,
                  "Cloudflare",
                ],
                ["R2 bucket", draft.bucket, "Cloudflare"],
                ["Supabase Reference ID", draft.projectRef, "Supabase"],
              ] as const
            ).map(([name, value, where]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value || `입력 필요 · ${where} 단계에서 입력합니다`}</dd>
              </div>
            ))}
          </dl>
          <p className="field-help">
            앞 단계에서 입력한 값입니다. 이 브라우저에 기억되며, 비어 있으면
            해당 단계로 돌아가 입력합니다.
          </p>
          <ol>
            <li>
              <b>Cloudflare API 토큰</b>: Cloudflare <b>API Tokens</b>(오른쪽 위
              프로필 → My Profile, 또는 Account API tokens) →{" "}
              <b>Create Token</b>에서 <b>Edit Cloudflare Workers</b>의{" "}
              <b>Use template</b>을 누르면 권한이 채워진 화면이 열립니다. Token
              name만 알아보기 쉽게(예: <code>graeboard-deploy</code>) 바꾸고
              Permission policies는 그대로 둡니다. Token expiration은{" "}
              <b>No expiration</b>을 권합니다(만료일을 정하면 그날 이후 자동
              배포가 실패해 새 토큰으로 다시 만들어야 합니다). Client IP address
              filtering은 비워 둡니다(GitHub Actions의 IP는 매번 다릅니다).{" "}
              <b>Review token → Create Token</b>을 누르고 한 번만 표시되는
              토큰을 바로 아래 칸에 붙여 넣습니다.
            </li>
            <li>
              <b>Cloudflare Account ID</b>: <b>Workers & Pages</b> 화면의 계정
              정보에 있는 32자 값입니다.
            </li>
            <li>
              <b>Supabase 액세스 토큰</b>: Supabase 오른쪽 위 계정 메뉴의{" "}
              <b>Access Tokens</b>에서 <b>Generate new token</b>으로 만듭니다.
            </li>
            <li>
              <b>외부용 GitHub 토큰</b>: GitHub 저장소 단계의 내부 토큰과 같은
              방법(같은 데이터 저장소, Contents Read and write)으로 하나 더
              발급합니다. 외부 서버가 이 토큰으로 자료를 주고받습니다.
            </li>
          </ol>
          <div className="sync-setup-fields">
            {secretInput("Cloudflare API 토큰", "cloudflare")}
            {input("Cloudflare Account ID", "accountId")}
            {secretInput("Supabase 액세스 토큰", "supabase")}
            {secretInput("외부용 GitHub 토큰", "github")}
          </div>
          <p className="field-help">
            입력한 토큰은 이 브라우저에서 값을 만드는 데만 쓰고 사내 서버로
            보내거나 저장하지 않습니다.
          </p>
          <Button
            className="primary"
            disabled={busy}
            onClick={makeDeployValues}
          >
            배포 설정 만들기
          </Button>
          {deployValues && (
            <>
              <h5>② Fork 저장소에 두 값 넣기</h5>
              <p>
                GitHub에서 Fork한 GraeBoard 저장소를 열고{" "}
                <b>Settings → (왼쪽 메뉴) Secrets and variables → Actions</b>로
                갑니다. 아래 두 값에 배포에 필요한 설정·토큰·비밀 키가 모두 들어
                있습니다.
              </p>
              <ol>
                <li>
                  <b>Variables</b> 탭 → <b>New repository variable</b> → Name에{" "}
                  <code>TEAM_SITE_CONFIG</code>를 입력하고 Value에 아래 값을
                  붙여 넣은 뒤 <b>Add variable</b>을 누릅니다.
                </li>
              </ol>
              {copy("TEAM_SITE_CONFIG", deployValues.config)}
              <ol start={2}>
                <li>
                  <b>Secrets</b> 탭 → <b>New repository secret</b> → Name에{" "}
                  <code>TEAM_SITE_SECRETS</code>를 입력하고 Secret에 아래 값을
                  붙여 넣은 뒤 <b>Add secret</b>을 누릅니다.
                </li>
              </ol>
              {copy("TEAM_SITE_SECRETS", deployValues.secrets)}
              <p className="field-help">
                GitHub에 넣은 뒤에는 따로 보관하지 않아도 됩니다. 토큰을
                바꾸거나 값을 고칠 때는 이 화면에서 다시 만들어 같은 이름의 값을{" "}
                <b>Update</b>로 덮어씁니다. 다시 만들어도 이미 쓰고 있는 접속
                토큰 암호화 키는 배포 때 그대로 유지됩니다.
              </p>
              <h5>③ 배포 실행</h5>
              <ol>
                <li>
                  Fork 저장소 첫 화면에 <b>This branch is … behind</b>가 보이면{" "}
                  <b>Sync fork → Update branch</b>를 누릅니다. 왼쪽 위 브랜치
                  선택을 <code>release</code>로 바꿔 한 번 더 누릅니다. 원본의
                  배포 설정 파일이 바뀐 버전은 자동 동기화가 받을 수 없어 두
                  브랜치 모두 이렇게 맞춥니다.
                </li>
                <li>
                  <b>Actions</b> 탭에서 워크플로 사용을 허용합니다(Fork는 처음에
                  꺼져 있습니다). 왼쪽 <b>팀 사이트 release 배포</b>를 고르고{" "}
                  <b>Run workflow → Run workflow</b>를 누릅니다.
                </li>
                <li>
                  몇 분 뒤 초록 체크가 표시되면 끝입니다. Supabase Edge 함수{" "}
                  <code>graeboard</code>와 gateway Worker{" "}
                  <code>{draft.gateway}</code>가 만들어지고 Worker 주소·비밀
                  키·Edge 설정이 양쪽에 들어갑니다. 실패하면 빨간 단계를 열어 첫{" "}
                  <code>Error</code> 줄을 확인합니다. 빠진 값이 있으면 그 이름이
                  표시됩니다.
                </li>
                <li>
                  이후 원본의 release가 바뀌면 30분 안에 같은 순서로 자동
                  배포되고 Pages도 release를 따라 다시 빌드됩니다. 사내 서버는
                  별도로 배포합니다. 원본의 배포 설정 파일이 바뀐 release는 자동
                  동기화가 실패로 표시되며, 그때는 <b>Sync fork</b>를 누릅니다.
                </li>
              </ol>
              <h5>④ Pages 연결과 확인</h5>
              <p>
                Pages 프로젝트{" "}
                <b>Settings → Bindings → Add → Service binding</b>에 이름{" "}
                <b>GRAEBOARD_BACKEND</b>, 대상 <code>{draft.gateway}</code>,
                Entrypoint는 <b>Default</b>로 지정하고 Production/Preview를 각각
                확인합니다. binding은 새 배포부터 적용되므로 <b>Deployments</b>
                에서 최신 배포의 <b>⋯ → Retry deployment</b>를 누릅니다.{" "}
                <Link href={docs.pages}>Pages binding</Link>
              </p>
              <p>
                시크릿 창에서 외부 접속 주소를 열어 Google 로그인 뒤 계정 연결
                화면이 뜨는지 확인합니다. 503이면 binding과 Actions 실행 결과를,
                인증 오류면 외부 접속 주소·Access Audience를 확인합니다. Cron은
                양방향 확인 후 켭니다.
              </p>
              <details className="sync-connection-details">
                <summary>PC에서 직접 배포하기 (선택)</summary>
                <p>
                  GitHub Actions를 쓰지 않을 때만 사용합니다. Node 22와 Supabase
                  CLI가 있는 PC에서 최신 release 소스를 받고, 위 두 값을 소스
                  루트의 <b>team-site-config.json</b>·
                  <b>team-site-secrets.json</b>으로 저장한 뒤 아래 명령을
                  실행합니다. 두 파일은 Git에 올리지 않고 끝나면 지웁니다. 새
                  버전마다 다시 실행합니다.{" "}
                  <Link href={docs.deploy}>Edge 배포</Link>
                </p>
                {copy("빌드·배포 명령", examples.deploy)}
              </details>
            </>
          )}
          {acknowledge(
            "Actions 배포 성공, Pages 연결과 미인증 접근 차단을 직접 확인했습니다.",
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
