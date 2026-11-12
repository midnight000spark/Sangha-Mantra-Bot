ALTER TABLE notices ADD COLUMN reply_markup TEXT;

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  actor_id INTEGER NOT NULL,
  private_chat_id INTEGER NOT NULL,
  source_chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  target_revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('VIEW','AMOUNT','REASON','DONE','CANCELLED')),
  amount INTEGER CHECK(amount BETWEEN 0 AND 1000000000),
  prompt_key TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(source_chat_id,message_id) REFERENCES contributions(source_chat_id,message_id)
);
CREATE INDEX admin_sessions_actor ON admin_sessions(campaign_id,actor_id,state);

-- Durable receipts: the transition, correction, audit and reply outbox share one batch.
CREATE TABLE admin_ui_events (
  event_key TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  actor_id INTEGER NOT NULL,
  private_chat_id INTEGER NOT NULL,
  session_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('APPLIED','REJECTED')),
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX admin_ui_events_campaign ON admin_ui_events(campaign_id,created_at);
CREATE INDEX contributions_recent ON contributions(campaign_id,original_date DESC,source_chat_id,message_id DESC);
