import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { propertiesFor } from "../shared/domain.js";
import { stringify, parseCompact } from "../shared/compact.js";
import {
  normalizeReportName,
  DUPLICATE_REPORT_NAME,
} from "../shared/report-names.js";
import { requireThat, reportNameSchema } from "./validation.mjs";

// Call inside the insertion's BEGIN IMMEDIATE transaction so two writers cannot
// both claim a name. Compare stored names too, including decomposed Korean text.
export function requireUniqueReportName(db, teamId, name) {
  const normalized = reportNameSchema.parse(name);
  requireThat(
    !db
      .prepare("SELECT name FROM reports WHERE team_id=?")
      .all(teamId)
      .some((report) => normalizeReportName(report.name) === normalized),
    409,
    DUPLICATE_REPORT_NAME,
    { code: "DUPLICATE_REPORT_NAME" },
  );
  return normalized;
}

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

// Document access only needs row identity and tab metadata, never the cells.
// Key by the stored bytes so edits, restores and other writers invalidate it.
// The cache contains no bodies/cells and stays bounded even across many sheets.
const documentIndexes = new Map();
const MAX_DOCUMENT_INDEX_BYTES = 16 * 1024 * 1024;
let documentIndexBytes = 0;
export function reportDataKey(data) {
  return createHash("sha256").update(data).digest("hex");
}
export function reportDocumentIndex(data, decoded) {
  const key = reportDataKey(data);
  const cached = documentIndexes.get(key);
  if (cached) {
    documentIndexes.delete(key);
    documentIndexes.set(key, cached);
    return cached.tasks;
  }
  const tasks = new Map();
  let bytes = 128;
  for (const task of (decoded || decodeReport(data)).tasks) {
    const documents = task.documents || [];
    tasks.set(task.id, { id: task.id, updatedAt: task.updatedAt, documents });
    bytes +=
      256 + documents.reduce((n, doc) => n + 512 + doc.title.length * 2, 0);
  }
  if (bytes <= MAX_DOCUMENT_INDEX_BYTES) {
    while (documentIndexBytes + bytes > MAX_DOCUMENT_INDEX_BYTES) {
      const oldest = documentIndexes.keys().next().value;
      documentIndexBytes -= documentIndexes.get(oldest).bytes;
      documentIndexes.delete(oldest);
    }
    documentIndexes.set(key, { tasks, bytes });
    documentIndexBytes += bytes;
  }
  return tasks;
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
