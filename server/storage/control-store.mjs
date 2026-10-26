import { controlTransaction } from "../../worker/data.mjs";
import { profiles as configuredProfiles } from "../../worker/config.mjs";
import { CALENDAR_DAYS } from "../../shared/calendar.js";

function userDto(row, memberships) {
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
export async function userRecord(tx, row) {
  const memberships = (
    await tx.query("SELECT team_id,role FROM memberships WHERE user_id=$1", [
      row.id,
    ])
  ).rows;
  return userDto(row, memberships);
}
function directory(rows, memberships) {
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
export class PostgresControlStore {
  constructor(env) {
    this.env = env;
    this.authenticationMode = "access";
  }
  revision() {
    return controlTransaction(
      this.env,
      async (tx) =>
        (await tx.query("SELECT revision FROM control_meta WHERE singleton=1"))
          .rows[0].revision,
    );
  }
  teams(user) {
    return controlTransaction(
      this.env,
      async (tx) =>
        (
          await tx.query(
            user.systemRole === "admin"
              ? "SELECT * FROM teams ORDER BY name"
              : "SELECT t.* FROM teams t JOIN memberships m ON m.team_id=t.id WHERE m.user_id=$1 ORDER BY t.name",
            user.systemRole === "admin" ? [] : [user.id],
          )
        ).rows,
    );
  }
  teamRow(id) {
    return controlTransaction(
      this.env,
      async (tx) =>
        (await tx.query("SELECT * FROM teams WHERE id=$1", [id])).rows[0] ||
        null,
    );
  }
  users() {
    return controlTransaction(this.env, async (tx) =>
      directory(
        (await tx.query("SELECT * FROM users ORDER BY name")).rows,
        (
          await tx.query(
            "SELECT user_id,team_id,role FROM memberships ORDER BY user_id,team_id",
          )
        ).rows,
      ),
    );
  }
  members(teamId, { activeOnly = false } = {}) {
    return controlTransaction(this.env, async (tx) => {
      const rows = (
        await tx.query(
          "SELECT u.*,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.team_id=$1" +
            (activeOnly ? " AND u.active=TRUE" : "") +
            " ORDER BY u.name,u.id",
          [teamId],
        )
      ).rows;
      const memberships = rows.length
        ? (
            await tx.query(
              "SELECT user_id,team_id,role FROM memberships WHERE user_id=ANY($1::text[]) ORDER BY user_id,team_id",
              [rows.map((r) => r.id)],
            )
          ).rows
        : [];
      return directory(rows, memberships);
    });
  }
  calendarPreferences(userId) {
    return controlTransaction(this.env, async (tx) => {
      const row = (
        await tx.query(
          "SELECT payload FROM control_preferences WHERE user_id=$1",
          [userId],
        )
      ).rows[0];
      return row ? JSON.parse(row.payload) : { weekdays: CALENDAR_DAYS };
    });
  }
  saveCalendarPreferences(userId, weekdays) {
    return controlTransaction(
      this.env,
      async (tx) => {
        await tx.query(
          "INSERT INTO control_preferences(user_id,payload) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET payload=EXCLUDED.payload",
          [userId, JSON.stringify({ weekdays })],
        );
        return { weekdays };
      },
      { write: true },
    );
  }
}
// The injected SQLite handle is a host port. This module never imports the
// native SQLite runtime, keeping PostgreSQL Worker bundles independent of it.
export class SqliteControlStore {
  constructor({ db, env, profiles }) {
    this.db = db;
    this.profiles = profiles || configuredProfiles(env, { databaseOnly: true });
    this.authenticationMode = "password";
  }
  revision() {
    const changes = this.db
      .prepare("SELECT total_changes() AS value")
      .get().value;
    const version = this.db.prepare("PRAGMA data_version").get().data_version;
    return `${changes}:${version}`;
  }
  mapTeam(row) {
    if (!row) return null;
    const profile =
      this.profiles.find(
        (profile) => profile.teamId === row.id && !profile.replaces,
      ) || this.profiles.find((profile) => profile.teamId === row.id);
    return {
      id: row.id,
      name: row.name,
      profile_id: profile?.profileId || null,
      status: profile ? "active" : "unconfigured",
      config_revision: 0,
    };
  }
  teams(user) {
    return this.db
      .prepare(
        user.systemRole === "admin"
          ? "SELECT * FROM teams ORDER BY name"
          : "SELECT t.* FROM teams t JOIN memberships m ON m.team_id=t.id WHERE m.user_id=? ORDER BY t.name",
      )
      .all(...(user.systemRole === "admin" ? [] : [user.id]))
      .map((row) => this.mapTeam(row));
  }
  teamRow(id) {
    return this.mapTeam(
      this.db.prepare("SELECT * FROM teams WHERE id=?").get(id),
    );
  }
  users() {
    return directory(
      this.db.prepare("SELECT * FROM users ORDER BY name").all(),
      this.db
        .prepare(
          "SELECT user_id,team_id,role FROM memberships ORDER BY user_id,team_id",
        )
        .all(),
    );
  }
  members(teamId, { activeOnly = false } = {}) {
    const rows = this.db
      .prepare(
        "SELECT u.*,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.team_id=?" +
          (activeOnly ? " AND u.active=1" : "") +
          " ORDER BY u.name,u.id",
      )
      .all(teamId);
    return directory(
      rows,
      this.db
        .prepare(
          "SELECT user_id,team_id,role FROM memberships WHERE user_id IN (SELECT user_id FROM memberships WHERE team_id=?) ORDER BY user_id,team_id",
        )
        .all(teamId),
    );
  }
  calendarPreferences(userId) {
    const row = this.db
      .prepare("SELECT weekdays FROM calendar_preferences WHERE user_id=?")
      .get(userId);
    return { weekdays: row ? JSON.parse(row.weekdays) : CALENDAR_DAYS };
  }
  saveCalendarPreferences(userId, weekdays) {
    this.db
      .prepare(
        "INSERT INTO calendar_preferences(user_id,weekdays) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET weekdays=excluded.weekdays",
      )
      .run(userId, JSON.stringify(weekdays));
    return { weekdays };
  }
}
