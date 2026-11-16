CREATE TABLE sync_conflict_summaries(
 team_id TEXT NOT NULL, conflict_id TEXT NOT NULL, summary TEXT NOT NULL,
 PRIMARY KEY(team_id,conflict_id),
 FOREIGN KEY(team_id,conflict_id) REFERENCES sync_conflicts(team_id,conflict_id) ON DELETE CASCADE
);
CREATE TABLE sync_outbox_summaries(
 team_id TEXT NOT NULL REFERENCES teams(id), op_id TEXT NOT NULL REFERENCES sync_outbox(op_id) ON DELETE CASCADE,
 summary TEXT NOT NULL, PRIMARY KEY(team_id,op_id)
);
-- Bulk restore/import can write source rows directly. Never retain a stale
-- summary; their completion rebuilds these derived tables in the same transaction.
CREATE FUNCTION invalidate_conflict_summary() RETURNS trigger LANGUAGE plpgsql SET search_path=graeboard,pg_catalog AS $$
BEGIN
 DELETE FROM sync_conflict_summaries WHERE team_id=OLD.team_id AND conflict_id=OLD.conflict_id;
 RETURN NEW;
END $$;
CREATE TRIGGER invalidate_conflict_summary AFTER UPDATE OF payload,resolution ON sync_conflicts FOR EACH ROW EXECUTE FUNCTION invalidate_conflict_summary();
CREATE FUNCTION invalidate_outbox_summary() RETURNS trigger LANGUAGE plpgsql SET search_path=graeboard,pg_catalog AS $$
BEGIN
 DELETE FROM sync_outbox_summaries WHERE team_id=OLD.team_id AND op_id=OLD.op_id;
 RETURN NEW;
END $$;
CREATE TRIGGER invalidate_outbox_summary AFTER UPDATE OF payload ON sync_outbox FOR EACH ROW EXECUTE FUNCTION invalidate_outbox_summary();

DO $grants$
BEGIN
 REVOKE ALL ON sync_conflict_summaries,sync_outbox_summaries FROM PUBLIC;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  REVOKE ALL ON sync_conflict_summaries,sync_outbox_summaries FROM anon;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  REVOKE ALL ON sync_conflict_summaries,sync_outbox_summaries FROM authenticated;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='graeboard_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON sync_conflict_summaries,sync_outbox_summaries TO graeboard_app;
 END IF;
END $grants$;
