import {
  postgresMigrations,
  siteKeyMigration,
  teamMaintenanceMigration,
  accessTokenMigrations,
} from "./postgres.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const now = `to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const history =
  "CREATE TABLE schema_migrations(scope TEXT NOT NULL,version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL);";
const record = (scope, migration, version = migration.version) =>
  `INSERT INTO schema_migrations VALUES('${scope}',${version},'${migration.checksum}',${now});`;

// The empty-database branch of migrateSite rendered for the Supabase SQL
// Editor: the same released SQL, order and checksums in one transaction, so an
// operator can initialize a new external site without a local toolchain.
export function siteInitializeSql(teamId, teamName) {
  if (!uuid.test(teamId || ""))
    throw new Error("Provide the existing team UUID");
  const team = literal(teamId),
    name = literal(teamName || "GraeBoard");
  return `-- GraeBoard 외부 DB 초기화 (팀 UUID ${teamId})
-- 새 Supabase 프로젝트의 SQL Editor에 전체를 붙여 넣고 Run을 누릅니다.
-- graeboard·graeboard_site에 테이블이 이미 있으면 아무것도 바꾸지 않고 멈추며,
-- 중간에 실패하면 전체를 되돌립니다. 결과 표에서 팀 UUID와 site 3·team 2를 확인합니다.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_advisory_xact_lock(214701,1);
DO $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('graeboard','graeboard_site') AND c.relkind IN ('r','p','v','m','S','f')) THEN
    RAISE EXCEPTION 'GraeBoard 스키마에 이미 테이블이 있어 초기화하지 않았습니다. 새 Supabase 프로젝트에서 실행하고, 기존 외부 DB는 업그레이드 절차를 따르세요.';
  END IF;
END
$guard$;
CREATE SCHEMA IF NOT EXISTS graeboard_site;
SET LOCAL search_path TO graeboard_site, pg_catalog;
${history}
${postgresMigrations.site.sql.trim()}
${record("site", postgresMigrations.site)}
CREATE SCHEMA IF NOT EXISTS graeboard;
SET LOCAL search_path TO graeboard, pg_catalog;
${history}
${postgresMigrations.team.sql.trim()}
${record("team", postgresMigrations.team)}
INSERT INTO graeboard.teams(id,name,settings) VALUES(${team},${name},'{}');
INSERT INTO graeboard.team_meta VALUES(1,${team});
INSERT INTO graeboard_site.site_meta(singleton,team_id) VALUES(1,${team});
SET LOCAL search_path TO graeboard_site, pg_catalog;
${siteKeyMigration.sql.trim()}
${record("site", siteKeyMigration)}
${accessTokenMigrations.site.sql.trim()}
${record("site", accessTokenMigrations.site)}
SET LOCAL search_path TO graeboard, pg_catalog;
${teamMaintenanceMigration.sql.trim()}
${record("team", teamMaintenanceMigration)}
-- The server reaches these schemas through its own database role only.
DO $grants$
BEGIN
  REVOKE ALL ON SCHEMA graeboard, graeboard_site FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA graeboard, graeboard_site FROM PUBLIC;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON SCHEMA graeboard, graeboard_site FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA graeboard, graeboard_site FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA graeboard, graeboard_site FROM anon;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON SCHEMA graeboard, graeboard_site FROM authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA graeboard, graeboard_site FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA graeboard, graeboard_site FROM authenticated;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='graeboard_app') THEN
    GRANT USAGE ON SCHEMA graeboard, graeboard_site TO graeboard_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA graeboard, graeboard_site TO graeboard_app;
    GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA graeboard, graeboard_site TO graeboard_app;
  END IF;
END
$grants$;
COMMIT;
SELECT
  (SELECT team_id FROM graeboard_site.site_meta) AS team_uuid,
  (SELECT MAX(version) FROM graeboard_site.schema_migrations) AS site_version,
  (SELECT MAX(version) FROM graeboard.schema_migrations) AS team_version;
`;
}
