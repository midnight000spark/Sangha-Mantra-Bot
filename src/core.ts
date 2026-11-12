import { localDay } from "./time";
import type { Config, Contribution, ContributionEvent } from "./types";
export { eventKey, parseAmount } from "./parser";

export class DomainError extends Error {}

export async function ingest(db: D1Database, config: Config, event: ContributionEvent) {
  const nonce = crypto.randomUUID();
  const day = localDay(event.originalDate, config.timezone);
  // The decision is evaluated INSIDE the same D1 transaction as the upsert and audit.
  // A per-attempt nonce prevents replaying an old event's formerly APPLIED decision.
  await db.batch([
    db.prepare(`INSERT INTO event_log
      (event_key,nonce,update_id,source_chat_id,message_id,campaign_id,original_date,local_day,
       user_id,version_date,is_edit,source_amount,source_state,reason,outcome,old_amount,received_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,
        CASE
          WHEN c.message_id IS NULL AND ((b.first_message_id IS NOT NULL AND ? < b.first_message_id)
            OR (b.original_not_before IS NOT NULL AND ? < b.original_not_before)) THEN 'REJECTED'
          WHEN ? < ? THEN 'REJECTED'
          WHEN c.message_id IS NULL THEN 'APPLIED'
          WHEN c.original_date != ? THEN 'NEEDS_REVIEW'
          WHEN ? < c.version_date OR (? = c.version_date AND ? < c.is_edit) THEN 'IGNORED_STALE'
          WHEN ? > c.version_date OR (? = c.version_date AND ? > c.is_edit) THEN 'APPLIED'
          WHEN c.source_state = 'REVIEW' THEN 'NEEDS_REVIEW'
          WHEN c.source_amount = ? AND c.source_state = ? THEN 'UNCHANGED'
          ELSE 'NEEDS_REVIEW'
        END, COALESCE(c.effective_amount,0), ?
      FROM chat_aliases a
      LEFT JOIN automatic_intake_boundaries b ON b.chat_id=a.chat_id AND b.campaign_id=a.campaign_id
      LEFT JOIN contributions c
        ON c.source_chat_id=a.chat_id AND c.message_id=?
      WHERE a.chat_id=? AND a.campaign_id=? AND (b.chat_id IS NOT NULL OR c.message_id IS NOT NULL)
      ON CONFLICT(event_key) DO NOTHING`).bind(
      event.key,nonce,event.updateId,event.chatId,event.messageId,config.campaignId,event.originalDate,day,
      event.userId,event.versionDate,Number(event.isEdit),event.amount,event.state,event.reason,
      event.messageId,event.originalDate,day,config.startDay,event.originalDate,
      event.versionDate,event.versionDate,Number(event.isEdit),
      event.versionDate,event.versionDate,Number(event.isEdit),event.amount,event.state,event.now,
      event.messageId,event.chatId,config.campaignId),
    db.prepare(`INSERT INTO contributions
      (source_chat_id,message_id,campaign_id,original_date,local_day,user_id,source_amount,source_state,
       version_date,is_edit,last_event_key,updated_at)
      SELECT source_chat_id,message_id,campaign_id,original_date,local_day,user_id,source_amount,
        CASE WHEN outcome='NEEDS_REVIEW' THEN 'REVIEW' ELSE source_state END,
        version_date,is_edit,event_key,received_at
      FROM event_log WHERE event_key=? AND nonce=? AND outcome IN ('APPLIED','NEEDS_REVIEW')
      ON CONFLICT(source_chat_id,message_id) DO UPDATE SET
        source_amount=CASE WHEN excluded.source_state='REVIEW' THEN contributions.source_amount ELSE excluded.source_amount END,
        source_state=excluded.source_state,
        version_date=CASE WHEN excluded.source_state='REVIEW' THEN contributions.version_date ELSE excluded.version_date END,
        is_edit=CASE WHEN excluded.source_state='REVIEW' THEN contributions.is_edit ELSE excluded.is_edit END,
        last_event_key=excluded.last_event_key,updated_at=excluded.updated_at`).bind(event.key,nonce),
    db.prepare(`UPDATE event_log SET new_amount=COALESCE((SELECT effective_amount FROM contributions
      WHERE source_chat_id=event_log.source_chat_id AND message_id=event_log.message_id),0)
      WHERE event_key=? AND nonce=?`).bind(event.key,nonce),
    db.prepare(`UPDATE campaigns SET goal_reached_at=? WHERE id=? AND goal_reached_at IS NULL
      AND (SELECT COALESCE(SUM(effective_amount),0) FROM contributions WHERE campaign_id=?) >= goal`)
      .bind(event.now,config.campaignId,config.campaignId),
  ]);
  const result = await db.prepare(`SELECT e.outcome,e.reason,COALESCE(c.effective_amount,0) AS effective_amount,
      COALESCE(c.source_state,'INVALID') AS source_state FROM event_log e LEFT JOIN contributions c
      ON c.source_chat_id=e.source_chat_id AND c.message_id=e.message_id WHERE e.event_key=?`)
    .bind(event.key).first<{outcome:string;reason:string|null;effective_amount:number;source_state:string}>();
  if (!result) throw new Error("Contribution chat is not mapped or its automatic intake boundary is not provisioned");
  return result;
}

export function inspect(db: D1Database, chatId: number, messageId: number) {
  return db.prepare("SELECT * FROM contributions WHERE source_chat_id=? AND message_id=?")
    .bind(chatId,messageId).first<Contribution>();
}

export async function totals(db: D1Database, campaignId: string) {
  return (await db.prepare(`SELECT CAST(COALESCE(SUM(effective_amount),0) AS TEXT) AS total,
      COUNT(*) AS messages,COALESCE(SUM(source_state='REVIEW'),0) AS review
      FROM contributions WHERE campaign_id=?`).bind(campaignId)
    .first<{total:string;messages:number;review:number}>())!;
}

interface Adjustment {
  key: string;
  actorId: number;
  chatId: number;
  messageId: number;
  amount: number | null;
  reason: string;
  now: number;
}

export function adjustmentStatements(db: D1Database, config: Config, input: Adjustment,
  guard: { sql: string; values: (string | number | null)[] } = { sql: "1", values: [] }): D1PreparedStatement[] {
  if (!config.adminIds.includes(input.actorId) || !input.reason.trim() || input.reason.length > 1000 ||
      (input.amount !== null && (!Number.isSafeInteger(input.amount) || input.amount < 0 || input.amount > config.maxAmount))) {
    throw new DomainError("Недопустимая коррекция: проверьте число и укажите причину.");
  }
  const nonce = crypto.randomUUID();
  return [
    db.prepare(`INSERT INTO admin_adjustments
        (adjustment_key,nonce,actor_id,source_chat_id,message_id,action,amount,old_amount,reason,created_at)
      SELECT ?,?,?,?,?,?,?,effective_amount,?,? FROM contributions
      WHERE source_chat_id=? AND message_id=? AND campaign_id=?
        AND (? IS NOT NULL OR source_state!='REVIEW') AND (${guard.sql})
      ON CONFLICT(adjustment_key) DO NOTHING`)
      .bind(input.key,nonce,input.actorId,input.chatId,input.messageId,input.amount === null ? "RELEASE" : "OVERRIDE",
        input.amount,input.reason.trim(),input.now,input.chatId,input.messageId,config.campaignId,input.amount,...guard.values),
    db.prepare(`UPDATE contributions SET override_amount=?,updated_at=? WHERE source_chat_id=? AND message_id=?
      AND EXISTS(SELECT 1 FROM admin_adjustments WHERE adjustment_key=? AND nonce=?)`)
      .bind(input.amount,input.now,input.chatId,input.messageId,input.key,nonce),
    db.prepare(`UPDATE admin_adjustments SET new_amount=(SELECT effective_amount FROM contributions
      WHERE source_chat_id=admin_adjustments.source_chat_id AND message_id=admin_adjustments.message_id)
      WHERE adjustment_key=? AND nonce=?`).bind(input.key,nonce),
    db.prepare(`UPDATE campaigns SET goal_reached_at=? WHERE id=? AND goal_reached_at IS NULL
      AND (SELECT COALESCE(SUM(effective_amount),0) FROM contributions WHERE campaign_id=?) >= goal AND (${guard.sql})`)
      .bind(input.now,config.campaignId,config.campaignId,...guard.values),
  ];
}

export async function adjust(db: D1Database, config: Config, input: Adjustment) {
  await db.batch(adjustmentStatements(db, config, input));
  const audit = await db.prepare("SELECT * FROM admin_adjustments WHERE adjustment_key=?").bind(input.key).first();
  if (!audit) throw new DomainError("Message not found, or unresolved source version: use an explicit override");
  return audit;
}

/** Explicit restoration of a verified missing message; never overwrites an existing source key. */
export async function importContribution(db: D1Database, config: Config, input: Adjustment & {amount:number;originalDate:number}) {
  const day = localDay(input.originalDate, config.timezone);
  if (!config.adminIds.includes(input.actorId) || !input.reason.trim() || input.reason.length > 1000 ||
      !Number.isSafeInteger(input.amount) || input.amount < 0 || input.amount > config.maxAmount ||
      !Number.isSafeInteger(input.originalDate) || input.originalDate <= 0 || input.originalDate > input.now / 1000 || day < config.startDay) {
    throw new DomainError("Недопустимое восстановление: проверьте дату, число и причину.");
  }
  const nonce = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO contributions
      (source_chat_id,message_id,campaign_id,original_date,local_day,user_id,source_amount,source_state,
       version_date,is_edit,override_amount,last_event_key,updated_at)
      SELECT ?,?,?,?,?,NULL,0,'INVALID',?,0,?,?,? FROM chat_aliases WHERE chat_id=? AND campaign_id=?
        AND NOT EXISTS(SELECT 1 FROM admin_adjustments WHERE adjustment_key=?)
      ON CONFLICT(source_chat_id,message_id) DO NOTHING`)
      .bind(input.chatId,input.messageId,config.campaignId,input.originalDate,day,input.originalDate,
        input.amount,nonce,input.now,input.chatId,config.campaignId,input.key),
    db.prepare(`INSERT INTO admin_adjustments
      (adjustment_key,nonce,actor_id,source_chat_id,message_id,action,amount,old_amount,new_amount,reason,created_at)
      SELECT ?,?,?,source_chat_id,message_id,'IMPORT',?,0,effective_amount,?,? FROM contributions
      WHERE source_chat_id=? AND message_id=? AND last_event_key=?
      ON CONFLICT(adjustment_key) DO NOTHING`)
      .bind(input.key,nonce,input.actorId,input.amount,input.reason.trim(),input.now,input.chatId,input.messageId,nonce),
    db.prepare(`UPDATE campaigns SET goal_reached_at=? WHERE id=? AND goal_reached_at IS NULL
      AND (SELECT COALESCE(SUM(effective_amount),0) FROM contributions WHERE campaign_id=?) >= goal`)
      .bind(input.now,config.campaignId,config.campaignId),
  ]);
  const audit = await db.prepare("SELECT * FROM admin_adjustments WHERE adjustment_key=?").bind(input.key).first();
  if (!audit) throw new DomainError("Message already exists or chat is not allowed; inspect it before correcting");
  return audit;
}
