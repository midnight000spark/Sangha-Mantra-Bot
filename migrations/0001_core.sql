CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL,
  start_day TEXT NOT NULL,
  goal INTEGER NOT NULL CHECK(goal > 0 AND goal <= 1000000000),
  report_chat_id INTEGER NOT NULL,
  goal_reached_at INTEGER
);
CREATE TABLE chat_aliases (
  chat_id INTEGER PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id)
);
CREATE TABLE contributions (
  source_chat_id INTEGER NOT NULL REFERENCES chat_aliases(chat_id),
  message_id INTEGER NOT NULL CHECK(message_id > 0),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  original_date INTEGER NOT NULL CHECK(original_date > 0),
  local_day TEXT NOT NULL,
  user_id INTEGER,
  source_amount INTEGER NOT NULL CHECK(source_amount BETWEEN 0 AND 1000000000),
  source_state TEXT NOT NULL CHECK(source_state IN ('VALID','INVALID','REVIEW')),
  version_date INTEGER NOT NULL,
  is_edit INTEGER NOT NULL CHECK(is_edit IN (0,1)),
  override_amount INTEGER CHECK(override_amount BETWEEN 0 AND 1000000000),
  effective_amount INTEGER GENERATED ALWAYS AS
    (COALESCE(override_amount, CASE WHEN source_state = 'REVIEW' THEN 0 ELSE source_amount END)) STORED,
  last_event_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(source_chat_id, message_id),
  CHECK(source_state != 'INVALID' OR source_amount = 0)
);
CREATE INDEX contributions_day ON contributions(campaign_id,local_day,effective_amount);
CREATE TABLE event_log (
  event_key TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  source_chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  original_date INTEGER NOT NULL,
  local_day TEXT NOT NULL,
  user_id INTEGER,
  version_date INTEGER NOT NULL,
  is_edit INTEGER NOT NULL,
  source_amount INTEGER NOT NULL,
  source_state TEXT NOT NULL,
  reason TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('APPLIED','IGNORED_STALE','UNCHANGED','NEEDS_REVIEW','REJECTED')),
  old_amount INTEGER NOT NULL,
  new_amount INTEGER,
  received_at INTEGER NOT NULL
);
CREATE INDEX event_log_message ON event_log(source_chat_id,message_id,received_at);
CREATE INDEX event_log_received ON event_log(campaign_id,received_at);
CREATE TABLE admin_adjustments (
  adjustment_key TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  actor_id INTEGER NOT NULL,
  source_chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('OVERRIDE','RELEASE','IMPORT')),
  amount INTEGER,
  old_amount INTEGER NOT NULL,
  new_amount INTEGER,
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(source_chat_id,message_id) REFERENCES contributions(source_chat_id,message_id)
);
CREATE INDEX admin_adjustments_message ON admin_adjustments(source_chat_id,message_id,created_at);
