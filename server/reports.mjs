import { gzipSync, gunzipSync } from "node:zlib";
import { propertiesFor } from "../shared/domain.js";
import { stringify, parseCompact } from "../shared/compact.js";

// 보고서의 셀과 필터를 해석하는 데 필요한 이름만 보관한다.
// 프로필 이미지·색상·권한과 보고서에 등장하지 않는 팀원은 복사하지 않는다.
export function encodeReport({ tasks, users, view, settings }) {
  const memberKeys = new Set([
    "owner",
    "supporters",
    ...propertiesFor(settings, true)
      .filter((property) => property.kind === "member")
      .map((property) => property.id),
  ]);
  const referenced = new Set();
  const remember = (value) => {
    for (const id of Array.isArray(value) ? value : [value])
      if (id) referenced.add(id);
  };
  for (const task of tasks)
    for (const key of memberKeys) remember(task.cells[key]?.value);
  for (const key of memberKeys) remember(view.propertyFilters?.[key]);
  return gzipSync(
    stringify({
      tasks,
      users: users
        .filter((user) => referenced.has(user.id))
        .map(({ id, name }) => ({ id, name })),
      view,
      settings,
    }),
    // Keep large snapshots from holding the API thread in maximum compression.
    { level: 1 },
  );
}

export function decodeReport(data) {
  return parseCompact(gunzipSync(data).toString("utf8"));
}

// 저장 당시 이름은 보존하고, 스냅샷을 열 때 현재 아바타만 연결한다.
// 현재 팀에서 빠졌거나 원본 업무에서 제거된 팀원도 스냅샷의 ID로 조회한다.
export function reportUsersWithAvatars(db, users) {
  if (!users.length) return users;
  const profiles = new Map(
    db
      .prepare(
        "SELECT id,name,color,avatar_initials AS avatarInitials,avatar_image AS avatarImage FROM users WHERE id IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(users.map(({ id }) => id)))
      .map((profile) => [profile.id, profile]),
  );
  return users.map((user) => {
    const profile = profiles.get(user.id);
    return profile
      ? {
          ...user,
          color: profile.color,
          avatarInitials: profile.avatarInitials || profile.name.slice(0, 1),
          avatarImage: profile.avatarImage,
        }
      : user;
  });
}
