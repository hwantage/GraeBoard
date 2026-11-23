ALTER TABLE calendar_entries ADD COLUMN start_time TEXT CHECK(start_time IS NULL OR start_time GLOB '[0-2][0-9]:[0-5][0-9]');
ALTER TABLE calendar_entries ADD COLUMN remind_minutes INTEGER CHECK(remind_minutes IS NULL OR remind_minutes BETWEEN 0 AND 1440);
CREATE INDEX calendar_entries_reminder_idx ON calendar_entries(date) WHERE remind_minutes IS NOT NULL AND deleted_at IS NULL;
CREATE TABLE push_addresses(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,ip TEXT NOT NULL,manual INTEGER NOT NULL DEFAULT 0 CHECK(manual IN (0,1)),updated_at TEXT NOT NULL);
CREATE TABLE calendar_reminder_sends(entry_id TEXT NOT NULL REFERENCES calendar_entries(id) ON DELETE CASCADE,fire_at TEXT NOT NULL,sent_at TEXT NOT NULL,recipients INTEGER NOT NULL,PRIMARY KEY(entry_id,fire_at));
