-- Additive only: no backfill or changes to contributions/overrides.
CREATE TABLE campaign_controls (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
  silent INTEGER NOT NULL DEFAULT 0 CHECK(silent IN (0,1)),
  changed_at INTEGER,
  changed_by INTEGER,
  held_reports_through TEXT,
  notices_not_before INTEGER
);
CREATE TABLE automatic_intake_boundaries (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  chat_id INTEGER NOT NULL REFERENCES chat_aliases(chat_id),
  first_message_id INTEGER CHECK(first_message_id > 0),
  original_not_before INTEGER CHECK(original_not_before > 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  approved_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(campaign_id,chat_id),
  CHECK(first_message_id IS NOT NULL OR original_not_before IS NOT NULL)
);
ALTER TABLE notices ADD COLUMN publication_hold INTEGER NOT NULL DEFAULT 0 CHECK(publication_hold IN (0,1));
ALTER TABLE daily_reports ADD COLUMN publication_hold INTEGER NOT NULL DEFAULT 0 CHECK(publication_hold IN (0,1));
