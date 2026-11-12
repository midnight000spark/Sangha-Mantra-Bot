CREATE TABLE daily_reports (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  day TEXT NOT NULL,
  timezone TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL CHECK (period_end >= period_start),
  snapshot_at INTEGER NOT NULL,
  day_total INTEGER NOT NULL CHECK (day_total >= 0),
  total INTEGER NOT NULL CHECK (total >= 0),
  correction INTEGER NOT NULL,
  goal INTEGER NOT NULL CHECK (goal > 0),
  target_chat_id INTEGER NOT NULL,
  reconstructed_after_restore INTEGER NOT NULL DEFAULT 0 CHECK (reconstructed_after_restore IN (0, 1)),
  body TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'UNCERTAIN', 'FAILED_KNOWN')),
  attempt_token TEXT,
  lease_until INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER,
  telegram_message_id INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, day)
);

CREATE INDEX daily_reports_outbox ON daily_reports(campaign_id, status, retry_after, day);

CREATE TABLE report_audit (
  id INTEGER PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  day TEXT NOT NULL,
  at INTEGER NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  attempt_token TEXT,
  target_chat_id INTEGER NOT NULL,
  error TEXT,
  FOREIGN KEY (campaign_id, day) REFERENCES daily_reports(campaign_id, day)
);

CREATE TRIGGER report_created AFTER INSERT ON daily_reports
BEGIN
  INSERT INTO report_audit(campaign_id, day, at, to_state, target_chat_id)
  VALUES (NEW.campaign_id, NEW.day, NEW.updated_at, NEW.status, NEW.target_chat_id);
END;

CREATE TRIGGER report_state_changed AFTER UPDATE OF status ON daily_reports
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO report_audit(campaign_id, day, at, from_state, to_state, attempt_token, target_chat_id, error)
  VALUES (NEW.campaign_id, NEW.day, NEW.updated_at, OLD.status, NEW.status,
    NEW.attempt_token, NEW.target_chat_id, NEW.last_error);
END;

CREATE TRIGGER report_snapshot_immutable BEFORE UPDATE OF
  campaign_id, day, timezone, period_start, period_end, snapshot_at,
  day_total, total, correction, goal, reconstructed_after_restore ON daily_reports
BEGIN
  SELECT RAISE(ABORT, 'Report snapshots are immutable');
END;

CREATE TRIGGER report_attempt_destination_immutable BEFORE UPDATE OF target_chat_id ON daily_reports
WHEN OLD.status IN ('SENDING', 'SENT', 'UNCERTAIN') AND NEW.target_chat_id <> OLD.target_chat_id
BEGIN
  SELECT RAISE(ABORT, 'An attempted report retains its delivery destination');
END;

CREATE TRIGGER report_body_immutable BEFORE UPDATE OF body ON daily_reports
WHEN OLD.body IS NOT NULL AND NEW.body IS NOT OLD.body
BEGIN
  SELECT RAISE(ABORT, 'Report text is immutable');
END;

CREATE TABLE report_resolutions (
  idempotency_key TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  day TEXT NOT NULL,
  at INTEGER NOT NULL,
  admin_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('confirm_sent', 'retry')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  telegram_message_id INTEGER,
  previous_state TEXT NOT NULL CHECK (previous_state IN ('UNCERTAIN', 'FAILED_KNOWN')),
  CHECK ((action = 'confirm_sent' AND telegram_message_id IS NOT NULL AND telegram_message_id > 0)
    OR (action = 'retry' AND telegram_message_id IS NULL)),
  FOREIGN KEY (campaign_id, day) REFERENCES daily_reports(campaign_id, day)
);

CREATE TRIGGER apply_report_resolution AFTER INSERT ON report_resolutions
BEGIN
  UPDATE daily_reports SET
    status = CASE NEW.action WHEN 'confirm_sent' THEN 'SENT' ELSE 'PENDING' END,
    telegram_message_id = NEW.telegram_message_id,
    attempt_token = NULL,
    lease_until = NULL,
    retry_after = NULL,
    last_error = NULL,
    updated_at = NEW.at
  WHERE campaign_id = NEW.campaign_id AND day = NEW.day;
END;
