CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE team_sync_links(
 team_id TEXT PRIMARY KEY REFERENCES teams(id), repo_id TEXT NOT NULL, bootstrap_id TEXT NOT NULL,
 installation_id TEXT NOT NULL, writer_epoch TEXT NOT NULL, profile_id TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('initializing','importing','active','paused','recovery','disconnected')),
 canonical_head TEXT, canonical_hash TEXT, generation INTEGER NOT NULL DEFAULT 0,
 last_received_at TEXT, last_published_at TEXT, last_error TEXT, remote_status TEXT,
 bootstrap_bundle TEXT, lease_owner TEXT, lease_until INTEGER, updated_at TEXT NOT NULL
);
CREATE TABLE sync_entities(
 team_id TEXT NOT NULL REFERENCES teams(id), entity TEXT NOT NULL, entity_key TEXT NOT NULL,
 generation TEXT NOT NULL, version TEXT NOT NULL, payload TEXT, deleted INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(team_id,entity,entity_key)
);
CREATE TABLE sync_outbox(
 local_seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL UNIQUE,
 team_id TEXT NOT NULL REFERENCES teams(id), payload TEXT NOT NULL, payload_hash TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','acknowledged','held')),
 created_at TEXT NOT NULL
);
CREATE INDEX sync_outbox_pending_idx ON sync_outbox(team_id,local_seq) WHERE status<>'acknowledged';
CREATE TABLE sync_receipts(
 team_id TEXT NOT NULL REFERENCES teams(id), op_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 result TEXT NOT NULL, commit_oid TEXT, receipt TEXT NOT NULL, PRIMARY KEY(team_id,op_id)
);
CREATE TABLE sync_conflicts(
 team_id TEXT NOT NULL REFERENCES teams(id), conflict_id TEXT NOT NULL, op_id TEXT NOT NULL,
 payload TEXT NOT NULL, resolution TEXT, PRIMARY KEY(team_id,conflict_id)
);
CREATE TABLE sync_objects(
 team_id TEXT NOT NULL REFERENCES teams(id), hash TEXT NOT NULL, kind TEXT NOT NULL,
 data BLOB NOT NULL, size INTEGER NOT NULL CHECK(size>=0), PRIMARY KEY(team_id,hash)
);
CREATE TABLE sync_person_refs(
 team_id TEXT NOT NULL REFERENCES teams(id), person_id TEXT NOT NULL, profile TEXT NOT NULL,
 local_user_id TEXT, PRIMARY KEY(team_id,person_id)
);
CREATE TABLE site_retention(
 team_id TEXT NOT NULL REFERENCES teams(id), site_id TEXT NOT NULL, kind TEXT NOT NULL,
 entity_key TEXT NOT NULL, generation TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(team_id,site_id,kind,entity_key,generation)
);
CREATE TABLE site_maintenance_jobs(
 job_id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), kind TEXT NOT NULL,
 phase TEXT NOT NULL, manifest TEXT NOT NULL, progress TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX site_maintenance_active_idx ON site_maintenance_jobs(team_id) WHERE phase NOT IN ('complete','cancelled');
CREATE TABLE site_entity_revisions(
 team_id TEXT NOT NULL REFERENCES teams(id), entity TEXT NOT NULL, entity_key TEXT NOT NULL,
 revision INTEGER NOT NULL, PRIMARY KEY(team_id,entity,entity_key)
);
CREATE TABLE site_events(
 cursor INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL REFERENCES teams(id),
 kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX site_events_team_idx ON site_events(team_id,cursor);
CREATE TABLE sync_credentials(profile_id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, updated_at TEXT NOT NULL);
