-- Provision only after checking the actual newly created production D1 UUID.
CREATE TABLE production_deployment_identity (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  environment TEXT NOT NULL CHECK(environment = 'production'),
  database_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  bot_id INTEGER NOT NULL CHECK(bot_id > 0),
  source_chat_ids TEXT NOT NULL,
  report_chat_id INTEGER NOT NULL CHECK(report_chat_id < 0)
);
