// The server host owns this setting. A browser URL, request body or NODE_ENV
// must never turn the internal password server into an external Access server.
export function deploymentSite(env, host) {
  const site = env.GRAEBOARD_SITE ?? host;
  if (!["internal", "external"].includes(site) || site !== host)
    throw Object.assign(
      new Error(`이 서버의 GRAEBOARD_SITE는 ${host}이어야 합니다.`),
      { status: 503 },
    );
  return site;
}
