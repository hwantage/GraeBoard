-- Team slide files of the external site. A schema of its own, with its own
-- migration history: nothing in the graeboard schema or its history changes,
-- so a release that predates slides keeps starting on the same database.
CREATE SCHEMA graeboard_slides;
SET LOCAL search_path TO graeboard_slides, pg_catalog;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE slide_files (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  content_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  create_request_id TEXT NOT NULL,
  UNIQUE (team_id, create_request_id)
);
CREATE INDEX slide_files_team ON slide_files (team_id, updated_at);

-- One row per stored revision. A repeated request ID returns the first result.
CREATE TABLE slide_file_revisions (
  file_id TEXT NOT NULL REFERENCES slide_files (id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  saved_by TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  PRIMARY KEY (file_id, revision),
  UNIQUE (file_id, request_id)
);
CREATE INDEX slide_file_revisions_hash ON slide_file_revisions (content_hash);

-- Temporary share snapshots; never the team original.
CREATE TABLE slide_shares (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX slide_shares_expiry ON slide_shares (expires_at);

-- The server reaches this schema through its own database role only.
DO $grants$
BEGIN
  REVOKE ALL ON SCHEMA graeboard_slides FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA graeboard_slides FROM PUBLIC;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON SCHEMA graeboard_slides FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA graeboard_slides FROM anon;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON SCHEMA graeboard_slides FROM authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA graeboard_slides FROM authenticated;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='graeboard_app') THEN
    GRANT USAGE ON SCHEMA graeboard_slides TO graeboard_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA graeboard_slides TO graeboard_app;
  END IF;
END
$grants$;
