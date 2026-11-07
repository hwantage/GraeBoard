CREATE TABLE sync_conversions(
 team_id TEXT PRIMARY KEY REFERENCES teams(id), conversion TEXT NOT NULL,
 from_protocol INTEGER NOT NULL, to_protocol INTEGER NOT NULL,
 base_head TEXT NOT NULL, base_hash TEXT NOT NULL, result_hash TEXT NOT NULL,
 previous_snapshot BYTEA NOT NULL, previous_snapshot_hash TEXT NOT NULL,
 options TEXT NOT NULL, created_at TEXT NOT NULL, completed_head TEXT, completed_at TEXT
);
CREATE TABLE data_conversions(
 name TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, options TEXT NOT NULL,
 summary TEXT NOT NULL, applied_at TEXT NOT NULL
);
