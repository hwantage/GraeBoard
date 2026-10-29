import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { parseEnv } from "node:util";
import { requireThat } from "../../shared/validation.js";
import { repositoryUrl } from "./git-cli.mjs";
import { validateSyncProfiles } from "./profiles.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const revision = (text) => createHash("sha256").update(text).digest("hex");
const keys = [
  "GRAEBOARD_INSTALLATION_ID",
  "GRAEBOARD_SYNC_PROFILES",
  "GRAEBOARD_SYNC_KEY",
  "GRAEBOARD_SYNC_KEY_ID",
];

// Keep the existing dotenv format, comments and unrelated settings. Managed keys
// are rewritten in place (keeping an `export` prefix and the file's line endings)
// and only appended when absent. Refuse complex assignments rather than risk
// rewriting an operator-managed multiline value.
export function patchSyncEnv(text, values) {
  const parsed = parseEnv(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  while (lines.length && lines.at(-1) === "") lines.pop();
  for (const [key, value] of Object.entries(values)) {
    requireThat(keys.includes(key), 400, "지원하지 않는 설치 설정입니다.");
    const pattern = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
    const indexes = lines.flatMap((line, index) =>
      pattern.test(line) ? [index] : [],
    );
    requireThat(
      indexes.length <= 1 &&
        (!indexes.length || parseEnv(lines[indexes[0]])[key] === parsed[key]),
      409,
      "여러 줄 또는 중복된 동기화 환경 설정은 서버 관리자가 먼저 정리해야 합니다.",
    );
    const encoded =
      key === "GRAEBOARD_SYNC_PROFILES"
        ? value.replaceAll("'", "\\u0027")
        : value;
    requireThat(
      !/[\r\n']/.test(encoded),
      400,
      "설정 값에 지원하지 않는 문자가 있습니다.",
    );
    const assignment = `${key}='${encoded}'`;
    if (indexes.length) {
      const exported = pattern.exec(lines[indexes[0]])[1] ? "export " : "";
      lines[indexes[0]] = exported + assignment;
    } else lines.push(assignment);
  }
  return lines.join(eol) + eol;
}

export function createSyncSetupConfig({ db, sync, path, env = process.env }) {
  // Values this process loaded from the file at startup plus values it applied
  // later. A service environment that overrides the file differs from these,
  // whereas the service's own earlier saves must not look like an override.
  const loaded = {};
  try {
    if (path && existsSync(path) && lstatSync(path).isFile())
      Object.assign(loaded, parseEnv(readFileSync(path, "utf8")));
  } catch {
    // A broken file is reported by read() when the setup UI is used.
  }
  function read() {
    requireThat(
      path,
      409,
      "이 실행 환경에서는 설정 파일을 관리할 수 없습니다. 서버 관리자가 환경 설정을 등록하세요.",
    );
    if (existsSync(path))
      requireThat(
        lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
        409,
        "환경 파일이 일반 파일인지 서버 관리자에게 확인하세요.",
      );
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const file = parseEnv(text);
    let profiles;
    try {
      profiles = JSON.parse(file.GRAEBOARD_SYNC_PROFILES || "[]");
    } catch {
      requireThat(false, 409, "환경 파일의 동기화 프로필 JSON을 확인하세요.");
    }
    requireThat(
      Array.isArray(profiles),
      409,
      "환경 파일의 동기화 프로필 배열을 확인하세요.",
    );
    requireThat(
      profiles.every(
        (profile) =>
          profile &&
          typeof profile.teamId === "string" &&
          typeof profile.profileId === "string" &&
          typeof profile.repository === "string",
      ),
      409,
      "기존 프로필의 식별 정보와 저장소를 확인하세요.",
    );
    return { text, file, profiles };
  }
  function status(teamId) {
    const { text, file, profiles } = read();
    const linkedProfile = sync.store(teamId).readLink()?.profile_id;
    const matches = (p) =>
      p.teamId === teamId &&
      (linkedProfile ? p.profileId === linkedProfile : !p.replaces);
    const installed = sync.profiles.find(matches);
    const staged = profiles.find(matches);
    const profile = installed || staged;
    return {
      revision: revision(text),
      installationId:
        sync.installationId || file.GRAEBOARD_INSTALLATION_ID || "",
      profile: profile
        ? {
            profileId: profile.profileId,
            repository: profile.repository,
            peerInstallationId: profile.peerInstallationId || "",
          }
        : null,
      installed: !!installed,
      // Only the first installation identity (no installation ID loaded by this
      // process) still needs a restart; later profiles apply immediately.
      restartRequired:
        !!staged &&
        (!installed || !sync.installationId || !env.GRAEBOARD_SYNC_KEY),
      credentialReady:
        Buffer.from(env.GRAEBOARD_SYNC_KEY || "", "base64").length === 32,
      credentialStored:
        !!profile &&
        !!db
          .prepare("SELECT 1 FROM sync_credentials WHERE profile_id=?")
          .get(profile.profileId),
    };
  }
  function save(teamId, input) {
    const { text, file, profiles } = read();
    requireThat(
      input.expectedRevision === revision(text),
      409,
      "서버 설정이 변경되었습니다. 설정을 다시 불러온 뒤 저장하세요.",
    );
    // Externally supplied variables take precedence over --env-file. Never claim
    // that editing a shadowed file will configure a service managed by PM2/etc.
    for (const key of keys)
      requireThat(
        !env[key] || env[key] === loaded[key],
        409,
        "서비스 환경 변수가 우선 적용 중입니다. 서버 관리자가 같은 값을 .env로 통합한 뒤 다시 저장하세요.",
      );
    // A profile with connection history keeps its repository and identity; an
    // installed profile that never connected may still be corrected.
    requireThat(
      !db.prepare("SELECT 1 FROM team_sync_links WHERE team_id=?").get(teamId),
      409,
      "연결 이력이 있는 팀입니다. 기존 프로필을 복원한 뒤 다시 연결하세요.",
    );
    const running = sync.profiles.filter((p) => p.teamId === teamId);
    const installed = running.find((p) => !p.replaces);
    requireThat(
      running.length === (installed ? 1 : 0) &&
        (!installed || uuid.test(installed.peerInstallationId || "")),
      409,
      "기존 프로필 신원은 서버 관리자에게 확인하세요.",
    );
    const staged = profiles.find((p) => p.teamId === teamId);
    requireThat(
      !staged ||
        (!staged.replaces &&
          profiles.filter((p) => p.teamId === teamId).length === 1 &&
          uuid.test(staged.peerInstallationId || "")),
      409,
      "기존 프로필 신원은 서버 관리자에게 확인하세요.",
    );
    requireThat(
      !installed ||
        !staged ||
        (installed.profileId === staged.profileId &&
          installed.peerInstallationId === staged.peerInstallationId),
      409,
      "실행 중인 프로필과 환경 파일의 프로필이 다릅니다. 서버 관리자가 환경 파일을 확인하세요.",
    );
    const repository =
      typeof input.repository === "string"
        ? input.repository.trim().replace(/\.git$/, "")
        : "";
    requireThat(
      /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(
        repository,
      ),
      400,
      "GitHub 저장소 주소를 https://github.com/소유자/저장소 형식으로 입력하세요.",
    );
    requireThat(
      ![".", ".."].includes(repository.split("/").at(-1)),
      400,
      "GitHub 저장소 이름을 확인하세요.",
    );
    const otherTeam = (p) => p.teamId !== teamId;
    const canonical = (value) => {
      try {
        return repositoryUrl(value).toLowerCase();
      } catch {
        return null;
      }
    };
    requireThat(
      ![...profiles, ...sync.profiles].some(
        (p) =>
          otherTeam(p) && canonical(p.repository) === repository.toLowerCase(),
      ),
      409,
      "다른 팀에서 사용하는 저장소입니다.",
    );
    const existing = staged || installed;
    const profileId = existing?.profileId || `team-${teamId}`;
    requireThat(
      ![...profiles, ...sync.profiles].some(
        (p) => otherTeam(p) && p.profileId === profileId,
      ),
      409,
      "이미 사용 중인 프로필 ID입니다.",
    );
    const installationId =
      file.GRAEBOARD_INSTALLATION_ID || sync.installationId || randomUUID();
    requireThat(
      uuid.test(installationId),
      409,
      "기존 내부 설치 UUID를 서버 관리자에게 확인하세요.",
    );
    requireThat(
      !db
        .prepare(
          "SELECT 1 FROM team_sync_links WHERE installation_id<>? LIMIT 1",
        )
        .get(installationId),
      409,
      "기존 연결의 설치 UUID와 다릅니다. 원래 설치 설정을 복원하세요.",
    );
    requireThat(
      file.GRAEBOARD_SYNC_KEY ||
        !db.prepare("SELECT 1 FROM sync_credentials LIMIT 1").get(),
      409,
      "기존 암호화 키가 없습니다. 키를 복원한 뒤 다시 저장하세요.",
    );
    const key = file.GRAEBOARD_SYNC_KEY || randomBytes(32).toString("base64");
    requireThat(
      Buffer.from(key, "base64").length === 32,
      409,
      "기존 동기화 암호화 키를 확인하세요.",
    );
    const keyId = file.GRAEBOARD_SYNC_KEY_ID || "default";
    const profile = existing
      ? { ...existing, repository }
      : { profileId, teamId, repository, peerInstallationId: randomUUID() };
    const nextProfiles = staged
      ? profiles.map((p) => (p === staged ? profile : p))
      : [...profiles, profile];
    // The running service applies the profile only when it already carries the
    // same installation identity; the first identity is loaded by a restart.
    const applicable =
      !!sync.installationId && sync.installationId === installationId;
    try {
      validateSyncProfiles(nextProfiles);
      if (applicable) sync.apply(profile, { dryRun: true });
    } catch (error) {
      requireThat(
        false,
        409,
        `프로필 구성을 적용할 수 없습니다. 서버 관리자가 환경 파일의 프로필 목록을 확인하세요. (${error.message})`,
      );
    }
    const next = patchSyncEnv(text, {
      GRAEBOARD_INSTALLATION_ID: installationId,
      GRAEBOARD_SYNC_PROFILES: JSON.stringify(nextProfiles),
      GRAEBOARD_SYNC_KEY: key,
      ...(!file.GRAEBOARD_SYNC_KEY_ID ? { GRAEBOARD_SYNC_KEY_ID: keyId } : {}),
    });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, next, { mode: 0o600, flag: "wx" });
      requireThat(
        (existsSync(path) ? readFileSync(path, "utf8") : "") === text,
        409,
        "설정 파일이 변경되었습니다. 다시 불러오세요.",
      );
      renameSync(temporary, path);
    } catch (error) {
      requireThat(
        !error.code,
        409,
        "환경 파일을 쓸 수 없습니다. 서버 관리자가 파일·폴더 권한을 확인하세요.",
      );
      throw error;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    if (applicable) {
      sync.apply(profile);
      for (const [name, value] of [
        ["GRAEBOARD_SYNC_KEY", key],
        ["GRAEBOARD_SYNC_KEY_ID", keyId],
      ])
        if (!env[name]) {
          env[name] = value;
          loaded[name] = value;
        }
    }
    return status(teamId);
  }
  return { status, save };
}
