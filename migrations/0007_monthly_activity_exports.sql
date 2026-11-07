PRAGMA foreign_keys = ON;

CREATE TABLE activity_report_exports (
  report_month TEXT PRIMARY KEY,
  target_count INTEGER NOT NULL CHECK (target_count > 0),
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  content_text TEXT NOT NULL,
  ready_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_activity_report_exports_ready_at
  ON activity_report_exports(ready_at);
