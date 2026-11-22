-- Team slide files. This database is separate from the task database: it has
-- its own version and migration history, and no row here refers to a table of
-- the task database.
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
