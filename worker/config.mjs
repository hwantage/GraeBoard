import { assert } from "./access.mjs";
export function profiles(env) {
  let parsed;
  try {
    parsed =
      typeof env.SYNC_PROFILES === "string"
        ? JSON.parse(env.SYNC_PROFILES)
        : env.SYNC_PROFILES || [];
  } catch {
    throw new Error("Invalid SYNC_PROFILES");
  }
  assert(
    Array.isArray(parsed) && parsed.length <= 50,
    503,
    "연결 프로필 설정을 확인하세요.",
  );
  const ids = new Set(),
    dbs = new Set(),
    buckets = new Set();
  const result = parsed.map((p) => {
    const repository = p.git?.repository || p.repository;
    const repo =
      typeof repository === "string"
        ? repository
            .replace(/^https:\/\/github\.com\//, "")
            .replace(/\.git$/, "")
        : repository && `${repository.owner}/${repository.name}`;
    const v = {
      profileId: p.profileId,
      name: p.name || p.profileId,
      teamId: p.teamId,
      databaseBinding: p.database?.binding || p.databaseBinding,
      bucketBinding: p.images?.binding || p.bucketBinding,
      githubSecret: p.git?.tokenSecret || p.githubSecret,
      repository: repo,
      ...(p.replaces ? { replaces: p.replaces } : {}),
    };
    assert(
      /^[a-zA-Z0-9_-]{1,80}$/.test(v.profileId) &&
        /^[a-f0-9-]{36}$/i.test(v.teamId) &&
        /^[\w.-]+\/[\w.-]+$/.test(repo) &&
        !repo.includes(".."),
      503,
      "연결 프로필 식별자가 올바르지 않습니다.",
    );
    for (const binding of [v.databaseBinding, v.bucketBinding, v.githubSecret])
      assert(
        /^[A-Z][A-Z0-9_]{1,80}$/.test(binding),
        503,
        "연결 binding을 확인하세요.",
      );
    for (const [set, val] of [
      [ids, v.profileId],
      [dbs, v.databaseBinding],
      [buckets, v.bucketBinding],
    ]) {
      assert(
        !set.has(val),
        503,
        "서로 다른 팀의 자원을 중복 지정할 수 없습니다.",
      );
      set.add(val);
    }
    assert(
      v.databaseBinding !== "PG_CONTROL",
      503,
      "관리 DB를 팀 업무 DB로 사용할 수 없습니다.",
    );
    return v;
  });
  for (const p of result) {
    const ancestor =
      p.replaces && result.find((q) => q.profileId === p.replaces);
    if (p.replaces)
      assert(
        ancestor &&
          ancestor.teamId === p.teamId &&
          ancestor.repository.toLowerCase() === p.repository.toLowerCase() &&
          ancestor.profileId !== p.profileId,
        503,
        "교체 프로필은 같은 팀과 저장소의 기존 프로필을 지정해야 합니다.",
      );
    for (const q of result)
      if (q !== p) {
        assert(
          p.teamId !== q.teamId ||
            p.replaces === q.profileId ||
            q.replaces === p.profileId,
          503,
          "같은 팀은 명시적인 교체 프로필만 추가할 수 있습니다.",
        );
        assert(
          p.repository.toLowerCase() !== q.repository.toLowerCase() ||
            p.teamId === q.teamId,
          503,
          "다른 팀은 저장소를 공유할 수 없습니다.",
        );
      }
  }
  return result;
}
export function profileFor(env, id, teamId) {
  const p = profiles(env).find(
    (p) => p.profileId === id && p.teamId === teamId,
  );
  assert(p, 503, "설치된 팀 연결 프로필을 선택하세요.");
  assert(
    env[p.databaseBinding]?.connectionString &&
      env[p.bucketBinding] &&
      typeof env[p.githubSecret] === "string",
    503,
    "팀 자원 binding 또는 Secret을 확인하세요.",
  );
  return p;
}
