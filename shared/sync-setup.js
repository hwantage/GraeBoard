export const setupSteps = [
  "GitHub 저장소",
  "GitHub 연결",
  "GitHub Fork",
  "Cloudflare",
  "Supabase",
  "배포",
  "외부 계정",
  "양방향 확인",
];
export const appSourceRepository = "https://github.com/hwantage/GraeBoard";
export const setupStep = {
  repository: 0,
  publish: 1,
  fork: 2,
  cloudflare: 3,
  supabase: 4,
  deploy: 5,
  account: 6,
  verify: 7,
};
export const externalSetupSteps = ["설치 확인", "팀 가져오기", "양방향 확인"];
const origin = (value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.origin === value
    );
  } catch {
    return false;
  }
};
export function validateSetupStep(step, draft) {
  if (
    step === setupStep.repository &&
    !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(
      draft.repository,
    )
  )
    return "GitHub 저장소 주소를 https://github.com/소유자/저장소 형식으로 입력하세요.";
  if (step === setupStep.cloudflare) {
    if (!origin(draft.appOrigin))
      return "외부 접속 주소는 경로와 마지막 / 없이 HTTPS 주소로 입력하세요.";
    if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(draft.issuer))
      return "Access 발급자는 https://조직.cloudflareaccess.com 형식으로 입력하세요.";
    if (!/^[a-f0-9]{64}$/i.test(draft.audience))
      return "Access 앱의 64자리 Application Audience를 입력하세요.";
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(draft.bucket))
      return "R2 bucket 이름은 영문 소문자·숫자·하이픈 3~63자로 입력하세요.";
  }
  if (step === setupStep.supabase && !/^[a-z0-9]{20}$/.test(draft.projectRef))
    return "Supabase 프로젝트 Reference ID 20자리를 입력하세요.";
  if (step === setupStep.deploy && !/^[0-9a-f]{32}$/.test(draft.accountId))
    return "Cloudflare Account ID 32자리를 입력하세요.";
  return "";
}
export function setupExamples(team, setup, draft) {
  const profile = setup?.profile;
  const externalProfile = [
    {
      profileId: profile?.profileId || `team-${team.id}`,
      teamId: team.id,
      repository: draft.repository
        .replace("https://github.com/", "")
        .replace(/\.git$/, ""),
      databaseBinding: "PG_SITE",
      bucketBinding: "R2_TEAM",
      githubSecret: "GIT_TEAM",
    },
  ];
  const edge = {
    GRAEBOARD_SITE: "external",
    SITE_NAME: team.name,
    SITE_TEAM_ID: team.id,
    INSTALLATION_ID:
      profile?.peerInstallationId || "기존 외부 설치 UUID 확인 필요",
    PEER_INSTALLATION_ID: setup?.installationId || "내부 프로필 생성 필요",
    APP_ORIGIN: draft.appOrigin,
    ACCESS_ISSUER: draft.issuer,
    ACCESS_AUDIENCE: draft.audience,
    SYNC_PROFILES: JSON.stringify(externalProfile),
  };
  const gateway = {
    name: draft.gateway,
    main: "worker/gateway.mjs",
    compatibility_date: "2026-10-23",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    preview_urls: false,
    assets: {
      directory: "./dist",
      binding: "ASSETS",
      run_worker_first: true,
      not_found_handling: "single-page-application",
    },
    images: { binding: "IMAGES" },
    triggers: { crons: [] },
    vars: {
      APP_ORIGIN: draft.appOrigin,
      ACCESS_ISSUER: draft.issuer,
      ACCESS_AUDIENCE: draft.audience,
      SITE_TEAM_ID: team.id,
      GRAEBOARD_EDGE_URL: `https://${draft.projectRef}.supabase.co/functions/v1/graeboard`,
    },
    r2_buckets: [{ binding: "R2_TEAM", bucket_name: draft.bucket }],
  };
  return {
    edge,
    profile: JSON.stringify(externalProfile, null, 2),
    gateway: JSON.stringify(gateway, null, 2),
    // The fork's single TEAM_SITE_CONFIG variable; the release workflow deploys
    // from it and fills both sides' settings (scripts/team-site-deploy.mjs).
    siteConfig: JSON.stringify(
      {
        cloudflareAccountId: draft.accountId,
        supabaseProjectRef: draft.projectRef,
        gateway,
        edge,
      },
      null,
      2,
    ),
    deploy:
      'npm ci\nnpm run build\nnpm run build:edge\nexport TEAM_SITE_CONFIG="$(cat team-site-config.json)"\nexport TEAM_SITE_SECRETS="$(cat team-site-secrets.json)"\nnode scripts/team-site-deploy.mjs\nunset TEAM_SITE_SECRETS',
  };
}
export function syncVerification(status, now = Date.now()) {
  const peer = status?.remoteStatus;
  return !!(
    status?.canonicalHead &&
    status.mode === "active" &&
    !status.pending &&
    !status.conflicts &&
    !status.lastError &&
    peer?.verified &&
    peer.mode === "active" &&
    peer.appliedCanonicalHead === status.canonicalHead &&
    now - Date.parse(peer.observedAt) >= 0 &&
    now - Date.parse(peer.observedAt) < 180000
  );
}
