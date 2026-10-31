import { useEffect, useState, type FormEvent } from "react";
import { ChevronRight, Search } from "lucide-react";
import LoadingState from "./LoadingState";
import { todayKey } from "../shared/domain.js";
import { api } from "./api";
import { Button, ErrorNote } from "./components";
import Select from "./Select";
import HistoryTime, { HistoryTimeline } from "./HistoryTime";
import { systemRoleNames, teamRoleNames } from "./roles";
import type { Team, User } from "./types";

const actions: Record<string, string> = {
  login: "로그인",
  logout: "로그아웃",
  "user-create": "사용자 생성",
  "user-update": "사용자·권한 변경",
  profile: "프로필 변경",
  password: "비밀번호 변경",
  "access-token-create": "접속 토큰 생성",
  "access-token-delete": "접속 토큰 삭제",
  "team-delete": "팀 삭제",
  "history-cleanup": "변경 이력 정리",
  "sync-reset": "동기화 연결 초기화",
};
const fields: Record<string, string> = {
  name: "이름",
  username: "이메일",
  systemRole: "시스템 권한",
  active: "계정 활성 상태",
  teamRoles: "팀별 권한",
  memberships: "팀 소속",
  color: "프로필 색상",
  avatarInitials: "프로필 글자",
  hasAvatarImage: "프로필 사진",
  changed: "변경 완료",
  scope: "정리 범위",
  beforeDate: "기준 날짜",
  cutoff: "이력 정리 기준 시각",
  operationCutoff: "재시도 기록 정리 기준 시각",
  deleted: "삭제 결과",
  audit: "변경 이력",
  operations: "저장 재시도 기록",
  count: "건수",
  bytes: "바이트",
  startedAt: "시작 시각",
  updatedAt: "완료·갱신 시각",
  completed: "정리 완료",
  id: "ID",
  prefix: "토큰 앞부분",
  createdAt: "생성 시각",
  expiresAt: "만료 시각",
  teamId: "팀",
  team: "팀",
  repository: "GitHub 저장소",
  publishedHead: "마지막 게시 커밋",
  role: "권한",
  value: "내용",
};
type Entry = {
  id: string;
  actorId: string;
  actor: string;
  actorUsername: string;
  action: string;
  target: string;
  targetName: string | null;
  targetUsername: string | null;
  createdAt: string;
};
type Detail = { before: unknown; after: unknown };
type Cursor = { createdAt: string; id: string };
type Result = { entries: Entry[]; nextCursor: Cursor | null };
type Filters = { from: string; to: string; actorId: string; action: string };
type Query = Filters & { cursor: Cursor | null };
function defaultFilters(): Filters {
  const today = todayKey();
  return { from: today, to: today, actorId: "", action: "" };
}
const record = (value: unknown): Record<string, unknown> =>
  value === null || value === undefined
    ? {}
    : typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };

function valueText(value: unknown, key: string, teams: Team[]): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean")
    return key === "active"
      ? value
        ? "활성"
        : "비활성"
      : value
        ? "예"
        : "아니요";
  if (key === "teamRoles" && typeof value === "object")
    return (
      Object.entries(value)
        .map(
          ([id, role]) =>
            `${teams.find((team) => team.id === id)?.name || id}: ${teamRoleNames[role as keyof typeof teamRoleNames] || role}`,
        )
        .join("\n") || "소속 없음"
    );
  if (Array.isArray(value))
    return value.map((item) => valueText(item, "", teams)).join("\n") || "없음";
  if (typeof value === "object")
    return (
      Object.entries(value)
        .map(
          ([field, item]) =>
            `${fields[field] || field}: ${valueText(item, field, teams)}`,
        )
        .join("\n") || "없음"
    );
  if (typeof value === "string") {
    if (key === "systemRole")
      return systemRoleNames[value as keyof typeof systemRoleNames] || value;
    if (key === "role")
      return teamRoleNames[value as keyof typeof teamRoleNames] || value;
    if (key === "teamId")
      return teams.find((team) => team.id === value)?.name || value;
    if (["cutoff", "operationCutoff", "startedAt", "updatedAt"].includes(key))
      return new Date(value).toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul",
      });
  }
  return String(value);
}

function AuditEntry({ entry, teams }: { entry: Entry; teams: Team[] }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || detail) return;
    const controller = new AbortController();
    setError("");
    api<Detail>(`/admin/audit/${entry.id}`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setDetail(result);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [open, detail, entry.id, attempt]);
  const before = record(detail?.before),
    after = record(detail?.after);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const target =
    entry.targetName ||
    (entry.action === "team-delete"
      ? "삭제된 팀"
      : entry.action === "sync-reset"
        ? "팀 외부 동기화"
        : "시스템 공통");
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="audit-icon" aria-hidden="true">
          <ChevronRight size={16} />
        </span>
        <span className="system-audit-summary">
          <strong>{actions[entry.action] || entry.action}</strong>
          <span>{target}</span>
          <small>
            수행자: {entry.actor} · {entry.actorUsername}
          </small>
        </span>
        <HistoryTime iso={entry.createdAt} timeZone="Asia/Seoul" />
      </summary>
      {open && (
        <div className="system-audit-detail">
          <p className="field-help">
            대상: {entry.targetUsername || entry.target} · 로그 ID: {entry.id}
          </p>
          <ErrorNote error={error} />
          {error && (
            <Button onClick={() => setAttempt((n) => n + 1)}>
              상세 다시 조회
            </Button>
          )}
          {!detail && !error && <p role="status">상세 내용을 불러오는 중…</p>}
          {detail &&
            (keys.length ? (
              <div className="system-audit-table-wrap">
                <table className="system-audit-table">
                  <caption>변경 전·후 상세</caption>
                  <thead>
                    <tr>
                      <th scope="col">항목</th>
                      <th scope="col">변경 전</th>
                      <th scope="col">변경 후</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((key) => (
                      <tr key={key}>
                        <th scope="row">{fields[key] || key}</th>
                        <td>{valueText(before[key], key, teams)}</td>
                        <td>{valueText(after[key], key, teams)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="field-help">
                이 기록에는 변경 전·후 상세가 저장되어 있지 않습니다.
              </p>
            ))}
        </div>
      )}
    </details>
  );
}

export default function SystemAuditLog({
  users,
  teams,
}: {
  users: User[];
  teams: Team[];
}) {
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [query, setQuery] = useState<Query>(() => ({
    ...filters,
    cursor: null,
  }));
  const [trail, setTrail] = useState<(Cursor | null)[]>([null]);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    for (const key of ["from", "to", "actorId", "action"] as const)
      if (query[key]) params.set(key, query[key]);
    if (query.cursor) {
      params.set("cursorAt", query.cursor.createdAt);
      params.set("cursorId", query.cursor.id);
    }
    setLoading(true);
    setError("");
    setResult(null);
    api<Result>(`/admin/audit?${params}`, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setResult(data);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query]);
  function search(e: FormEvent) {
    e.preventDefault();
    setTrail([null]);
    setQuery({ ...filters, cursor: null });
  }
  return (
    <section
      className="system-audit-log"
      aria-labelledby="system-audit-heading"
    >
      <div className="settings-team-header">
        <div>
          <h3 id="system-audit-heading">감사 로그</h3>
          <p>
            로그인·로그아웃, 계정·권한·프로필 변경, 팀 삭제와 이력 정리 등
            시스템 공통 기록을 확인합니다.
          </p>
        </div>
      </div>
      <form className="system-audit-filters" onSubmit={search}>
        <label>
          시작 날짜
          <input
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          />
        </label>
        <label>
          종료 날짜
          <input
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          />
        </label>
        <label>
          수행자
          <Select
            value={filters.actorId}
            onChange={(e) =>
              setFilters({ ...filters, actorId: e.target.value })
            }
          >
            <option value="">모든 사용자</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} ({user.username})
              </option>
            ))}
          </Select>
        </label>
        <label>
          작업 종류
          <Select
            value={filters.action}
            onChange={(e) => setFilters({ ...filters, action: e.target.value })}
          >
            <option value="">모든 작업</option>
            {Object.entries(actions).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
        </label>
        <div className="system-audit-filter-actions">
          <Button type="submit" className="primary">
            <Search size={15} />
            조회
          </Button>
          <Button
            onClick={() => {
              const defaults = defaultFilters();
              setFilters(defaults);
              setTrail([null]);
              setQuery({ ...defaults, cursor: null });
            }}
          >
            초기화
          </Button>
        </div>
      </form>
      <p className="field-help">
        한국 시간 기준이며 시작·종료 날짜를 모두 포함합니다. 기간을 비우면 보관
        중인 전체 기간을 조회합니다.
      </p>
      <ErrorNote error={error} />
      {loading && <LoadingState label="로그를 불러오는 중…" />}
      {result && (
        <>
          <p className="system-audit-count" role="status">
            {trail.length}페이지 · {result.entries.length}건 표시 · 최신순
            50건씩 조회
          </p>
          {result.entries.length ? (
            <HistoryTimeline>
              {result.entries.map((entry) => (
                <AuditEntry key={entry.id} entry={entry} teams={teams} />
              ))}
            </HistoryTimeline>
          ) : (
            <p className="field-help">조건에 맞는 감사 로그가 없습니다.</p>
          )}
        </>
      )}
      <div className="system-audit-pagination" aria-label="감사 로그 페이지">
        <Button
          disabled={loading || trail.length <= 1}
          onClick={() => {
            const previous = trail.slice(0, -1);
            setTrail(previous);
            setQuery({ ...query, cursor: previous.at(-1)! });
          }}
        >
          이전
        </Button>
        <Button
          disabled={loading || !result?.nextCursor}
          onClick={() => {
            if (!result?.nextCursor) return;
            setTrail([...trail, result.nextCursor]);
            setQuery({ ...query, cursor: result.nextCursor });
          }}
        >
          다음
        </Button>
      </div>
    </section>
  );
}
