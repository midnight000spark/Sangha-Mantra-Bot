import type { Config } from "./types";
import { latestReportDay } from "./time";

export async function silenceState(db: D1Database, campaignId: string) {
  return await db.prepare("SELECT silent,changed_at,changed_by,held_reports_through,notices_not_before FROM campaign_controls WHERE campaign_id=?")
    .bind(campaignId).first<{ silent: number; changed_at: number | null; changed_by: number | null; held_reports_through: string | null; notices_not_before: number | null }>()
    ?? { silent: 0, changed_at: null, changed_by: null, held_reports_through: null, notices_not_before: null };
}

export interface SilentCommandSource {
  sentAt: number; // Original Telegram message.date * 1000, never receipt time.
  chatId: number;
  messageId: number;
}

/** Source order, receipt, policy and holds commit together. */
export async function setSilence(db: D1Database, config: Config, on: boolean, actor: number, key: string, now: number, source: SilentCommandSource) {
  if (!config.adminIds.includes(actor)) throw new Error("Administrator is not authorized");
  if (!Number.isSafeInteger(source.sentAt) || source.sentAt <= 0 || source.chatId !== actor
    || !Number.isSafeInteger(source.messageId) || source.messageId <= 0) throw new Error("Invalid private command source");
  const nonce = crypto.randomUUID();
  const receiptGate = "EXISTS(SELECT 1 FROM operational_events WHERE event_key=? AND json_extract(detail,'$.nonce')=?)";
  const gate = "EXISTS(SELECT 1 FROM campaign_silent_watermarks WHERE campaign_id=? AND nonce=?)";
  // At the latest source time, each admin's highest message ID wins; any
  // remaining ON dominates OFF from other admins. Keeping all admin watermarks
  // avoids losing A's ON when B sends ON then OFF in the same second.
  const desired = `SELECT MAX(silent) FROM campaign_silent_watermarks WHERE campaign_id=?
    AND command_at=(SELECT MAX(command_at) FROM campaign_silent_watermarks WHERE campaign_id=?)`;
  const through = latestReportDay(now, config.timezone, config.reportTime);
  await db.batch([
    db.prepare(`INSERT INTO operational_events(event_key,campaign_id,kind,actor_id,source_chat_id,message_id,detail,created_at)
      VALUES(?,?,'SILENT_CHANGE',?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`)
      .bind(key, config.campaignId, actor, source.chatId, source.messageId, JSON.stringify({ on, nonce, sentAt: source.sentAt }), now),
    db.prepare(`INSERT INTO campaign_silent_watermarks(campaign_id,actor_id,source_chat_id,command_at,message_id,silent,nonce)
      SELECT ?,?,?,?,?,?,? WHERE ${receiptGate}
        AND NOT EXISTS(SELECT 1 FROM campaign_silent_watermarks WHERE campaign_id=? AND command_at>?)
        AND NOT EXISTS(SELECT 1 FROM recovery_state WHERE campaign_id=? AND restored_at>=?)
      ON CONFLICT(campaign_id,actor_id,source_chat_id) DO UPDATE SET command_at=excluded.command_at,
        message_id=excluded.message_id,silent=excluded.silent,nonce=excluded.nonce
      WHERE excluded.command_at>campaign_silent_watermarks.command_at
        OR (excluded.command_at=campaign_silent_watermarks.command_at AND excluded.message_id>campaign_silent_watermarks.message_id)`)
      .bind(config.campaignId, actor, source.chatId, source.sentAt, source.messageId, Number(on), nonce,
        key, nonce, config.campaignId, source.sentAt, config.campaignId, source.sentAt),
    db.prepare(`INSERT INTO campaign_controls(campaign_id,silent,changed_at,changed_by,held_reports_through,notices_not_before)
      SELECT ?,(${desired}),?,?,NULL,NULL WHERE ${gate}
      ON CONFLICT(campaign_id) DO UPDATE SET silent=excluded.silent,changed_at=excluded.changed_at,changed_by=excluded.changed_by,
        held_reports_through=CASE WHEN excluded.silent=0 THEN MAX(COALESCE(campaign_controls.held_reports_through,''),?)
          ELSE campaign_controls.held_reports_through END,
        notices_not_before=CASE WHEN excluded.silent=0 THEN excluded.changed_at ELSE campaign_controls.notices_not_before END
      WHERE campaign_controls.silent<>excluded.silent`)
      .bind(config.campaignId, config.campaignId, config.campaignId, now, actor, config.campaignId, nonce, through),
    // Include SENDING: the final pre-send gate will release a claimed but unstarted request.
    db.prepare(`UPDATE notices SET publication_hold=1 WHERE campaign_id=? AND chat_id<0 AND state<>'SENT'
      AND ?=1 AND ${gate}`).bind(config.campaignId, Number(on), config.campaignId, nonce),
    db.prepare(`UPDATE daily_reports SET publication_hold=1 WHERE campaign_id=? AND status<>'SENT'
      AND ?=1 AND ${gate}`).bind(config.campaignId, Number(on), config.campaignId, nonce),
    db.prepare(`UPDATE operational_events SET detail=json_set(detail,'$.accepted',CASE WHEN ${gate} THEN 1 ELSE 0 END)
      WHERE event_key=? AND json_extract(detail,'$.nonce')=?`).bind(config.campaignId, nonce, key, nonce),
  ]);
  return silenceState(db, config.campaignId);
}

/** Intentionally held, never-attempted reports have no UNCERTAIN resolution to reuse. */
export async function releaseHeldReport(db: D1Database, config: Config, day: string, actor: number, key: string, reason: string, now: number) {
  if (!config.adminIds.includes(actor)) throw new Error("Administrator is not authorized");
  const nonce = crypto.randomUUID();
  const rows = await db.batch([
    db.prepare(`INSERT INTO operational_events(event_key,campaign_id,kind,actor_id,detail,created_at)
      SELECT ?,?,'HELD_REPORT_RELEASE',?,?,? WHERE EXISTS(SELECT 1 FROM daily_reports
        WHERE campaign_id=? AND day=? AND status='PENDING' AND publication_hold=1)
        AND NOT EXISTS(SELECT 1 FROM campaign_controls WHERE campaign_id=? AND silent=1)
        AND NOT EXISTS(SELECT 1 FROM report_resolutions WHERE idempotency_key=?)
      ON CONFLICT(event_key) DO NOTHING`)
      .bind(key, config.campaignId, actor, JSON.stringify({ day, reason, nonce }), now, config.campaignId, day, config.campaignId, key),
    db.prepare(`UPDATE daily_reports SET publication_hold=0,updated_at=? WHERE campaign_id=? AND day=? AND status='PENDING'
      AND EXISTS(SELECT 1 FROM operational_events WHERE event_key=? AND json_extract(detail,'$.nonce')=?) RETURNING day`)
      .bind(now, config.campaignId, day, key, nonce),
  ]);
  return (rows[1]?.results.length ?? 0) > 0;
}
