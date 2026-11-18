-- Sessions that were signed out before they expired.
CREATE TABLE IF NOT EXISTS dashboard_revoked_sessions (
  session_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
