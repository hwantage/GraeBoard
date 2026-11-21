SET LOCAL search_path TO graeboard_slides, pg_catalog;

-- State of slide file synchronization with the other site (the sync-slides-v1
-- branch). `epoch` and `next_seq` name the versions this store publishes; a
-- restored store starts a new epoch, so a version ID is never used twice.
CREATE TABLE slide_sync_state (
  team_id TEXT PRIMARY KEY,
  head TEXT,
  epoch TEXT NOT NULL,
  next_seq INTEGER NOT NULL
);

-- Per file: the version both sites last agreed on, and the version allocated
-- for a publication that has not been confirmed yet.
CREATE TABLE slide_sync_files (
  team_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  shared_version TEXT,
  shared_hash TEXT,
  shared_title TEXT,
  shared_deleted_at TEXT,
  shared_chunks TEXT,
  meta_oid TEXT,
  pending_version TEXT,
  pending_key TEXT,
  PRIMARY KEY (team_id, file_id)
);

DO $grants$
BEGIN
  REVOKE ALL ON slide_sync_state, slide_sync_files FROM PUBLIC;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON slide_sync_state, slide_sync_files FROM anon;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON slide_sync_state, slide_sync_files FROM authenticated;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='graeboard_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON slide_sync_state, slide_sync_files TO graeboard_app;
  END IF;
END
$grants$;
