CREATE TABLE operational_events (
  event_key TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  update_id INTEGER,
  kind TEXT NOT NULL,
  actor_id INTEGER,
  source_chat_id INTEGER,
  message_id INTEGER,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX operational_events_campaign_time ON operational_events(campaign_id, created_at);

CREATE TABLE notices (
  notice_key TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  chat_id INTEGER NOT NULL,
  reply_message_id INTEGER,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','SENDING','SENT','FAILED_KNOWN','UNCERTAIN')),
  claim_token TEXT,
  claimed_at INTEGER,
  sent_message_id INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  resolved_by INTEGER,
  resolved_at INTEGER,
  resolution_reason TEXT
);
CREATE INDEX notices_pending ON notices(state,created_at);

CREATE TABLE recovery_state (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
  restored_at INTEGER NOT NULL,
  backup_at INTEGER NOT NULL,
  reconciled_at INTEGER,
  reconciled_by INTEGER,
  reason TEXT NOT NULL
);

CREATE TABLE bot_membership (
  chat_id INTEGER PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  status TEXT NOT NULL,
  can_send_messages INTEGER,
  event_date INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE system_heartbeat (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
  last_cron_at INTEGER,
  last_webhook_at INTEGER
);
