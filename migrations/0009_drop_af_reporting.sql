-- Arbetsförmedlingen reporting is gone: Jobb applies on StudentConsulting and
-- builds the monthly .txt. Drop the report-status tables and the old
-- BankID/report reminders, and log export e-mails instead (also manual sends
-- that belong to no run).
DROP INDEX IF EXISTS idx_report_activity_items_state;
DROP TABLE IF EXISTS report_activity_items;
DROP TABLE IF EXISTS reports;

DROP INDEX IF EXISTS idx_notifications_run;
DROP TABLE IF EXISTS notifications;

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  automation_run_id TEXT REFERENCES automation_runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('export_email')),
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  status TEXT NOT NULL CHECK (status IN ('sent','failed')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notifications_run
  ON notifications(automation_run_id, created_at DESC);
