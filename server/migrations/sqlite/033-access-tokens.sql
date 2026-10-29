CREATE TABLE access_tokens(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL
);
CREATE INDEX access_tokens_user_idx ON access_tokens(user_id,created_at);
