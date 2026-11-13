CREATE TABLE IF NOT EXISTS dashboard_login_attempts (
  bucket_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_started_at INTEGER NOT NULL
);
