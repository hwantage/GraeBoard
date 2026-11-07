ALTER TABLE reports RENAME TO sheet_clones;
ALTER TABLE report_documents RENAME TO sheet_clone_documents;
ALTER TABLE sheet_clone_documents RENAME COLUMN report_id TO sheet_clone_id;
ALTER TABLE report_memos RENAME TO sheet_clone_memos;
ALTER TABLE sheet_clone_memos RENAME COLUMN report_id TO sheet_clone_id;
DROP INDEX report_documents_version_idx;
CREATE INDEX sheet_clone_documents_version_idx ON sheet_clone_documents(version_id);
DROP INDEX report_memos_version_idx;
CREATE INDEX sheet_clone_memos_version_idx ON sheet_clone_memos(version_id);
CREATE TABLE sync_conversions(
 team_id TEXT PRIMARY KEY REFERENCES teams(id), conversion TEXT NOT NULL,
 from_protocol INTEGER NOT NULL, to_protocol INTEGER NOT NULL,
 base_head TEXT NOT NULL, base_hash TEXT NOT NULL, result_hash TEXT NOT NULL,
 previous_snapshot BLOB NOT NULL CHECK(typeof(previous_snapshot)='blob'), previous_snapshot_hash TEXT NOT NULL,
 options TEXT NOT NULL, created_at TEXT NOT NULL, completed_head TEXT, completed_at TEXT
);
CREATE TABLE data_conversions(
 name TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, options TEXT NOT NULL,
 summary TEXT NOT NULL, applied_at TEXT NOT NULL
);
