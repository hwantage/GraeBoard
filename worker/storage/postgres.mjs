import { DatabaseAdapter } from "../../shared/database-adapter.js";
import {
  createTeamStore,
  executeAsync,
  prepareStatePatch,
} from "../../shared/sync-team-store.mjs";
import { digest } from "../../server/sync/protocol.mjs";
import {
  postgresHistoryVersion,
  postgresLayout,
} from "../../shared/postgres-schema-version.js";

export class PostgresDatabase extends DatabaseAdapter {
  constructor(
    pool,
    { scope = "team", teamId = null, site = pool.site || false } = {},
  ) {
    super();
    if (!["team", "control"].includes(scope))
      throw new Error("Invalid PostgreSQL scope");
    this.pool = pool;
    this.scope = scope;
    this.teamId = teamId;
    this.engine = "postgres";
    this.site = site;
    Object.assign(this, postgresLayout(scope, site));
  }
  async transaction(work, { teamId, readOnly = false, retries = 0 } = {}) {
    if (
      this.scope === "team" &&
      (!teamId || (this.teamId && this.teamId !== teamId))
    )
      throw new Error("PostgreSQL team identity mismatch");
    // Retry is opt-in because a callback must retain its operation identity and
    // cannot contain external side effects. Never retry uncertain COMMIT errors.
    if (!Number.isInteger(retries) || retries < 0 || retries > 3)
      throw new Error("Invalid transaction retry bound");
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      let begun = false,
        committing = false,
        open = false;
      try {
        await client.query(
          readOnly
            ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
            : "BEGIN",
        );
        begun = true;
        await client.query(
          `SET LOCAL search_path TO ${this.schema}, pg_catalog`,
        );
        if (!readOnly)
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [teamId || "graeboard-control"],
          );
        if (teamId) {
          const row = (
            await client.query(
              "SELECT team_id FROM team_meta WHERE singleton=1",
            )
          ).rows[0];
          if (row?.team_id !== teamId)
            throw new Error("PostgreSQL team identity mismatch");
        }
        open = true;
        const run = (sql, params = []) => {
          if (!open) throw new Error("Transaction is closed");
          return client.query(sql, params);
        };
        const sync = teamId
          ? createTeamStore(
              teamId,
              (generator) => executeAsync(generator, run),
              { batchSize: 500 },
            )
          : null;
        const result = await work({ teamId, query: run, sync, store: sync });
        open = false;
        committing = true;
        await client.query("COMMIT");
        begun = false;
        return result;
      } catch (error) {
        open = false;
        if (begun) await client.query("ROLLBACK").catch(() => {});
        if (
          !committing &&
          ["40001", "40P01"].includes(error.code) &&
          attempt < retries
        )
          continue;
        throw error;
      } finally {
        await client.release();
      }
    }
  }
  withTeamTransaction(teamId, work, options = {}) {
    if (this.scope !== "team")
      throw new Error("Control database cannot store team data");
    return this.transaction(work, { ...options, teamId });
  }
  withControlTransaction(work, options = {}) {
    if (this.scope !== "control")
      throw new Error("Team database cannot store control data");
    return this.transaction(work, options);
  }
  readSnapshot(teamId) {
    return this.withTeamTransaction(teamId, (tx) => tx.sync.readSnapshot(), {
      readOnly: true,
    });
  }
  readState(teamId) {
    return this.withTeamTransaction(teamId, (tx) => tx.sync.readState(), {
      readOnly: true,
    });
  }
  readLink(teamId) {
    return this.withTeamTransaction(teamId, (tx) => tx.sync.readLink(), {
      readOnly: true,
    });
  }
  readPending(teamId) {
    return this.withTeamTransaction(teamId, (tx) => tx.sync.readPending(), {
      readOnly: true,
    });
  }
  async commitCanonical(
    teamId,
    expectedHead,
    newHead,
    state,
    ackOpIds,
    materialize,
    options = {},
  ) {
    const previous =
      options.previousState ||
      (options.patch ? null : await this.readState(teamId));
    const patch = options.patch || prepareStatePatch(previous, state);
    const hash = options.stateHash || digest(state);
    return this.withTeamTransaction(teamId, async (tx) => {
      if ((await tx.sync.readLink())?.canonical_head !== expectedHead)
        throw new Error("Canonical head changed; recompute before retry");
      await tx.sync.writeState(state, newHead, previous, patch);
      await tx.sync.acknowledge(ackOpIds);
      const pending = await tx.sync.readPending();
      const result = await materialize?.(tx, {
        state,
        pending,
        exclusions: await tx.sync.readExclusions(),
      });
      await tx.sync.advanceHead(expectedHead, newHead, hash);
      return result;
    });
  }
  async health({
    allowPreviousTeam = false,
    allowPreviousSite = false,
    allowPreviousControl = false,
  } = {}) {
    const client = await this.pool.connect();
    try {
      const rows = (
        await client.query(
          `SELECT scope,version,checksum FROM ${this.schema}.schema_migrations ORDER BY version`,
        )
      ).rows;
      const version = postgresHistoryVersion(rows, this.migrationScope, {
        allowPreviousTeam,
        allowPreviousSite,
        allowPreviousControl,
      });
      if (this.scope === "team" && this.teamId) {
        const row = (
          await client.query(
            "SELECT team_id FROM graeboard.team_meta WHERE singleton=1",
          )
        ).rows[0];
        if (row?.team_id !== this.teamId)
          throw new Error("PostgreSQL team identity mismatch");
      }
      return {
        engine: this.engine,
        scope: this.scope,
        version,
        ready: true,
      };
    } finally {
      client.release();
    }
  }
}
