ALTER TABLE calendar_entries ADD COLUMN start_time TEXT CHECK(start_time IS NULL OR start_time GLOB '[0-2][0-9]:[0-5][0-9]');
ALTER TABLE calendar_entries ADD COLUMN reminders TEXT CHECK(reminders IS NULL OR (json_valid(reminders) AND json_type(reminders)='array'));
CREATE INDEX calendar_entries_reminder_idx ON calendar_entries(date) WHERE reminders IS NOT NULL AND deleted_at IS NULL;
CREATE TABLE push_addresses(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,ip TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE calendar_reminder_sends(entry_id TEXT NOT NULL REFERENCES calendar_entries(id) ON DELETE CASCADE,fire_at TEXT NOT NULL,sent_at TEXT NOT NULL,recipients INTEGER NOT NULL,PRIMARY KEY(entry_id,fire_at));
