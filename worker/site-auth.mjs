import { controlTransaction } from "./data.mjs";
import { siteTeamId } from "./config.mjs";
import { refreshDirectory } from "./directory.mjs";
import { assert, verifySetupToken } from "./access.mjs";
import { userRecord } from "../server/storage/control-store.mjs";
import { digest } from "../server/sync/protocol.mjs";

const COOKIE = "__Host-graeboard_account";
const SESSION_MS = 30 * 86400000;
function tokenFrom(request) {
  return (
    (request?.headers.get("cookie") || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(COOKIE + "="))
      ?.slice(COOKIE.length + 1) || ""
  );
}
const cookie = (token, maxAge = SESSION_MS / 1000) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
async function session(tx, identity, userId) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  await tx.query("DELETE FROM access_sessions WHERE expires_at<$1", [
    Date.now(),
  ]);
  await tx.query("INSERT INTO access_sessions VALUES($1,$2,$3,$4,$5)", [
    digest(token),
    identity.issuer,
    identity.subject,
    userId,
    Date.now() + SESSION_MS,
  ]);
  return { "Set-Cookie": cookie(token) };
}
async function eligible(tx, teamId, userId) {
  return (
    await tx.query(
      "SELECT u.*,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=$1 AND m.team_id=$2 AND u.active=TRUE AND u.source_managed=TRUE",
      [userId, teamId],
    )
  ).rows[0];
}
async function hasLinkedLead(tx, teamId) {
  return (
    (
      await tx.query(
        "SELECT 1 FROM access_identities a JOIN users u ON u.id=a.user_id JOIN memberships m ON m.user_id=u.id WHERE m.team_id=$1 AND m.role='lead' AND u.active=TRUE LIMIT 1",
        [teamId],
      )
    ).rows.length > 0
  );
}
export async function authenticateSite(env, identity, request) {
  return controlTransaction(env, async (tx) => {
    const selected = (
      await tx.query(
        "SELECT s.user_id FROM access_sessions s JOIN access_identities a ON a.issuer=s.issuer AND a.subject=s.subject AND a.user_id=s.user_id WHERE s.token_hash=$1 AND s.issuer=$2 AND s.subject=$3 AND s.expires_at>$4",
        [
          digest(tokenFrom(request)),
          identity.issuer,
          identity.subject,
          Date.now(),
        ],
      )
    ).rows[0];
    assert(selected, 401, "연결할 사내 계정을 선택하세요.");
    const user = await eligible(tx, siteTeamId(env), selected.user_id);
    assert(user, 403, "현재 이 팀에 접근할 권한이 없습니다.");
    return userRecord(tx, user);
  });
}
async function accounts(env, identity) {
  return controlTransaction(env, async (tx) => {
    const meta = (
      await tx.query(
        "SELECT setup_complete FROM control_meta WHERE singleton=1",
      )
    ).rows[0];
    const setupRequired =
      !meta.setup_complete || !(await hasLinkedLead(tx, siteTeamId(env)));
    const rows = (
      await tx.query(
        "SELECT u.id,u.name,u.username,m.role,r.status AS request_status,EXISTS(SELECT 1 FROM access_identities a WHERE a.issuer=$2 AND a.subject=$3 AND a.user_id=u.id) AS linked FROM users u JOIN memberships m ON m.user_id=u.id LEFT JOIN access_requests r ON r.user_id=u.id AND r.issuer=$2 AND r.subject=$3 WHERE m.team_id=$1 AND u.active=TRUE AND u.source_managed=TRUE ORDER BY u.name,u.id",
        [siteTeamId(env), identity.issuer, identity.subject],
      )
    ).rows;
    return {
      required: setupRequired,
      tokenRequired: setupRequired,
      authMode: "access",
      accountLinking: true,
      email: identity.email,
      accounts: rows
        .filter((row) => !setupRequired || row.role === "lead")
        .map((row) => ({
          id: row.id,
          name: row.name,
          username: row.username,
          role: row.role,
          status: row.linked ? "approved" : row.request_status || "unlinked",
        })),
    };
  });
}

// All these routes still require a verified Cloudflare Access JWT in entry.mjs.
// Only the initial team lead can bypass approval, using the installation secret.
export async function siteAuthRoute(
  env,
  identity,
  request,
  path,
  method,
  body,
) {
  const teamId = siteTeamId(env);
  if (!teamId) return null;
  if ((path === "/setup" || path === "/auth/accounts") && method === "GET") {
    await refreshDirectory(env);
    return { body: await accounts(env, identity) };
  }
  if (path === "/auth/logout" && method === "POST") {
    await controlTransaction(env, (tx) =>
      tx.query(
        "DELETE FROM access_sessions WHERE token_hash=$1 AND issuer=$2 AND subject=$3",
        [digest(tokenFrom(request)), identity.issuer, identity.subject],
      ),
    );
    return {
      body: { ok: true, logoutUrl: "/cdn-cgi/access/logout" },
      headers: { "Set-Cookie": cookie("", 0) },
    };
  }
  if (
    !["/auth/setup", "/auth/link-request", "/auth/select-account"].includes(
      path,
    ) ||
    method !== "POST"
  )
    return null;
  await refreshDirectory(env, { force: true });
  return controlTransaction(
    env,
    async (tx) => {
      const user = await eligible(tx, teamId, body.userId);
      assert(user, 400, "현재 팀에 소속된 사내 계정을 선택하세요.");
      const meta = (
        await tx.query(
          "SELECT setup_complete FROM control_meta WHERE singleton=1 FOR UPDATE",
        )
      ).rows[0];
      if (path === "/auth/setup") {
        assert(
          !meta.setup_complete || !(await hasLinkedLead(tx, teamId)),
          409,
          "초기 설정이 이미 완료되었습니다.",
        );
        assert(
          verifySetupToken(body.setupToken, env.SETUP_TOKEN),
          403,
          "일회용 설치 토큰을 확인하세요.",
        );
        assert(
          !env.BOOTSTRAP_ADMIN_EMAIL ||
            env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase() === identity.email,
          403,
          "지정된 초기 관리자 계정으로 로그인하세요.",
        );
        assert(
          !env.BOOTSTRAP_ADMIN_SUBJECT ||
            env.BOOTSTRAP_ADMIN_SUBJECT === identity.subject,
          403,
          "지정된 초기 관리자 계정으로 로그인하세요.",
        );
        assert(
          user.role === "lead",
          403,
          "최초 연결은 사내 팀장 계정을 선택하세요.",
        );
        const existing = (
          await tx.query(
            "SELECT issuer,subject FROM access_identities WHERE user_id=$1",
            [user.id],
          )
        ).rows[0];
        assert(
          !existing ||
            (existing.issuer === identity.issuer &&
              existing.subject === identity.subject),
          409,
          "이미 다른 Google 계정에 연결되어 있습니다.",
        );
        await tx.query(
          "INSERT INTO access_identities VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [identity.issuer, identity.subject, user.id],
        );
        await tx.query(
          "INSERT INTO access_requests(id,issuer,subject,email,user_id,status,created_at,resolved_by,resolved_at) VALUES($1,$2,$3,$4,$5,'approved',$6,$5,$6) ON CONFLICT(issuer,subject,user_id) DO UPDATE SET status='approved',email=EXCLUDED.email,resolved_by=EXCLUDED.resolved_by,resolved_at=EXCLUDED.resolved_at",
          [
            crypto.randomUUID(),
            identity.issuer,
            identity.subject,
            identity.email,
            user.id,
            new Date().toISOString(),
          ],
        );
        await tx.query(
          "UPDATE control_meta SET setup_complete=TRUE WHERE singleton=1",
        );
        return {
          status: 201,
          body: { ok: true },
          headers: await session(tx, identity, user.id),
        };
      }
      assert(meta.setup_complete, 409, "팀장의 최초 연결을 먼저 완료하세요.");
      const link = (
        await tx.query(
          "SELECT issuer,subject FROM access_identities WHERE user_id=$1",
          [user.id],
        )
      ).rows[0];
      const linked =
        link?.issuer === identity.issuer && link?.subject === identity.subject;
      if (path === "/auth/select-account") {
        assert(linked, 403, "팀장이 승인한 사내 계정만 사용할 수 있습니다.");
        return {
          body: { ok: true },
          headers: await session(tx, identity, user.id),
        };
      }
      if (linked) return { body: { status: "approved" } };
      assert(
        !link,
        409,
        "이미 연결된 계정입니다. 팀장에게 연결 해제를 요청하세요.",
      );
      await tx.query(
        "UPDATE access_requests SET status='rejected',resolved_at=$1 WHERE issuer=$2 AND subject=$3 AND user_id<>$4 AND status='pending'",
        [new Date().toISOString(), identity.issuer, identity.subject, user.id],
      );
      await tx.query(
        "INSERT INTO access_requests(id,issuer,subject,email,user_id,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(issuer,subject,user_id) DO UPDATE SET email=EXCLUDED.email,status='pending',created_at=EXCLUDED.created_at,resolved_by=NULL,resolved_at=NULL",
        [
          crypto.randomUUID(),
          identity.issuer,
          identity.subject,
          identity.email,
          user.id,
          new Date().toISOString(),
        ],
      );
      return { body: { status: "pending" } };
    },
    { write: true },
  );
}

export async function accessRequestRoutes(ctx, path, method) {
  if (!siteTeamId(ctx.env)) return;
  const match =
    /^\/teams\/([^/]+)\/access-requests(?:\/([^/]+)\/(approve|reject))?$/.exec(
      path,
    );
  if (!match) return;
  const [, teamId, requestId, action] = match;
  assert(
    teamId === siteTeamId(ctx.env),
    403,
    "이 사이트의 팀만 관리할 수 있습니다.",
  );
  if (method === "POST") await refreshDirectory(ctx.env, { force: true });
  return controlTransaction(
    ctx.env,
    async (tx) => {
      const manager = await eligible(tx, teamId, ctx.user.id);
      assert(
        manager?.role === "lead",
        403,
        "현재 팀장만 계정 연결을 승인할 수 있습니다.",
      );
      if (method === "GET" && !requestId)
        return {
          requests: (
            await tx.query(
              "SELECT r.id,r.email,r.user_id AS \"userId\",u.name,u.username,r.status,r.created_at AS \"createdAt\" FROM access_requests r JOIN users u ON u.id=r.user_id WHERE r.status IN ('pending','approved') ORDER BY r.created_at DESC",
            )
          ).rows,
        };
      assert(
        method === "POST" && requestId && action,
        405,
        "지원하지 않는 요청입니다.",
      );
      const pending = (
        await tx.query("SELECT * FROM access_requests WHERE id=$1 FOR UPDATE", [
          requestId,
        ])
      ).rows[0];
      assert(pending, 404, "연결 신청을 찾을 수 없습니다.");
      if (action === "approve") {
        assert(
          pending.status !== "rejected",
          409,
          "거절된 신청입니다. 다시 연결을 신청하세요.",
        );
        assert(
          await eligible(tx, teamId, pending.user_id),
          409,
          "현재 팀에 소속된 활성 계정만 연결할 수 있습니다.",
        );
        await tx.query(
          "INSERT INTO access_identities VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [pending.issuer, pending.subject, pending.user_id],
        );
        const connected = (
          await tx.query(
            "SELECT 1 FROM access_identities WHERE issuer=$1 AND subject=$2 AND user_id=$3",
            [pending.issuer, pending.subject, pending.user_id],
          )
        ).rows.length;
        assert(connected, 409, "다른 Google 계정에 이미 연결되어 있습니다.");
      } else {
        const target = await eligible(tx, teamId, pending.user_id);
        if (target?.role === "lead" && pending.status === "approved") {
          const other = (
            await tx.query(
              "SELECT 1 FROM access_identities a JOIN users u ON u.id=a.user_id JOIN memberships m ON m.user_id=u.id WHERE m.team_id=$1 AND m.role='lead' AND u.active=TRUE AND u.id<>$2 LIMIT 1",
              [teamId, pending.user_id],
            )
          ).rows.length;
          assert(
            other,
            409,
            "다른 팀장의 계정을 먼저 연결한 뒤 마지막 팀장 연결을 해제하세요.",
          );
        }
        await tx.query(
          "DELETE FROM access_sessions WHERE issuer=$1 AND subject=$2 AND user_id=$3",
          [pending.issuer, pending.subject, pending.user_id],
        );
        await tx.query(
          "DELETE FROM access_identities WHERE issuer=$1 AND subject=$2 AND user_id=$3",
          [pending.issuer, pending.subject, pending.user_id],
        );
      }
      const status = action === "approve" ? "approved" : "rejected";
      await tx.query(
        "UPDATE access_requests SET status=$2,resolved_by=$3,resolved_at=$4 WHERE id=$1",
        [requestId, status, ctx.user.id, new Date().toISOString()],
      );
      await tx.query("INSERT INTO control_audit VALUES($1,$2,$3,$4,$5,$6)", [
        crypto.randomUUID(),
        ctx.user.id,
        "account-link-" + action,
        pending.user_id,
        JSON.stringify({ requestId, email: pending.email }),
        new Date().toISOString(),
      ]);
      return { ok: true, status };
    },
    { write: method === "POST" },
  );
}
