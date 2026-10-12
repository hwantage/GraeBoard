import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, UserMinus } from "lucide-react";
import Select from "./Select";
import ThemePicker from "./ThemePicker";
import { api, send, type ApiError } from "./api";
import { Avatar, Button, ErrorNote } from "./components";
import { getTheme } from "../shared/themes.js";
import type { Team, TeamRole, ThemeId, User } from "./types";

import { teamRoleNames, teamRoleOrder, teamRoleHelp } from "./roles";

type Notify = (message: string) => void;
type Member = { userId: string; role: TeamRole };
type UserSummary = Pick<
  User,
  | "id"
  | "username"
  | "name"
  | "active"
  | "color"
  | "avatarInitials"
  | "avatarImage"
>;

export function TeamGeneral({
  team,
  canDelete,
  onSaved,
  onDeleted,
  onMessage,
}: {
  team: Team;
  canDelete: boolean;
  onSaved: () => Promise<void>;
  onDeleted: () => Promise<void>;
  onMessage: Notify;
}) {
  const [name, setName] = useState(team.name),
    [theme, setTheme] = useState<ThemeId>(getTheme(team.settings.theme).id),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <ErrorNote error={error} />
      <form
        className="settings-section"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await send(
              `/teams/${team.id}`,
              {
                name,
                theme,
                settingsRevision: team.settings.revision || 0,
              },
              "PATCH",
            );
            await onSaved();
            onMessage("팀 정보를 저장했습니다.");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          팀 이름
          <input
            value={name}
            maxLength={80}
            required
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="settings-field">
          <span>팀 테마</span>
          <ThemePicker
            label={`${team.name} 테마`}
            value={theme}
            onChange={setTheme}
            disabled={busy}
          />
          <small>팀 메뉴·버튼·선택 강조에 적용됩니다.</small>
        </div>
        <footer className="form-actions">
          <Button
            type="submit"
            className="primary"
            disabled={busy || !name.trim()}
          >
            저장
          </Button>
        </footer>
      </form>
      {canDelete && (
        <section className="settings-danger" aria-label="팀 삭제">
          <div>
            <h4>팀 삭제</h4>
            <p>
              모든 연도의 업무·일정·스냅샷·보기·이력·설정을 영구 삭제합니다.
              사용자 계정과 다른 팀의 데이터는 유지됩니다.
            </p>
          </div>
          <Button
            className="danger"
            title={`${team.name} 팀 삭제`}
            disabled={busy}
            onClick={async () => {
              if (
                !confirm(
                  `“${team.name}” 팀을 정말 삭제하시겠습니까?\n\n이 팀의 모든 연도 업무·일정·셀 서식·속성·스냅샷·저장 보기·변경 이력·가져오기 기록 등 모든 팀 데이터가 영구 삭제됩니다. 삭제한 데이터는 복구할 수 없습니다.\n\n팀원 계정과 다른 팀의 데이터는 유지됩니다.`,
                )
              )
                return;
              setBusy(true);
              setError("");
              try {
                await send(
                  `/admin/teams/${team.id}`,
                  { confirmed: true },
                  "DELETE",
                );
                await onDeleted();
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            <Trash2 size={15} />팀 삭제
          </Button>
        </section>
      )}
    </>
  );
}

export function TeamMembers({
  team,
  user,
  onSaved,
  onMessage,
}: {
  team: Team;
  user: User;
  onSaved: () => Promise<void>;
  onMessage: Notify;
}) {
  const isAdmin = user.systemRole === "admin";
  const [members, setMembers] = useState<Member[] | null>(null),
    [people, setPeople] = useState<UserSummary[]>([]),
    [candidate, setCandidate] = useState(""),
    [candidateRole, setCandidateRole] = useState<TeamRole>("member"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function load() {
    const r = await api<{ members: Member[]; users: UserSummary[] }>(
      `/teams/${team.id}/members`,
    );
    setMembers(r.members);
    setPeople(r.users);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [team.id]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const rows = useMemo(
    () =>
      (members || [])
        .map((m) => ({ ...m, person: byId.get(m.userId) }))
        .sort(
          (a, b) =>
            teamRoleOrder.indexOf(a.role) - teamRoleOrder.indexOf(b.role) ||
            (a.person?.name || "").localeCompare(b.person?.name || "", "ko"),
        ),
    [members, byId],
  );
  const candidates = people.filter(
    (p) => p.active && !members?.some((m) => m.userId === p.id),
  );
  async function save(next: Member[], message: string) {
    // 팀장이 자기 권한을 내려놓으면 이 화면을 더 이상 관리할 수 없다.
    const mine = next.find((m) => m.userId === user.id)?.role;
    if (
      !isAdmin &&
      members?.some((m) => m.userId === user.id && m.role === "lead") &&
      mine !== "lead" &&
      !confirm(
        "내 팀장 권한을 해제하면 이 팀의 설정과 구성원을 더 이상 관리할 수 없습니다. 계속하시겠습니까?",
      )
    )
      return false;
    setBusy(true);
    setError("");
    try {
      const r = await send<{ members: Member[] }>(
        `/teams/${team.id}/members`,
        { members: next, previous: members },
        "PUT",
      );
      setMembers(r.members);
      onMessage(message);
      await onSaved();
      return true;
    } catch (e) {
      setError((e as Error).message);
      // 다른 사람이 먼저 바꿨으면 최신 목록을 다시 불러와 보여 준다.
      if ((e as ApiError).status === 409) await load();
      return false;
    } finally {
      setBusy(false);
    }
  }
  const count = (role: TeamRole) =>
    (members || []).filter((m) => m.role === role).length;
  return (
    <>
      <ErrorNote error={error} />
      <h4 className="list-heading" aria-live="polite">
        구성원 {members?.length ?? 0}명
        <span className="list-count">
          {teamRoleOrder
            .map((role) => ` · ${teamRoleNames[role]} ${count(role)}`)
            .join("")}
        </span>
      </h4>
      <form
        className="member-add"
        aria-label="구성원 추가"
        onSubmit={(e) => {
          e.preventDefault();
          if (!members || !candidate) return;
          const person = byId.get(candidate);
          save(
            [...members, { userId: candidate, role: candidateRole }],
            `${person?.name || "사용자"}님을 ${teamRoleNames[candidateRole]}(으)로 추가했습니다.`,
          ).then((ok) => ok && setCandidate(""));
        }}
      >
        <Select
          aria-label="추가할 사용자"
          value={candidate}
          disabled={busy || !members || !candidates.length}
          onChange={(e) => setCandidate(e.target.value)}
        >
          <option value="">
            {candidates.length
              ? "추가할 사용자 선택"
              : "추가할 수 있는 사용자가 없습니다"}
          </option>
          {candidates.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.username})
            </option>
          ))}
        </Select>
        <Select
          aria-label="추가할 사용자의 팀 내 권한"
          value={candidateRole}
          disabled={busy}
          onChange={(e) => setCandidateRole(e.target.value as TeamRole)}
        >
          {teamRoleOrder.map((role) => (
            <option key={role} value={role}>
              {teamRoleNames[role]}
            </option>
          ))}
        </Select>
        <Button type="submit" className="primary" disabled={busy || !candidate}>
          <Plus size={16} />
          추가
        </Button>
      </form>
      <p className="field-help">
        {isAdmin
          ? "새 계정은 시스템 › 사용자 계정에서 먼저 만든 뒤 여기서 팀에 추가합니다."
          : "새 계정이 필요하면 시스템 관리자에게 요청하세요."}{" "}
        담당자로는 팀장·팀원만 지정할 수 있습니다.
      </p>
      <dl className="role-legend" aria-label="팀 내 권한 안내">
        {teamRoleOrder.map((role) => (
          <div key={role}>
            <dt>{teamRoleNames[role]}</dt>
            <dd>{teamRoleHelp[role]}</dd>
          </div>
        ))}
      </dl>
      <div className="settings-table-scroll">
        <table className="settings-table team-members-table">
          <thead>
            <tr>
              <th>구성원</th>
              <th>팀 내 권한</th>
              <th>
                <span className="visually-hidden">관리</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ userId, role, person }) => {
              const name = person?.name || "알 수 없는 사용자";
              return (
                <tr key={userId}>
                  <td>
                    <div className="identity-cell">
                      <Avatar user={person} />
                      <span>
                        <strong>
                          {name}
                          {userId === user.id && (
                            <span className="me-badge">나</span>
                          )}
                        </strong>
                        <small>
                          {person?.username}
                          {person && !person.active ? " · 비활성" : ""}
                        </small>
                      </span>
                    </div>
                  </td>
                  <td>
                    <Select
                      aria-label={`${name} 팀 내 권한`}
                      value={role}
                      disabled={busy}
                      onChange={(e) => {
                        const next = e.target.value as TeamRole;
                        save(
                          members!.map((m) =>
                            m.userId === userId ? { ...m, role: next } : m,
                          ),
                          `${name}님의 권한을 ${teamRoleNames[next]}(으)로 변경했습니다.`,
                        );
                      }}
                    >
                      {teamRoleOrder.map((r) => (
                        <option key={r} value={r}>
                          {teamRoleNames[r]}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <Button
                      title={`${name} 팀에서 제외`}
                      disabled={busy}
                      onClick={() => {
                        if (
                          !confirm(
                            `${name}님을 ${team.name}에서 제외하시겠습니까?\n\n기존 업무의 담당자 표시는 유지되지만, 새로 담당자로 지정할 수는 없습니다.`,
                          )
                        )
                          return;
                        save(
                          members!.filter((m) => m.userId !== userId),
                          `${name}님을 팀에서 제외했습니다.`,
                        );
                      }}
                    >
                      <UserMinus size={15} />
                    </Button>
                  </td>
                </tr>
              );
            })}
            {members && !rows.length && (
              <tr>
                <td colSpan={3} className="table-empty">
                  아직 구성원이 없습니다. 위에서 사용자를 추가하세요.
                </td>
              </tr>
            )}
            {!members && !error && (
              <tr>
                <td colSpan={3} className="table-empty">
                  불러오는 중…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function NewTeam({
  teams,
  onCreated,
}: {
  teams: Team[];
  onCreated: (teamId: string) => Promise<void>;
}) {
  const [name, setName] = useState(""),
    [templateTeamId, setTemplateTeamId] = useState(""),
    [theme, setTheme] = useState<ThemeId>("mint"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <div className="settings-team-header">
        <div>
          <h3>새 팀 만들기</h3>
          <p>팀을 만든 뒤 구성원 탭에서 팀장·팀원·열람자를 추가합니다.</p>
        </div>
      </div>
      <ErrorNote error={error} />
      <form
        className="settings-section"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const created = await send<{ id: string }>("/admin/teams", {
              name,
              theme,
              ...(templateTeamId ? { templateTeamId } : {}),
            });
            await onCreated(created.id);
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      >
        <label>
          팀 이름
          <input
            aria-label="신규 팀 이름"
            value={name}
            maxLength={80}
            required
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          시작 양식
          <Select
            aria-label="새 팀 양식"
            value={templateTeamId}
            onChange={(e) => {
              setTemplateTeamId(e.target.value);
              setTheme(
                getTheme(
                  teams.find((t) => t.id === e.target.value)?.settings.theme,
                ).id,
              );
            }}
          >
            <option value="">기본 양식 · 작업·팀원·상태</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} 양식 복사
              </option>
            ))}
          </Select>
          <small className="field-help">
            양식 복사는 속성·선택값·순서·기본 서식·테마를 가져옵니다. 업무와
            구성원은 복사하지 않습니다.
          </small>
        </label>
        <div className="settings-field">
          <span>팀 테마</span>
          <ThemePicker
            label="신규 팀 테마"
            value={theme}
            onChange={setTheme}
            disabled={busy}
          />
        </div>
        <footer className="form-actions">
          <Button
            type="submit"
            className="primary"
            disabled={busy || !name.trim()}
          >
            팀 추가
          </Button>
        </footer>
      </form>
    </>
  );
}
