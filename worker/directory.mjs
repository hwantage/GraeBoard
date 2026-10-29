import {
  decodeDirectory,
  validateDirectory,
  DIRECTORY_MAX_BYTES,
} from "../server/sync/directory.mjs";
import { digest } from "../server/sync/protocol.mjs";
import { GitHubApiTransport } from "./git.mjs";
import { controlTransaction } from "./data.mjs";
import { profiles, siteTeamId } from "../shared/sync-profiles.js";
import { assert } from "./access.mjs";

export async function refreshDirectory(env, { force = false, transport } = {}) {
  const teamId = siteTeamId(env);
  if (!teamId) return;
  const profile = profiles(env)[0];
  assert(
    /^[a-f0-9-]{36}$/i.test(env.PEER_INSTALLATION_ID || ""),
    503,
    "사내 설치 식별자를 확인하세요.",
  );
  const previous = await controlTransaction(
    env,
    async (tx) =>
      (await tx.query("SELECT * FROM site_meta WHERE singleton=1")).rows[0],
  );
  if (
    !force &&
    previous.directory_head &&
    Date.now() - Number(previous.directory_checked_at) < 30000
  )
    return;
  transport ||= new GitHubApiTransport({
    repository: profile.repository,
    token: env[profile.githubSecret],
    maxBlobBytes: DIRECTORY_MAX_BYTES,
  });
  const head = await transport.readHead(
    "sync-directory/" + env.PEER_INSTALLATION_ID,
  );
  assert(head, 503, "사내 팀 동기화를 실행하여 구성원 정보를 먼저 게시하세요.");
  if (head === previous.directory_head) {
    await controlTransaction(env, (tx) =>
      tx.query(
        "UPDATE site_meta SET directory_checked_at=$1 WHERE singleton=1 AND directory_head=$2",
        [Date.now(), head],
      ),
    );
    return;
  }
  if (previous.directory_head)
    assert(
      await transport.verifyReachable(previous.directory_head, head),
      409,
      "팀 구성원 이력이 변경되었습니다. 연결을 확인하세요.",
    );
  const businessHead = await transport.readHead();
  assert(businessHead, 503, "사내 팀의 초기 게시를 먼저 완료하세요.");
  const manifestBytes = await transport.readFile(businessHead, "manifest.json");
  assert(
    manifestBytes && manifestBytes.byteLength <= 16384,
    503,
    "팀 저장소 신원을 확인하세요.",
  );
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  assert(
    manifest.teamId === teamId,
    409,
    "다른 팀의 구성원을 가져올 수 없습니다.",
  );
  const directory = decodeDirectory(
    await transport.readFile(head, "directory.json"),
    {
      teamId,
      installationId: env.PEER_INSTALLATION_ID,
      repoId: manifest.repoId,
    },
  );
  return applyDirectory(env, directory, {
    head,
    previousHead: previous.directory_head,
  });
}

async function applyDirectory(env, directory, { head, previousHead }) {
  validateDirectory(directory);
  const teamId = siteTeamId(env);
  assert(
    directory.teamId === teamId &&
      directory.installationId === env.PEER_INSTALLATION_ID,
    409,
    "구성원 정보의 팀과 사내 설치를 확인하세요.",
  );
  const profile = profiles(env)[0];
  return controlTransaction(
    env,
    async (tx) => {
      const meta = (
        await tx.query("SELECT * FROM site_meta WHERE singleton=1 FOR UPDATE")
      ).rows[0];
      // A slower fetch must never restore a membership that a newer fetch removed.
      if (meta.directory_head !== previousHead) return { changed: false };
      await tx.query(
        "INSERT INTO teams(id,name,profile_id) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",
        [teamId, profile.name, profile.profileId],
      );
      // Temporarily free unique email/login keys so renames and recycled addresses
      // can be applied atomically without merging different internal identities.
      await tx.query(
        "UPDATE users SET username='inactive-'||id||'@invalid.local',email='inactive-'||id||'@invalid.local',active=FALSE,system_role='user' WHERE source_managed=TRUE",
      );
      await tx.query("DELETE FROM memberships WHERE team_id=$1", [teamId]);
      for (const member of directory.members) {
        const email =
          member.email.trim().toLowerCase() ||
          `member-${member.id}@invalid.local`;
        await tx.query(
          "INSERT INTO users(id,username,email,name,system_role,active,created_at,source_managed) VALUES($1,$2,$2,$3,$4,$5,$6,TRUE) ON CONFLICT(id) DO UPDATE SET username=EXCLUDED.username,email=EXCLUDED.email,name=EXCLUDED.name,system_role=EXCLUDED.system_role,active=EXCLUDED.active,source_managed=TRUE",
          [
            member.id,
            email,
            member.name,
            member.role === "lead" && member.active ? "admin" : "user",
            member.active,
            new Date().toISOString(),
          ],
        );
        await tx.query(
          "INSERT INTO memberships(user_id,team_id,role) VALUES($1,$2,$3)",
          [member.id, teamId, member.role],
        );
      }
      await tx.query(
        "DELETE FROM access_sessions WHERE user_id IN (SELECT id FROM users WHERE NOT active)",
      );
      await tx.query(
        "DELETE FROM access_identities WHERE user_id IN (SELECT id FROM users WHERE NOT active)",
      );
      await tx.query(
        "UPDATE access_requests SET status='rejected',resolved_at=$1 WHERE status<>'rejected' AND user_id IN (SELECT id FROM users WHERE NOT active)",
        [new Date().toISOString()],
      );
      await tx.query(
        "UPDATE site_meta SET directory_head=$1,directory_hash=$2,directory_received_at=$3,directory_checked_at=$4 WHERE singleton=1",
        [head, digest(directory), new Date().toISOString(), Date.now()],
      );
      return { changed: true };
    },
    { write: true },
  );
}
