import { controlTransaction } from "./data.mjs";
import { profiles, siteTeamId } from "./config.mjs";
import { GitHubApiTransport } from "./git.mjs";
import { assert } from "./access.mjs";
import {
  readSetupJson,
  validateSetupKeys,
  publishSetupJson,
  SETUP_KEY_MAX_BYTES,
} from "../server/sync/setup-keys.mjs";

function transportFor(env) {
  const profile = profiles(env)[0];
  return new GitHubApiTransport({
    repository: profile.repository,
    token: env[profile.githubSecret],
    maxBlobBytes: SETUP_KEY_MAX_BYTES,
  });
}
export async function refreshSetupKeys(
  env,
  { required = false, transport = transportFor(env) } = {},
) {
  const teamId = siteTeamId(env);
  if (!teamId) return;
  const previous = await controlTransaction(env, async (tx) => {
    if (tx.schemaVersion < 2) {
      assert(
        !required,
        503,
        "팀장 연결 키를 사용하려면 외부 DB 업데이트가 필요합니다.",
      );
      return undefined;
    }
    return (
      (
        await tx.query(
          "SELECT source_head FROM setup_key_state WHERE team_id=$1",
          [teamId],
        )
      ).rows[0]?.source_head || null
    );
  });
  if (previous === undefined) return;
  const head = await transport.readHead(
    "sync-setup/" + env.PEER_INSTALLATION_ID,
  );
  if (!head) {
    assert(
      !previous,
      409,
      "연결 키 이력이 삭제되었습니다. 내부 팀 설정을 확인하세요.",
    );
    return;
  }
  if (previous === head) return;
  if (previous)
    assert(
      await transport.verifyReachable(previous, head),
      409,
      "연결 키 이력이 변경되었습니다. 내부 팀 설정을 확인하세요.",
    );
  const businessHead = await transport.readHead();
  assert(businessHead, 409, "팀 초기 게시를 먼저 완료하세요.");
  const manifest = readSetupJson(
    await transport.readFile(businessHead, "manifest.json"),
  );
  assert(manifest.teamId === teamId, 409, "팀 저장소가 일치하지 않습니다.");
  const snapshot = validateSetupKeys(
    readSetupJson(await transport.readFile(head, "keys.json")),
    {
      teamId,
      installationId: env.PEER_INSTALLATION_ID,
      repoId: manifest.repoId,
    },
  );
  const received = new Date().toISOString();
  await controlTransaction(
    env,
    async (tx) => {
      const current =
        (
          await tx.query(
            "SELECT source_head FROM setup_key_state WHERE team_id=$1",
            [teamId],
          )
        ).rows[0]?.source_head || null;
      // Concurrent requests cannot reinstall an older snapshot.
      assert(
        current === previous,
        409,
        "연결 키가 갱신되었습니다. 다시 시도하세요.",
      );
      for (const key of snapshot.keys) {
        const old = (
          await tx.query("SELECT * FROM setup_link_keys WHERE id=$1", [key.id])
        ).rows[0];
        assert(
          !old ||
            (old.team_id === teamId &&
              old.user_id === key.userId &&
              old.token_hash === key.tokenHash &&
              old.issued_at === key.issuedAt &&
              old.expires_at === key.expiresAt),
          409,
          "연결 키 검증 정보가 변경되었습니다.",
        );
        await tx.query(
          `INSERT INTO setup_link_keys(id,team_id,user_id,token_hash,issued_at,expires_at,revoked_at,received_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET revoked_at=COALESCE(setup_link_keys.revoked_at,EXCLUDED.revoked_at)`,
          [
            key.id,
            teamId,
            key.userId,
            key.tokenHash,
            key.issuedAt,
            key.expiresAt,
            key.revokedAt,
            received,
          ],
        );
      }
      // Missing/replaced keys are permanently revoked; used_at is never imported.
      await tx.query(
        "UPDATE setup_link_keys SET revoked_at=COALESCE(revoked_at,$1) WHERE team_id=$2 AND NOT(id=ANY($3::text[]))",
        [received, teamId, snapshot.keys.map((k) => k.id)],
      );
      await tx.query(
        "INSERT INTO setup_key_state VALUES($1,$2,$3) ON CONFLICT(team_id) DO UPDATE SET source_head=EXCLUDED.source_head,received_at=EXCLUDED.received_at",
        [teamId, head, received],
      );
    },
    { write: true },
  );
}
export async function publishSetupReceipt(
  env,
  { transport = transportFor(env) } = {},
) {
  const teamId = siteTeamId(env);
  if (!teamId) return;
  const data = await controlTransaction(env, async (tx) => {
    if (tx.schemaVersion < 2) return;
    const state = (
      await tx.query("SELECT * FROM setup_key_state WHERE team_id=$1", [teamId])
    ).rows[0];
    if (!state) return;
    return { state };
  });
  if (!data) return;
  const businessHead = await transport.readHead();
  const manifest = readSetupJson(
    await transport.readFile(businessHead, "manifest.json"),
  );
  assert(manifest.teamId === teamId, 409, "팀 저장소가 일치하지 않습니다.");
  const snapshot = validateSetupKeys(
    readSetupJson(
      await transport.readFile(data.state.source_head, "keys.json"),
    ),
    {
      teamId,
      installationId: env.PEER_INSTALLATION_ID,
      repoId: manifest.repoId,
    },
  );
  // Only current opaque key IDs and timestamps leave this site, never Google identities.
  const keys = await controlTransaction(
    env,
    async (tx) =>
      (
        await tx.query(
          'SELECT id,used_at AS "usedAt" FROM setup_link_keys WHERE team_id=$1 AND id=ANY($2::text[]) ORDER BY id',
          [teamId, snapshot.keys.map((key) => key.id)],
        )
      ).rows,
  );
  await publishSetupJson(
    transport,
    "sync-setup-status/" + env.INSTALLATION_ID,
    "status.json",
    {
      format: "graeboard-setup-status",
      version: 1,
      teamId,
      installationId: env.INSTALLATION_ID,
      repoId: manifest.repoId,
      sourceHead: data.state.source_head,
      keys: keys.map((key) => ({ ...key, receivedAt: data.state.received_at })),
    },
  );
}
const checks = new Map();
export async function syncSetupKeyStatus(env, { force = false } = {}) {
  const id = `${env.APP_ORIGIN}:${env.INSTALLATION_ID}:${siteTeamId(env)}`;
  const prior = checks.get(id);
  if (prior?.running) {
    await prior.running;
    if (!force) return;
  }
  if (!force && prior?.checkedAt && Date.now() - prior.checkedAt < 30000)
    return;
  if (checks.size > 256) checks.clear();
  const check = {};
  checks.set(id, check);
  check.running = (async () => {
    await refreshSetupKeys(env);
    await publishSetupReceipt(env);
    check.checkedAt = Date.now();
  })();
  try {
    await check.running;
  } finally {
    check.running = null;
  }
}
