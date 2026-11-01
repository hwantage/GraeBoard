import { useSite } from "./site-context";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Plus, Users, History, ScrollText, Plug } from "lucide-react";
import type { Bootstrap, Team, TeamRole, User } from "./types";
import { canManageTeam, teamRole } from "../shared/domain.js";
import { themeVariables } from "../shared/themes.js";
import { api } from "./api";
import { Modal, ErrorNote } from "./components";
import Toast, { useToast } from "./Toast";
import DefaultStyleManager from "./DefaultStyleManager";
import PropertiesManager from "./PropertiesManager";
import { NewTeam, TeamGeneral, TeamMembers } from "./TeamSettings";
import UserAccounts from "./UserAccounts";
import HistoryCleanup from "./HistoryCleanup";
import SystemAuditLog from "./SystemAuditLog";
import { teamRoleNames } from "./roles";
import TeamSyncSettings from "./TeamSyncSettings";
import ServiceConnections from "./ServiceConnections";
import SiteMaintenance from "./SiteMaintenance";

const teamTabs = [
  ["general", "일반"],
  ["members", "구성원"],
  ["properties", "속성"],
  ["format", "기본 서식"],
  ["sync", "외부 동기화"],
] as const;
type TeamTab = (typeof teamTabs)[number][0];
type SettingsTarget =
  | { kind: "team"; id: string; tab: TeamTab }
  | { kind: "new-team" }
  | { kind: "history-cleanup" }
  | { kind: "service-connections" }
  | { kind: "audit" }
  | { kind: "users" };

// GitHub 로고(Octicons mark-github, MIT).
const GITHUB_MARK =
  "M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z";
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
}: {
  user: User;
  team?: Team;
  // 보드가 이미 받아 둔 팀·사용자. 저장 뒤에는 onRefresh가 최신 값을 돌려준다.
  teams: Team[];
  users: User[];
  onClose: () => void;
  onRefresh: () => Promise<Bootstrap | void>;
}) {
  const site = useSite();
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
      (team && canManageTeam(user, team.id)
        ? { kind: "team", id: team.id, tab: "general" }
        : firstTeam(teams)) || {
        kind: site.external ? "service-connections" : "users",
      },
  );
  const [error, setError] = useState("");
  const [cleanupTab, setCleanupTab] = useState<"history" | "site">("history");
  const [message, setMessage] = useToast();
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
  useEffect(() => {
    // Bootstrap refreshes also arrive through another tab's team changes.
    // Preserve the admin-only teams while updating shared connection signals.
    setAdminData((current) => {
      if (!current) return current;
      let changed = false;
      const teams = current.teams.map((item) => {
        const latest = allTeams.find((candidate) => candidate.id === item.id);
        if (
          !latest ||
          (item.sync?.available === latest.sync?.available &&
            item.sync?.configured === latest.sync?.configured)
        )
          return item;
        changed = true;
        return { ...item, sync: latest.sync };
      });
      return changed ? { ...current, teams } : current;
    });
  }, [allTeams]);
  function select(next: SettingsTarget) {
    setSelection(next);
    setError("");
    setMessage("");
  }
  const selectedTeam =
    selection.kind === "team"
      ? teams.find((t) => t.id === selection.id)
      : undefined;
  const selectedTab = selection.kind === "team" ? selection.tab : null;
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
                          selection.kind === "team" &&
                          (selection.tab !== "sync" || t.sync?.available)
                            ? selection.tab
                            : "general",
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
            {isAdmin && !site.external && (
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
                <li>
                  <button
                    type="button"
                    aria-current={
                      selection.kind === "audit" ? "page" : undefined
                    }
                    onClick={() => select({ kind: "audit" })}
                  >
                    <ScrollText size={15} aria-hidden="true" />
                    <span className="settings-nav-name">감사 로그</span>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    aria-current={
                      selection.kind === "history-cleanup" ? "page" : undefined
                    }
                    onClick={() => select({ kind: "history-cleanup" })}
                  >
                    <History size={15} aria-hidden="true" />
                    <span className="settings-nav-name">변경 이력 정리</span>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    aria-current={
                      selection.kind === "service-connections"
                        ? "page"
                        : undefined
                    }
                    onClick={() => select({ kind: "service-connections" })}
                  >
                    <Plug size={15} aria-hidden="true" />
                    <span className="settings-nav-name">외부 동기화</span>
                  </button>
                </li>
              </ul>
            </>
          )}
          <footer className="settings-version">
            <span>버전 {__APP_VERSION__}</span>
            <a
              href="https://github.com/hwantage/GraeBoard"
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub 저장소"
              data-tooltip="GitHub 저장소"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d={GITHUB_MARK} />
              </svg>
            </a>
          </footer>
        </nav>
        <section className="settings-content">
          <ErrorNote error={error} />
          <Toast message={message} />
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
                    aria-selected={selectedTab === key}
                    aria-controls={`panel-${key}`}
                    onClick={() => select({ ...selection, tab: key })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div
                role="tabpanel"
                id={`panel-${selectedTab}`}
                aria-labelledby={`tab-${selectedTab}`}
              >
                {selectedTab === "general" && (
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
                {selectedTab === "members" && (
                  <TeamMembers
                    key={selectedTeam.id}
                    team={selectedTeam}
                    user={user}
                    onSaved={saved}
                    onMessage={setMessage}
                  />
                )}
                {selectedTab === "properties" && (
                  <PropertiesManager
                    key={selectedTeam.id}
                    team={selectedTeam}
                    onSaved={saved}
                  />
                )}
                {selectedTab === "format" && (
                  <DefaultStyleManager
                    key={selectedTeam.id}
                    team={selectedTeam}
                    onSaved={saved}
                  />
                )}
                {selectedTab === "sync" && (
                  <TeamSyncSettings
                    key={selectedTeam.id}
                    team={selectedTeam}
                    user={user}
                    onSaved={saved}
                    onMessage={setMessage}
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
          {isAdmin && selection.kind === "history-cleanup" && (
            <>
              <div
                className="settings-tabs"
                role="tablist"
                aria-label="정리 종류"
              >
                <button
                  id="cleanup-history-tab"
                  role="tab"
                  aria-selected={cleanupTab === "history"}
                  aria-controls="cleanup-history-panel"
                  onClick={() => setCleanupTab("history")}
                >
                  변경 이력
                </button>
                <button
                  id="cleanup-site-tab"
                  role="tab"
                  aria-selected={cleanupTab === "site"}
                  aria-controls="cleanup-site-panel"
                  onClick={() => setCleanupTab("site")}
                >
                  연도·문서·이미지
                </button>
              </div>
              <div
                role="tabpanel"
                id={`cleanup-${cleanupTab}-panel`}
                aria-labelledby={`cleanup-${cleanupTab}-tab`}
              >
                {cleanupTab === "history" ? (
                  <HistoryCleanup initialTeamId={team?.id || ""} />
                ) : (
                  <SiteMaintenance
                    teams={teams}
                    initialTeamId={team?.id || teams[0]?.id || ""}
                  />
                )}
              </div>
            </>
          )}
          {isAdmin && selection.kind === "service-connections" && (
            <ServiceConnections teams={teams} user={user} onRefresh={saved} />
          )}
          {isAdmin && selection.kind === "audit" && (
            <SystemAuditLog users={users} teams={teams} />
          )}
        </section>
      </div>
    </Modal>
  );
}
