import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Plus, Users } from "lucide-react";
import type { Bootstrap, Team, TeamRole, User } from "./types";
import { canManageTeam, teamRole } from "../shared/domain.js";
import { themeVariables } from "../shared/themes.js";
import { api } from "./api";
import { Modal, ErrorNote } from "./components";
import DefaultStyleManager from "./DefaultStyleManager";
import PropertiesManager from "./PropertiesManager";
import { NewTeam, TeamGeneral, TeamMembers } from "./TeamSettings";
import UserAccounts from "./UserAccounts";
import { teamRoleNames } from "./roles";

const teamTabs = [
  ["general", "일반"],
  ["members", "구성원"],
  ["properties", "속성"],
  ["format", "기본 서식"],
] as const;
type TeamTab = (typeof teamTabs)[number][0];
type SettingsTarget =
  | { kind: "team"; id: string; tab: TeamTab }
  | { kind: "new-team" }
  | { kind: "users" };

// 설정은 왼쪽에서 대상(팀·시스템)을 고르고 오른쪽에서 그 대상만 편집한다.
// 팀을 고르면 오른쪽 전체가 그 팀의 설정이 되어 팀별로 관리한다는 맥락을 유지한다.
const manageableTeams = (user: User, teams: Team[]) =>
  teams.filter((t) => canManageTeam(user, t.id));
const firstTeam = (teams: Team[]): SettingsTarget | null =>
  teams[0] ? { kind: "team", id: teams[0].id, tab: "general" } : null;
export default function SettingsPanel({
  user,
  team,
  teams: allTeams,
  users: boardUsers,
  onClose,
  onRefresh,
  visibleFields,
  onVisibilitySaved,
}: {
  user: User;
  team: Team;
  // 보드가 이미 받아 둔 팀·사용자. 저장 뒤에는 onRefresh가 최신 값을 돌려준다.
  teams: Team[];
  users: User[];
  visibleFields: string[];
  onVisibilitySaved: (changes: Record<string, boolean>) => void;
  onClose: () => void;
  onRefresh: () => Promise<Bootstrap | void>;
}) {
  const isAdmin = user.systemRole === "admin";
  // 시스템 관리자는 팀에 속하지 않은 계정과 방금 생긴 팀까지 봐야 하므로
  // 열 때마다 전체 목록을 새로 받는다. 팀장은 보드가 받아 둔 값으로 충분하다.
  const [adminData, setAdminData] = useState<{
    users: User[];
    teams: Team[];
  } | null>(null);
  const teams = useMemo(
    () =>
      isAdmin
        ? (adminData?.teams ?? allTeams)
        : manageableTeams(user, allTeams),
    [isAdmin, adminData, user, allTeams],
  );
  const users = isAdmin ? (adminData?.users ?? []) : boardUsers;
  const [selection, setSelection] = useState<SettingsTarget>(
    () =>
      (canManageTeam(user, team.id)
        ? { kind: "team", id: team.id, tab: "general" }
        : firstTeam(teams)) || { kind: "users" },
  );
  const [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const loadAdminData = () =>
    isAdmin
      ? api("/admin/users").then((r) => {
          setAdminData(r);
          return r as { users: User[]; teams: Team[] };
        })
      : Promise.resolve(null);
  async function saved() {
    const [latest, admin] = await Promise.all([onRefresh(), loadAdminData()]);
    const next = admin
      ? admin.teams
      : latest
        ? manageableTeams(latest.user, latest.teams)
        : teams;
    // 팀이 삭제되었거나 내 팀장 권한이 해제되면 남은 팀으로 옮긴다.
    if (!isAdmin && !next.length) return onClose();
    setSelection((s) =>
      s.kind !== "team" || next.some((t) => t.id === s.id)
        ? s
        : firstTeam(next) || { kind: "users" },
    );
  }
  useEffect(() => {
    loadAdminData().catch((e) => setError(e.message));
  }, []);
  function select(next: SettingsTarget) {
    setSelection(next);
    setError("");
    setMessage("");
  }
  const selectedTeam =
    selection.kind === "team"
      ? teams.find((t) => t.id === selection.id)
      : undefined;
  return (
    <Modal title="설정" wide className="settings-modal" onClose={onClose}>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="설정 메뉴">
          <h3 id="settings-teams-heading">팀</h3>
          <ul aria-labelledby="settings-teams-heading">
            {teams.map((t) => {
              const role = teamRole(user, t.id) as TeamRole | null;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-current={
                      selection.kind === "team" && selection.id === t.id
                        ? "page"
                        : undefined
                    }
                    style={themeVariables(t.settings.theme) as CSSProperties}
                    onClick={() =>
                      select({
                        kind: "team",
                        id: t.id,
                        tab:
                          selection.kind === "team" ? selection.tab : "general",
                      })
                    }
                  >
                    <span className="settings-team-dot" aria-hidden="true" />
                    <span className="settings-nav-name">{t.name}</span>
                    {role && (
                      <small className="settings-role-badge">
                        {teamRoleNames[role]}
                      </small>
                    )}
                  </button>
                </li>
              );
            })}
            {isAdmin && (
              <li>
                <button
                  type="button"
                  className="settings-nav-add"
                  aria-current={
                    selection.kind === "new-team" ? "page" : undefined
                  }
                  onClick={() => select({ kind: "new-team" })}
                >
                  <Plus size={15} aria-hidden="true" />새 팀
                </button>
              </li>
            )}
          </ul>
          {isAdmin && (
            <>
              <h3 id="settings-system-heading">시스템</h3>
              <ul aria-labelledby="settings-system-heading">
                <li>
                  <button
                    type="button"
                    aria-current={
                      selection.kind === "users" ? "page" : undefined
                    }
                    onClick={() => select({ kind: "users" })}
                  >
                    <Users size={15} aria-hidden="true" />
                    <span className="settings-nav-name">사용자 계정</span>
                  </button>
                </li>
              </ul>
            </>
          )}
        </nav>
        <section className="settings-content">
          <ErrorNote error={error} />
          {message && (
            <p className="success-note" role="status">
              {message}
            </p>
          )}
          {selection.kind === "team" && selectedTeam && (
            <>
              <div
                className="settings-team-header"
                style={
                  themeVariables(selectedTeam.settings.theme) as CSSProperties
                }
              >
                <span className="settings-team-dot" aria-hidden="true" />
                <div>
                  <h3>{selectedTeam.name}</h3>
                  <p>
                    이 팀에만 적용되는 설정입니다
                    {selectedTeam.id === team.id ? " · 지금 보고 있는 팀" : ""}
                  </p>
                </div>
              </div>
              <div
                className="settings-tabs"
                role="tablist"
                aria-label={`${selectedTeam.name} 설정`}
              >
                {teamTabs.map(([key, label]) => (
                  <button
                    key={key}
                    id={`tab-${key}`}
                    role="tab"
                    aria-selected={selection.tab === key}
                    aria-controls={`panel-${key}`}
                    onClick={() => select({ ...selection, tab: key })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div
                role="tabpanel"
                id={`panel-${selection.tab}`}
                aria-labelledby={`tab-${selection.tab}`}
              >
                {selection.tab === "general" && (
                  <TeamGeneral
                    key={selectedTeam.id}
                    team={selectedTeam}
                    canDelete={isAdmin}
                    onSaved={saved}
                    onDeleted={async () => {
                      await saved();
                      setMessage(
                        `“${selectedTeam.name}” 팀과 모든 팀 데이터를 삭제했습니다.`,
                      );
                    }}
                    onMessage={setMessage}
                  />
                )}
                {selection.tab === "members" && (
                  <TeamMembers
                    key={selectedTeam.id}
                    team={selectedTeam}
                    user={user}
                    onSaved={saved}
                    onMessage={setMessage}
                  />
                )}
                {selection.tab === "properties" && (
                  <PropertiesManager
                    key={selectedTeam.id}
                    team={selectedTeam}
                    visibleFields={
                      selectedTeam.id === team.id ? visibleFields : undefined
                    }
                    onVisibilitySaved={
                      selectedTeam.id === team.id
                        ? onVisibilitySaved
                        : undefined
                    }
                    onSaved={saved}
                  />
                )}
                {selection.tab === "format" && (
                  <DefaultStyleManager
                    key={selectedTeam.id}
                    team={selectedTeam}
                    onSaved={saved}
                  />
                )}
              </div>
            </>
          )}
          {selection.kind === "team" && !selectedTeam && (
            <p className="field-help">
              {isAdmin
                ? "왼쪽에서 팀을 선택하거나 새 팀을 만드세요."
                : "관리할 수 있는 팀이 없습니다."}
            </p>
          )}
          {selection.kind === "new-team" && (
            <NewTeam
              teams={teams}
              onCreated={async (id) => {
                await saved();
                select({ kind: "team", id, tab: "members" });
                setMessage("팀을 만들었습니다. 구성원을 추가하세요.");
              }}
            />
          )}
          {selection.kind === "users" && (
            <UserAccounts
              users={users}
              teams={teams}
              onSaved={saved}
              onMessage={setMessage}
              onOpenTeam={(id) => select({ kind: "team", id, tab: "members" })}
            />
          )}
        </section>
      </div>
    </Modal>
  );
}
