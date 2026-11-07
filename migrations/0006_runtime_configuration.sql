PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runtime_configuration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  updated_by_github_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
