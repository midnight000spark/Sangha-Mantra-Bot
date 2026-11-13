-- EXAMPLE ONLY. All resource identities and message IDs are synthetic.
-- Review your real Telegram enrollment boundary and approved target before applying.
-- Apply migration 0007 first. This file never updates existing boundaries or contributions.
INSERT INTO automatic_intake_boundaries
  (campaign_id,chat_id,first_message_id,original_not_before,reason,approved_by,created_at)
SELECT 'sangha-production',-1001234567891,1001,NULL,
  'Example: first automatically eligible message verified by the responsible operator',
  876543210,unixepoch()*1000
WHERE EXISTS(SELECT 1 FROM production_deployment_identity WHERE singleton=1 AND environment='production'
  AND campaign_id='sangha-production' AND database_id='66666666-7777-4888-8999-aaaaaaaaaaaa'
  AND bot_id=999000111 AND source_chat_ids='-1001234567891' AND report_chat_id=-1001234567891)
  AND EXISTS(SELECT 1 FROM chat_aliases WHERE campaign_id='sangha-production' AND chat_id=-1001234567891)
ON CONFLICT(campaign_id,chat_id) DO NOTHING;
SELECT campaign_id,chat_id,first_message_id,original_not_before,reason FROM automatic_intake_boundaries;
