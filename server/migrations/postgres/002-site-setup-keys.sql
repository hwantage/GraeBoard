CREATE TABLE setup_link_keys(
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES site_meta(team_id),
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  used_at TEXT,
  received_at TEXT NOT NULL
);
CREATE TABLE setup_key_state(
  team_id TEXT PRIMARY KEY REFERENCES site_meta(team_id),
  source_head TEXT NOT NULL,
  received_at TEXT NOT NULL
);
