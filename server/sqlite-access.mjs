import { retentionView } from "./sync/visibility.mjs";

import { id, json, usersWithTeams, teamSettings, getTask } from "./db.mjs";
import { requireThat } from "../shared/validation.js";
import {
  canEdit,
  canManageTeam,
  isAssignable,
  isSystemAdmin,
  propertiesFor,
} from "../shared/domain.js";

export function createSqliteAccess(db) {
  function teamAccess(user, teamId) {
    requireThat(
      isSystemAdmin(user) || user.teamIds.includes(teamId),
      403,
      "이 팀에 접근할 권한이 없습니다.",
    );
    const t = db.prepare("SELECT * FROM teams WHERE id=?").get(teamId);
    requireThat(t, 404, "팀을 찾을 수 없습니다.");
    return { ...t, settings: teamSettings(t) };
  }
  // 팀장(또는 시스템 관리자)만 할 수 있는 작업의 팀 조회.
  function managedTeam(user, teamId, message = "팀장 권한이 필요합니다.") {
    const team = teamAccess(user, teamId);
    requireThat(canManageTeam(user, teamId), 403, message);
    return team;
  }
  function requireSystemAdmin(user) {
    requireThat(isSystemAdmin(user), 403, "시스템 관리자 권한이 필요합니다.");
  }
  function taskAccess(user, taskId, edit = false, includeDeleted = false) {
    const t = getTask(db, taskId);
    requireThat(
      t && (!t.deletedAt || includeDeleted),
      404,
      "업무를 찾을 수 없습니다.",
    );
    teamAccess(user, t.teamId);
    retentionView(db, t.teamId).requireVisible("task", [taskId]);
    if (edit)
      requireThat(canEdit(user, t), 403, "이 업무를 편집할 권한이 없습니다.");
    return t;
  }
  function teamUsers(teamId) {
    return usersWithTeams(
      db,
      db
        .prepare(
          "SELECT u.* FROM users u JOIN memberships m ON u.id=m.user_id WHERE m.team_id=? ORDER BY u.name",
        )
        .all(teamId),
    );
  }
  // 담당자로 고를 수 있는 사람: 그 팀의 팀장·팀원.
  function assignableUsers(teamId) {
    return teamUsers(teamId).filter((u) => isAssignable(u, teamId));
  }
  // 표시용 목록: 현재 구성원(열람자 포함)과, 팀을 떠났지만 아직 셀에 남아 있는
  // 과거 담당자까지 포함해 기존 셀의 이름이 사라지지 않게 한다.
  function referencedUsers(teamId) {
    const users = teamUsers(teamId);
    const settings = teamSettings(
      db.prepare("SELECT settings FROM teams WHERE id=?").get(teamId),
    );
    const keys = [
      ...new Set([
        "owner",
        "supporters",
        ...propertiesFor(settings, true)
          .filter((p) => p.kind === "member")
          .map((p) => p.id),
      ]),
    ];
    const referenced = db
      .prepare(
        // Deduplicate IDs before reading profiles: avatars can be much larger
        // than the member references repeated across thousands of cells.
        "SELECT u.* FROM users u WHERE u.id IN (SELECT DISTINCT v.value FROM tasks t JOIN cells c ON c.task_id=t.id JOIN json_each(c.value) v WHERE t.team_id=? AND c.key IN (SELECT value FROM json_each(?)))",
      )
      .all(teamId, json(keys));
    const current = new Set(users.map((u) => u.id));
    return [
      ...users,
      ...usersWithTeams(
        db,
        referenced.filter((u) => !current.has(u.id)),
      ),
    ];
  }
  return {
    teamAccess,
    taskAccess,
    managedTeam,
    requireSystemAdmin,
    teamUsers,
    assignableUsers,
    referencedUsers,
  };
}
