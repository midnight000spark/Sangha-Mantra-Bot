-- Read-only. Future remote use requires separate owner approval + verified TEST config.
-- Full private receipt; do not publish real actor/chat/message IDs without redaction.
-- Q0: actual schema/migration ledger/identity and inclusive source boundary.
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
SELECT id,name FROM d1_migrations ORDER BY id;
SELECT * FROM deployment_identity;
SELECT * FROM campaigns WHERE id='sangha-a06-native-test';
SELECT * FROM chat_aliases WHERE campaign_id='sangha-a06-native-test';
SELECT * FROM automatic_intake_boundaries WHERE campaign_id='sangha-a06-native-test';
-- Q1: authoritative exact totals; preserve NULL vs zero.
SELECT COUNT(*) AS rows,CAST(COALESCE(SUM(effective_amount),0) AS TEXT) AS total,
 SUM(CASE WHEN override_amount=0 THEN 1 ELSE 0 END) AS zero_overrides
 FROM contributions WHERE campaign_id='sangha-a06-native-test';
-- Q2: source message/version/admission/current value (bounded by isolated TEST corpus).
SELECT source_chat_id,message_id,original_date,local_day,version_date,is_edit,
 source_amount,source_state,override_amount,effective_amount,last_event_key
 FROM contributions WHERE campaign_id='sangha-a06-native-test' ORDER BY source_chat_id,message_id;
-- Q3: durable ingest receipts; no raw human text.
SELECT event_key,update_id,source_chat_id,message_id,original_date,version_date,is_edit,
 outcome,old_amount,new_amount,received_at
 FROM event_log WHERE campaign_id='sangha-a06-native-test' ORDER BY received_at,event_key;
-- Q4: corrections, scoped via contribution key.
SELECT a.adjustment_key,a.actor_id,a.source_chat_id,a.message_id,a.action,a.amount,
 a.old_amount,a.new_amount,a.created_at
 FROM admin_adjustments a JOIN contributions c USING(source_chat_id,message_id)
 WHERE c.campaign_id='sangha-a06-native-test' ORDER BY a.created_at,a.adjustment_key;
-- Q5: final send states, source fence and claims; no body/reply_markup.
SELECT notice_key,chat_id,reply_message_id,state,publication_hold,source_event_key,
 claim_token,claimed_at,sent_message_id,last_error,created_at,resolved_by,resolved_at
 FROM notices WHERE campaign_id='sangha-a06-native-test' ORDER BY created_at,notice_key;
-- Q6: immutable report snapshots, attempts and resolutions.
SELECT day,timezone,period_start,period_end,snapshot_at,CAST(day_total AS TEXT) AS day_total,
 CAST(total AS TEXT) AS total,CAST(correction AS TEXT) AS correction,status,publication_hold,
 attempt_token,lease_until,attempt_count,retry_after,telegram_message_id,target_chat_id,
 reconstructed_after_restore,last_error
 FROM daily_reports WHERE campaign_id='sangha-a06-native-test' ORDER BY day;
SELECT * FROM report_audit WHERE campaign_id='sangha-a06-native-test' ORDER BY id;
SELECT idempotency_key,day,at,admin_id,action,telegram_message_id,previous_state
 FROM report_resolutions WHERE campaign_id='sangha-a06-native-test' ORDER BY at;
-- Q7: policy != source ordering; inspect both.
SELECT * FROM campaign_controls WHERE campaign_id='sangha-a06-native-test';
SELECT * FROM campaign_silent_watermarks WHERE campaign_id='sangha-a06-native-test'
 ORDER BY actor_id,source_chat_id;
-- Q8: UI receipts and operational evidence, excluding raw diagnostic detail.
SELECT id,actor_id,private_chat_id,source_chat_id,message_id,target_revision,state,amount,
 created_at,expires_at FROM admin_sessions WHERE campaign_id='sangha-a06-native-test' ORDER BY created_at;
SELECT event_key,actor_id,session_id,action,outcome,created_at FROM admin_ui_events
 WHERE campaign_id='sangha-a06-native-test' ORDER BY created_at,event_key;
SELECT event_key,update_id,kind,actor_id,source_chat_id,message_id,created_at
 FROM operational_events WHERE campaign_id='sangha-a06-native-test' ORDER BY created_at,event_key;
-- Q9: heartbeat alone does not prove a provider scheduled invocation.
SELECT * FROM system_heartbeat WHERE campaign_id='sangha-a06-native-test';
SELECT * FROM bot_membership WHERE campaign_id='sangha-a06-native-test';
-- Q10: publication recovery gate and foreign-key health.
SELECT campaign_id,restored_at,backup_at,reconciled_at,reconciled_by FROM recovery_state
 WHERE campaign_id='sangha-a06-native-test';
PRAGMA foreign_key_check;
