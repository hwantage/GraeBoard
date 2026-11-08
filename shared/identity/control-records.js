export function userDto(row, memberships) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    systemRole: row.system_role,
    active: !!row.active,
    color: row.color,
    avatarInitials: row.avatar_initials || "",
    avatarImage: row.avatar_image || "",
    teamIds: memberships.map((m) => m.team_id),
    teamRoles: Object.fromEntries(memberships.map((m) => [m.team_id, m.role])),
  };
}
export function directory(rows, memberships) {
  const byId = new Map();
  for (const membership of memberships) {
    const list = byId.get(membership.user_id) || [];
    list.push(membership);
    byId.set(membership.user_id, list);
  }
  return rows.map((row) => ({
    ...userDto(row, byId.get(row.id) || []),
    ...(row.role ? { role: row.role } : {}),
  }));
}
