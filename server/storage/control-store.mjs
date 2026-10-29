import { profiles as configuredProfiles } from "../../shared/sync-profiles.js";
import { CALENDAR_DAYS } from "../../shared/calendar.js";
import { directory } from "../../shared/control-records.js";

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
