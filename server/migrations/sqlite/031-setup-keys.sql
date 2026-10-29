CREATE TABLE external_setup_keys(
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  published_head TEXT,
  published_at TEXT,
  applied_at TEXT,
  used_at TEXT,
  UNIQUE(team_id,user_id)
);
