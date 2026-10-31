export const setupSteps = [
  "GitHub 저장소",
  "GitHub 연결",
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
  cloudflare: 2,
  supabase: 3,
  deploy: 4,
  account: 5,
  verify: 6,
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
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(draft.gateway))
      return "gateway 이름은 영문 소문자로 시작하는 영문·숫자·하이픈으로 입력하세요.";
  }
  if (step === setupStep.supabase && !/^[a-z0-9]{20}$/.test(draft.projectRef))
    return "Supabase 프로젝트 Reference ID 20자리를 입력하세요.";
  if (
    step === setupStep.deploy &&
    (!origin(draft.resourceOrigin) ||
      !new URL(draft.resourceOrigin).hostname.endsWith(".workers.dev"))
  )
    return "배포한 gateway의 HTTPS workers.dev 주소를 입력하세요.";
  return "";
}
const shell = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
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
    RESOURCE_ORIGIN: draft.resourceOrigin,
  };
  return {
    edge,
    profile: JSON.stringify(externalProfile, null, 2),
    gateway: JSON.stringify(
      {
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
      },
      null,
      2,
    ),
    migration: `read -s PG_SITE_URL\nexport PG_SITE_URL\nnpm run migrate -- --engine postgres --scope site --url-env PG_SITE_URL --team-id ${shell(team.id)} --team-name ${shell(team.name)} --initialize --dry-run\nnpm run migrate -- --engine postgres --scope site --url-env PG_SITE_URL --team-id ${shell(team.id)} --team-name ${shell(team.name)} --initialize\nunset PG_SITE_URL`,
    deploy: `npm run build\nnpm run build:edge\nnpm run build:pages\nnpx wrangler deploy --config .env.gateway.json\nnpx wrangler secret put GRAEBOARD_GATEWAY_SECRET --config .env.gateway.json\nnpx wrangler secret put GRAEBOARD_RESOURCE_SECRET --config .env.gateway.json\nnpx supabase functions deploy graeboard --project-ref ${shell(draft.projectRef)} --use-api`,
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
