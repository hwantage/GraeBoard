import { createRemoteJWKSet, jwtVerify } from "jose";
import { timingSafeEqual } from "node:crypto";

const keySets = new Map();
import { HttpError, requireThat as assert } from "../shared/http-error.js";
export { HttpError, assert };
export function assertOrigin(request, env) {
  let origin;
  try {
    const u = new URL(env.APP_ORIGIN);
    assert(
      u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        u.pathname === "/" &&
        !u.search &&
        !u.hash,
      503,
      "외부 주소 설정을 확인하세요.",
    );
    origin = u.origin;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "외부 주소 설정을 확인하세요.");
  }
  assert(
    new URL(request.url).origin === origin,
    403,
    "이 주소에서는 서비스를 사용할 수 없습니다.",
  );
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const source = request.headers.get("origin");
    assert(
      !source || source === origin,
      403,
      "다른 사이트의 요청은 허용하지 않습니다.",
    );
    assert(
      request.headers.get("x-requested-with") === "WeeklyPlan",
      403,
      "요청 헤더를 확인하세요.",
    );
  }
}
export async function verifyAccess(request, env, { jwks } = {}) {
  const issuer = env.ACCESS_ISSUER || env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUDIENCE || env.ACCESS_AUD;
  assert(
    typeof issuer === "string" &&
      /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) &&
      audience,
    503,
    "Access 인증 설정을 확인하세요.",
  );
  const token = request.headers.get("cf-access-jwt-assertion");
  assert(
    token && token.length < 32768,
    401,
    "Google 로그인 후 다시 시도하세요.",
  );
  if (!jwks) {
    if (!keySets.has(issuer))
      keySets.set(
        issuer,
        createRemoteJWKSet(new URL(issuer + "/cdn-cgi/access/certs")),
      );
    jwks = keySets.get(issuer);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub", "email"],
    });
    assert(
      payload.type === "app" &&
        typeof payload.sub === "string" &&
        payload.sub.length > 0 &&
        typeof payload.email === "string" &&
        payload.email.length <= 254,
      401,
      "사용자 로그인 토큰이 필요합니다.",
    );
    return {
      issuer,
      subject: payload.sub,
      email: payload.email.toLowerCase(),
      expiresAt: payload.exp * 1000,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "Google 로그인이 만료되었거나 올바르지 않습니다.");
  }
}
export function verifySetupToken(input, expected) {
  if (
    typeof input !== "string" ||
    typeof expected !== "string" ||
    expected.length < 24
  )
    return false;
  const a = Buffer.from(input),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
