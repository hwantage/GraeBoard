import { controlTransaction } from "../data.mjs";
import { CALENDAR_DAYS } from "../../shared/calendar.js";
import { userDto, directory } from "../../shared/control-records.js";

export async function userRecord(tx, row) {
  const memberships = (
    await tx.query("SELECT team_id,role FROM memberships WHERE user_id=$1", [
      row.id,
    ])
  ).rows;
  return userDto(row, memberships);
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
