import { useSite } from "./site-context";
import { Fragment, useEffect, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import Select from "./Select";
import AvatarEditor from "./AvatarEditor";
import { send } from "./api";
import { Avatar, Button, ErrorNote } from "./components";
import { systemRoleNames, teamRoleNames } from "./roles";
import type { Team, User } from "./types";

export default function UserAccounts({
  users,
  teams,
  onSaved,
  onOpenTeam,
  onMessage,
}: {
  users: User[];
  teams: Team[];
  onSaved: () => Promise<void>;
  onOpenTeam: (teamId: string) => void;
  onMessage: (message: string) => void;
}) {
  const site = useSite();
  // 수정 폼은 누른 사용자 바로 아래에 펼친다. 신규 사용자만 목록 위에 연다.
  const [edit, setEdit] = useState<Partial<User> | null>(null),
    [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = users.filter(
    (u) =>
      !needle ||
      u.name.toLowerCase().includes(needle) ||
      u.username.toLowerCase().includes(needle),
  );
  const form = edit && (
    <UserForm
      key={edit.id || "new"}
      initial={edit}
      onCancel={() => setEdit(null)}
      onSaved={async (created) => {
        setEdit(null);
        await onSaved();
        onMessage(
          created
            ? "사용자를 추가했습니다. 팀 설정의 구성원 탭에서 팀에 추가하세요."
            : "사용자 정보를 저장했습니다.",
        );
      }}
    />
  );
  return (
    <>
      <div className="settings-team-header">
        <div>
          <h3>사용자 계정</h3>
          <p>
            {site.accountLinking
              ? "사내에서 동기화한 팀 계정입니다. Google 계정 연결은 팀의 구성원 탭에서 승인합니다."
              : "로그인 계정과 시스템 권한을 관리합니다. 팀 소속과 팀 내 권한은 각 팀의 구성원 탭에서 정합니다."}
          </p>
        </div>
      </div>
      <div className="user-toolbar">
        <label className="user-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="사용자 검색"
            placeholder="이름 또는 아이디(이메일) 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="list-count" aria-live="polite">
          {needle ? `${shown.length}명 / ` : ""}전체 {users.length}명
        </span>
        {!site.accountLinking && (
          <Button
            aria-expanded={!!edit && !edit.id}
            onClick={() => setEdit({ systemRole: "user", active: true })}
          >
            <Plus size={16} />
            사용자 추가
          </Button>
        )}
      </div>
      {edit && !edit.id && form}
      <div className="settings-table-scroll">
        <table className="settings-table users-table">
          <thead>
            <tr>
              <th>사용자 / 아이디(이메일)</th>
              <th>소속 팀 · 팀 내 권한</th>
              <th>시스템 권한</th>
              <th>상태</th>
              <th>
                <span className="visually-hidden">관리</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((u) => {
              const editing = edit?.id === u.id;
              return (
                <Fragment key={u.id}>
                  <tr className={editing ? "editing" : undefined}>
                    <td>
                      <div className="identity-cell">
                        <Avatar user={u} />
                        <span>
                          <strong>{u.name}</strong>
                          <small>{u.username}</small>
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="team-chips">
                        {u.teamIds.length ? (
                          teams
                            .filter((t) => u.teamIds.includes(t.id))
                            .map((t) => (
                              <button
                                type="button"
                                className="tag"
                                key={t.id}
                                title={`${t.name} 구성원 설정 열기`}
                                onClick={() => onOpenTeam(t.id)}
                              >
                                {t.name} · {teamRoleNames[u.teamRoles[t.id]]}
                              </button>
                            ))
                        ) : (
                          <span className="muted">소속 없음</span>
                        )}
                      </div>
                    </td>
                    <td>
                      {site.accountLinking && u.systemRole === "admin"
                        ? "팀 사이트 관리자"
                        : systemRoleNames[u.systemRole]}
                    </td>
                    <td>
                      <span
                        className={`status-pill ${u.active ? "" : "inactive"}`}
                      >
                        {u.active ? "활성" : "비활성"}
                      </span>
                    </td>
                    <td>
                      {!site.accountLinking && (
                        <Button
                          title={`${u.name} 사용자 수정`}
                          aria-expanded={editing}
                          active={editing}
                          onClick={() => setEdit(editing ? null : u)}
                        >
                          {editing ? "닫기" : "수정"}
                        </Button>
                      )}
                    </td>
                  </tr>
                  {editing && (
                    <tr className="user-edit-row">
                      <td colSpan={5}>{form}</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!shown.length && (
              <tr>
                <td colSpan={5} className="table-empty">
                  {needle
                    ? "검색 결과가 없습니다."
                    : "등록된 사용자가 없습니다."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function UserForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: Partial<User>;
  onCancel: () => void;
  onSaved: (created: boolean) => Promise<void>;
}) {
  const [profile, setProfile] = useState(initial),
    [busy, setBusy] = useState(false),
    [avatarLoading, setAvatarLoading] = useState(false),
    [error, setError] = useState(""),
    [active, setActive] = useState(initial.active ?? true);
  const ref = useRef<HTMLFormElement>(null);
  const site = useSite();
  const editing = !!initial.id;
  // 이메일 형식이 아닌 기존 아이디는 비워 두면 그대로 유지한다.
  const legacyId = editing && !initial.username?.includes("@");
  useEffect(() => {
    // 목록 아래쪽 사용자를 눌러도 폼이 열린 것을 바로 알 수 있게 한다.
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    ref.current
      ?.querySelector<HTMLInputElement>("input[name=displayName]")
      ?.focus({
        preventScroll: true,
      });
  }, []);
  return (
    // 관리자가 다른 사람의 계정을 편집하는 폼이다. 브라우저가 가입 폼으로 보고
    // 이메일 별명·비밀번호 생성·키체인 저장을 제안하지 않도록 자동 완성을 끈다.
    <form
      ref={ref}
      autoComplete="off"
      className="settings-form"
      aria-label={editing ? `${initial.name} 사용자 수정` : "신규 사용자"}
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        setBusy(true);
        const f = new FormData(e.currentTarget);
        try {
          // 팀 소속과 팀 내 권한은 각 팀의 구성원 탭에서 관리한다.
          const loginId = String(f.get("loginId") || "").trim();
          await send(
            editing ? `/admin/users/${initial.id}` : "/admin/users",
            {
              name: f.get("displayName"),
              // 바꾼 경우에만 보내 기존 아이디를 건드리지 않는다.
              username:
                loginId && loginId !== initial.username ? loginId : undefined,
              password: site.external
                ? undefined
                : String(f.get("initialPassword") || "") || undefined,
              systemRole: f.get("systemRole"),
              active,
              color: profile.color,
              avatarInitials: profile.avatarInitials,
              avatarImage: profile.avatarImage,
            },
            editing ? "PATCH" : "POST",
          );
          await onSaved(!editing);
        } catch (e) {
          setError((e as Error).message);
          setBusy(false);
        }
      }}
    >
      <div className="settings-form-heading">
        <h3>{editing ? `${initial.name} 수정` : "신규 사용자"}</h3>
        {/* 계정 상태는 폼 전체에 해당하므로 제목 옆에 둔다. */}
        <label className="switch-field">
          <span>계정 상태</span>
          <input
            type="checkbox"
            role="switch"
            aria-label="계정 활성화"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          <span className="switch-track" aria-hidden="true" />
          <strong className={active ? "" : "muted"}>
            {active ? "활성" : "비활성"}
          </strong>
        </label>
      </div>
      {editing && !active && initial.active && (
        <p className="field-hint switch-warning" role="status">
          저장하면 이 사용자는 로그인할 수 없고 현재 로그인도 해제됩니다. 기존
          업무와 팀 소속은 유지됩니다.
        </p>
      )}
      <ErrorNote error={error} />
      <div className="form-grid">
        <label>
          이름
          <input
            name="displayName"
            autoComplete="off"
            defaultValue={initial.name}
            onChange={(e) =>
              setProfile((u) => ({ ...u, name: e.target.value }))
            }
            maxLength={50}
            required
          />
        </label>
        <label>
          아이디(이메일)
          <input
            type="email"
            name="loginId"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            defaultValue={legacyId ? "" : initial.username}
            placeholder={legacyId ? initial.username : "name@company.com"}
            maxLength={254}
            required={!legacyId}
          />
          {legacyId && (
            <small className="field-hint">
              이메일 이전의 아이디입니다. 이메일을 입력하면 그 주소로
              로그인합니다.
            </small>
          )}
        </label>
        {!site.external && (
          <label>
            {editing ? "비밀번호 재설정 (비워두면 유지)" : "초기 비밀번호"}
            <input
              type="password"
              name="initialPassword"
              required={!editing}
              minLength={10}
              maxLength={128}
              autoComplete="off"
            />
          </label>
        )}
        <label>
          시스템 권한
          <Select name="systemRole" defaultValue={initial.systemRole}>
            {Object.entries(systemRoleNames).map(([key, name]) => (
              <option value={key} key={key}>
                {name}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <p className="field-help">
        시스템 관리자는 소속과 관계없이 모든 팀과 계정을 관리합니다. 담당자로
        지정되려면 해당 팀의 구성원이어야 합니다.
      </p>
      <AvatarEditor
        user={profile}
        onChange={(patch) => setProfile((u) => ({ ...u, ...patch }))}
        onLoading={setAvatarLoading}
      />
      <footer className="form-actions">
        <Button onClick={onCancel}>취소</Button>
        <Button
          type="submit"
          className="primary"
          disabled={busy || avatarLoading}
        >
          사용자 저장
        </Button>
      </footer>
    </form>
  );
}
