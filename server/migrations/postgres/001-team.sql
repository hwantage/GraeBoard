CREATE TABLE teams(id TEXT PRIMARY KEY,name TEXT NOT NULL,settings TEXT NOT NULL);
CREATE TABLE team_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),team_id TEXT NOT NULL UNIQUE REFERENCES teams(id));
CREATE TABLE team_sync_links(
 team_id TEXT PRIMARY KEY REFERENCES teams(id), repo_id TEXT NOT NULL, bootstrap_id TEXT NOT NULL,
 installation_id TEXT NOT NULL, writer_epoch TEXT NOT NULL, profile_id TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('initializing','importing','active','paused','recovery','disconnected')),
 canonical_head TEXT, canonical_hash TEXT, generation BIGINT NOT NULL DEFAULT 0,
 last_received_at TEXT, last_published_at TEXT, last_error TEXT, remote_status TEXT,
 bootstrap_bundle TEXT, lease_owner TEXT, lease_until BIGINT, updated_at TEXT NOT NULL
);
CREATE TABLE sync_entities(
 team_id TEXT NOT NULL REFERENCES teams(id), entity TEXT NOT NULL, entity_key TEXT NOT NULL,
 generation TEXT NOT NULL, version TEXT NOT NULL, payload TEXT, deleted INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(team_id,entity,entity_key)
);
CREATE TABLE sync_outbox(
 local_seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, op_id TEXT NOT NULL UNIQUE,
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
 data BYTEA NOT NULL, size INTEGER NOT NULL CHECK(size>=0), PRIMARY KEY(team_id,hash)
);
CREATE TABLE sync_person_refs(
 team_id TEXT NOT NULL REFERENCES teams(id), person_id TEXT NOT NULL, profile TEXT NOT NULL,
 local_user_id TEXT, PRIMARY KEY(team_id,person_id)
);
CREATE TABLE site_retention(
 team_id TEXT NOT NULL REFERENCES teams(id), site_id TEXT NOT NULL, kind TEXT NOT NULL,
 entity_key TEXT NOT NULL, generation TEXT NOT NULL DEFAULT '', revision BIGINT NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(team_id,site_id,kind,entity_key,generation)
);
CREATE TABLE site_maintenance_jobs(
 job_id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), kind TEXT NOT NULL,
 phase TEXT NOT NULL, manifest TEXT NOT NULL, progress TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX site_maintenance_active_idx ON site_maintenance_jobs(team_id) WHERE phase NOT IN ('complete','cancelled');
CREATE TABLE site_entity_revisions(
 team_id TEXT NOT NULL REFERENCES teams(id), entity TEXT NOT NULL, entity_key TEXT NOT NULL,
 revision BIGINT NOT NULL, PRIMARY KEY(team_id,entity,entity_key)
);
CREATE TABLE site_events(
 cursor BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id),
 kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX site_events_team_idx ON site_events(team_id,cursor);

CREATE TABLE site_entities(team_id TEXT NOT NULL REFERENCES teams(id), entity TEXT NOT NULL, entity_key TEXT NOT NULL, payload TEXT, revision BIGINT NOT NULL DEFAULT 0 CHECK(revision>=0), deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)), PRIMARY KEY(team_id,entity,entity_key));
CREATE TABLE site_audit(id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES teams(id),actor_id TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX site_audit_team_idx ON site_audit(team_id,created_at);
CREATE TABLE site_operations(team_id TEXT NOT NULL REFERENCES teams(id),op_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_hash TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(team_id,op_id));
CREATE TABLE connection_probes(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
