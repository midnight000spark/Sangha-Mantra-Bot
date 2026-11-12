-- Explicitly provisioned after checking provider account + actual D1 UUID.
-- No automatic enrollment: a swapped/unprovisioned database must fail closed.
CREATE TABLE deployment_identity (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  environment TEXT NOT NULL CHECK(environment = 'test'),
  database_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  bot_id INTEGER NOT NULL CHECK(bot_id > 0),
  source_chat_ids TEXT NOT NULL,
  report_chat_id INTEGER NOT NULL CHECK(report_chat_id < 0)
);
