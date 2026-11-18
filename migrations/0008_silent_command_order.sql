-- Per-private-admin source order, independent of webhook receipts/arrival time.
CREATE TABLE campaign_silent_watermarks (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  actor_id INTEGER NOT NULL,
  source_chat_id INTEGER NOT NULL,
  command_at INTEGER NOT NULL CHECK(command_at > 0),
  message_id INTEGER NOT NULL CHECK(message_id >= 0),
  silent INTEGER NOT NULL CHECK(silent IN (0,1)),
  nonce TEXT NOT NULL,
  PRIMARY KEY(campaign_id,actor_id,source_chat_id)
);

-- Legacy receipts have no source date. Preserve the existing policy behind a
-- conservative same-second barrier, using the last known processing time.
-- Actor/chat 0 is a sentinel: only a strictly later source second supersedes it.
INSERT INTO campaign_silent_watermarks(campaign_id,actor_id,source_chat_id,command_at,message_id,silent,nonce)
SELECT c.campaign_id,0,0,
  (MAX(c.changed_at,COALESCE((SELECT MAX(e.created_at) FROM operational_events e
    WHERE e.campaign_id=c.campaign_id AND e.kind='SILENT_CHANGE'),c.changed_at))/1000)*1000,
  0,c.silent,'legacy'
FROM campaign_controls c WHERE c.changed_at IS NOT NULL;
