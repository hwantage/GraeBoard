import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  postgresMigrations,
  siteKeyMigration,
  teamMaintenanceMigration,
} from "../server/migrations/postgres.mjs";

export function siteKeyMigrationSql(teamId) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      teamId || "",
    )
  )
    throw new Error("Provide the existing team UUID");
  return `-- Run in the team's Supabase SQL Editor during the approved maintenance window.
-- Additive site v1 -> v2 and team v1 -> v2; existing data is preserved.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(214701,1);
SET LOCAL search_path TO graeboard_site, pg_catalog;
DO $migration$
DECLARE current_version integer;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM site_meta WHERE singleton=1 AND team_id='${teamId}')
    OR NOT EXISTS(SELECT 1 FROM graeboard.team_meta WHERE singleton=1 AND team_id='${teamId}') THEN
    RAISE EXCEPTION 'Site/team identity mismatch';
  END IF;
  IF (SELECT COUNT(*) FROM graeboard.schema_migrations) NOT IN (1,2) OR NOT EXISTS(
    SELECT 1 FROM graeboard.schema_migrations WHERE scope='team' AND version=1 AND checksum='${postgresMigrations.team.checksum}') OR EXISTS(
    SELECT 1 FROM graeboard.schema_migrations WHERE version<>1 AND NOT (scope='team' AND version=2 AND checksum='${teamMaintenanceMigration.checksum}')) THEN
    RAISE EXCEPTION 'Team migration history mismatch';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM graeboard.schema_migrations WHERE version=2) THEN
    ${teamMaintenanceMigration.sql.replace("ON sync_outbox(", "ON graeboard.sync_outbox(")}
    INSERT INTO graeboard.schema_migrations(scope,version,checksum,applied_at)
      VALUES('team',2,'${teamMaintenanceMigration.checksum}',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  END IF;
  SELECT MAX(version) INTO current_version FROM schema_migrations;
  IF current_version NOT IN (1,2) OR (SELECT COUNT(*) FROM schema_migrations)<>current_version OR NOT EXISTS(
    SELECT 1 FROM schema_migrations WHERE scope='site' AND version=1 AND checksum='${postgresMigrations.site.checksum}') THEN
    RAISE EXCEPTION 'Site migration history mismatch';
  END IF;
  IF current_version=2 THEN
    IF NOT EXISTS(SELECT 1 FROM schema_migrations WHERE scope='site' AND version=2 AND checksum='${siteKeyMigration.checksum}') THEN
      RAISE EXCEPTION 'Site migration checksum mismatch';
    END IF;
  ELSE
    ${siteKeyMigration.sql}
    INSERT INTO schema_migrations(scope,version,checksum,applied_at)
      VALUES('site',2,'${siteKeyMigration.checksum}',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  END IF;
  REVOKE ALL ON setup_link_keys,setup_key_state FROM PUBLIC;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON setup_link_keys,setup_key_state FROM anon;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON setup_link_keys,setup_key_state FROM authenticated;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='graeboard_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON setup_link_keys,setup_key_state TO graeboard_app;
  END IF;
END
$migration$;
COMMIT;
SELECT version AS site_version FROM graeboard_site.schema_migrations WHERE scope='site' ORDER BY version DESC LIMIT 1;
`;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.stdout.write(siteKeyMigrationSql(process.argv[2]));
