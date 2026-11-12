import { releaseHeldReport } from "./controls";
import { sendTelegramMessage } from "./telegram";
import { addDays, dayBounds, latestReportDay, localDay } from "./time";
import type { Config } from "./types";

const REPORTS_PER_RUN = 7;
const SEND_LEASE_MS = 120_000;

export interface DailyReport {
  campaign_id: string;
  day: string;
  timezone: string;
  period_start: number;
  period_end: number;
  snapshot_at: number;
  day_total: string;
  total: string;
  correction: string;
  goal: string;
  target_chat_id: number;
  reconstructed_after_restore: number;
  body: string | null;
  status: "PENDING" | "SENDING" | "SENT" | "UNCERTAIN" | "FAILED_KNOWN";
  telegram_message_id: number | null;
}

// D1 maps SQL INTEGER to Number. Decimal text preserves exact aggregated INT64 values.
const reportColumns = `campaign_id, day, timezone, period_start, period_end, snapshot_at,
  CAST(day_total AS TEXT) AS day_total, CAST(total AS TEXT) AS total,
  CAST(correction AS TEXT) AS correction, CAST(goal AS TEXT) AS goal,
  target_chat_id, reconstructed_after_restore, body, status, telegram_message_id`;

export function formatReport(report: DailyReport): string {
  const total = BigInt(report.total);
  const goal = BigInt(report.goal);
  const correction = BigInt(report.correction);
  const remaining = total >= goal ? 0n : goal - total;
  const percentageTenths = total * 1000n / goal;
  const date = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC", year: "numeric", month: "long", day: "numeric",
  }).format(new Date(`${report.day}T00:00:00Z`));
  const number = new Intl.NumberFormat("ru-RU");
  const lines = [
    "Накопление мантр для подношения Гуру",
    `Итоги за ${date}`,
    `За сутки: ${number.format(BigInt(report.day_total))}`,
    `Всего к концу этих суток: ${number.format(total)}`,
    `Осталось до ${number.format(goal)}: ${number.format(remaining)}`,
    `Прогресс: ${number.format(percentageTenths / 10n)},${percentageTenths % 10n}%`,
  ];
  if (correction !== 0n) {
    lines.push(`Поправки к ранее учтённым дням: ${correction > 0n ? "+" : ""}${number.format(correction)}`);
  }
  if (total >= goal) lines.push("Цель достигнута. Продолжаем учитывать накопления.");
  if (report.reconstructed_after_restore) {
    lines.push("Снимок составлен после восстановления базы и сверки данных.");
  }
  return lines.join("\n");
}

/** Persist bounded chronological catchup; MAX(day) is the durable progress marker. */
export async function runReports(
  db: D1Database,
  config: Config,
  token: string,
  nowMs = Date.now(),
  send: typeof sendTelegramMessage = sendTelegramMessage,
): Promise<{ created: number; sent: number; uncertain: number; failed: number; paused: boolean }> {
  const startedAt = Date.now();
  const clock = () => nowMs + Date.now() - startedAt;
  const result = { created: 0, sent: 0, uncertain: 0, failed: 0, paused: false };
  // The request may have reached Telegram before the Worker died. Never reacquire it.
  const expired = await db.prepare(`UPDATE daily_reports SET status = 'UNCERTAIN',
    last_error = 'Sending lease expired; check the Telegram chat before retrying', updated_at = ?
    WHERE campaign_id = ? AND status = 'SENDING' AND lease_until <= ?`)
    .bind(clock(), config.campaignId, clock()).run();
  result.uncertain += expired.meta.changes;

  const recovery = await db.prepare(`SELECT r.restored_at,r.reconciled_at,
    EXISTS(SELECT 1 FROM chat_aliases a WHERE a.campaign_id=c.campaign_id AND NOT EXISTS(
      SELECT 1 FROM automatic_intake_boundaries b WHERE b.campaign_id=a.campaign_id AND b.chat_id=a.chat_id)) boundary_missing
    FROM (SELECT ? campaign_id) c LEFT JOIN recovery_state r ON r.campaign_id=c.campaign_id`).bind(config.campaignId)
    .first<{ restored_at: number | null; reconciled_at: number | null; boundary_missing: number }>();
  if (recovery?.boundary_missing || (recovery?.restored_at != null && recovery.reconciled_at === null)) return { ...result, paused: true };
  // A report absent from an old backup may have been published after that backup.
  const restorationDay = recovery?.restored_at != null ? localDay(recovery.restored_at / 1000, config.timezone) : null;

  const last = await db.prepare(`SELECT MAX(day) AS day FROM daily_reports WHERE campaign_id = ?`)
    .bind(config.campaignId).first<{ day: string | null }>();
  let day = last?.day ? addDays(last.day, 1) : config.startDay;
  const eligibleDay = latestReportDay(nowMs, config.timezone, config.reportTime);
  const snapshots: D1PreparedStatement[] = [];
  const reconstructed: boolean[] = [];
  for (let count = 0; day <= eligibleDay && count < REPORTS_PER_RUN; count++, day = addDays(day, 1)) {
    const { start, end } = dayBounds(day, config.timezone);
    // All sums and the previous immutable snapshot are read in one atomic statement.
    snapshots.push(db.prepare(`INSERT OR IGNORE INTO daily_reports
      (campaign_id, day, timezone, period_start, period_end, snapshot_at,
       day_total, total, correction, goal, target_chat_id, reconstructed_after_restore, status, updated_at, publication_hold)
      SELECT ?, ?, ?, ?, ?, ?,
        COALESCE(SUM(CASE WHEN original_date >= ? THEN effective_amount ELSE 0 END), 0),
        COALESCE(SUM(effective_amount), 0),
        COALESCE(SUM(CASE WHEN original_date < ? THEN effective_amount ELSE 0 END), 0)
          - COALESCE((SELECT total FROM daily_reports WHERE campaign_id = ? AND day = ?), 0),
        ?, (SELECT report_chat_id FROM campaigns WHERE id = ?), ?, ?, ?,
        CASE WHEN EXISTS(SELECT 1 FROM campaign_controls WHERE campaign_id=? AND (silent=1 OR held_reports_through>=?)) THEN 1 ELSE 0 END
      FROM contributions WHERE campaign_id = ? AND original_date < ?
      HAVING ? = ? OR EXISTS (SELECT 1 FROM daily_reports WHERE campaign_id = ? AND day = ?)`)
      .bind(config.campaignId, day, config.timezone, start, end, clock(), start, start,
        config.campaignId, addDays(day, -1), config.goal, config.campaignId,
        restorationDay !== null && day < restorationDay ? 1 : 0,
        restorationDay !== null && day < restorationDay ? "UNCERTAIN" : "PENDING", clock(), config.campaignId, day,
        config.campaignId, end, day, config.startDay, config.campaignId, addDays(day, -1)));
    reconstructed.push(restorationDay !== null && day < restorationDay);
  }

  if (snapshots.length) {
    const inserted = await db.batch(snapshots);
    inserted.forEach((row, index) => {
      result.created += row.meta.changes;
      if (reconstructed[index]) result.uncertain += row.meta.changes;
    });
  }
  const pending = await db.prepare(`SELECT ${reportColumns} FROM daily_reports
    WHERE campaign_id = ? AND publication_hold=0 AND (status = 'PENDING'
      OR (status = 'FAILED_KNOWN' AND retry_after IS NOT NULL AND retry_after <= ?))
    ORDER BY day LIMIT ?`).bind(config.campaignId, clock(), REPORTS_PER_RUN).all<DailyReport>();
  for (const report of pending.results) {
    const attempt = crypto.randomUUID();
    const claimTime = clock();
    // RETURNING identifies the winner. Read-then-update alone would allow two senders.
    const claimed = await db.prepare(`UPDATE daily_reports SET status = 'SENDING',
      body = COALESCE(body, ?), attempt_token = ?, lease_until = ?,
      target_chat_id = (SELECT report_chat_id FROM campaigns WHERE id = daily_reports.campaign_id),
      attempt_count = attempt_count + 1, retry_after = NULL, last_error = NULL, updated_at = ?
      WHERE campaign_id = ? AND day = ? AND publication_hold=0 AND (status = 'PENDING'
        OR (status = 'FAILED_KNOWN' AND retry_after IS NOT NULL AND retry_after <= ?))
        AND NOT EXISTS (SELECT 1 FROM recovery_state WHERE campaign_id = ? AND reconciled_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM campaign_controls WHERE campaign_id = ? AND silent=1)
      RETURNING ${reportColumns}`)
      .bind(report.body ?? formatReport(report), attempt, claimTime + SEND_LEASE_MS, claimTime,
        config.campaignId, report.day, claimTime, config.campaignId, config.campaignId).first<DailyReport>();
    if (!claimed) continue;

    const permitted = await db.prepare(`SELECT 1 FROM daily_reports WHERE campaign_id=? AND day=? AND status='SENDING'
      AND attempt_token=? AND publication_hold=0
      AND NOT EXISTS(SELECT 1 FROM campaign_controls WHERE campaign_id=? AND silent=1)
      AND NOT EXISTS(SELECT 1 FROM recovery_state WHERE campaign_id=? AND reconciled_at IS NULL)`)
      .bind(config.campaignId, report.day, attempt, config.campaignId, config.campaignId).first();
    if (!permitted) {
      await db.prepare(`UPDATE daily_reports SET status='PENDING',publication_hold=1,attempt_token=NULL,lease_until=NULL,updated_at=?
        WHERE campaign_id=? AND day=? AND status='SENDING' AND attempt_token=?`)
        .bind(clock(), config.campaignId, report.day, attempt).run();
      result.paused = true;
      continue;
    }
    const outcome = await send(token, claimed.target_chat_id, claimed.body!);
    const finishedAt = clock();
    if (outcome.state === "SENT") {
      await db.prepare(`UPDATE daily_reports SET status = 'SENT', telegram_message_id = ?,
        lease_until = NULL, updated_at = ?
        WHERE campaign_id = ? AND day = ? AND status = 'SENDING' AND attempt_token = ?`)
        .bind(outcome.messageId, finishedAt, config.campaignId, report.day, attempt).run();
      result.sent++;
    } else {
      const retryAfter = outcome.state === "FAILED_KNOWN" && outcome.retryAfterSeconds !== undefined
        ? finishedAt + Math.max(outcome.retryAfterSeconds, 1) * 1000 : null;
      await db.prepare(`UPDATE daily_reports SET status = ?, last_error = ?,
        lease_until = NULL, retry_after = ?, updated_at = ?
        WHERE campaign_id = ? AND day = ? AND status = 'SENDING' AND attempt_token = ?`)
        .bind(outcome.state, outcome.error, retryAfter, finishedAt, config.campaignId, report.day, attempt).run();
      if (outcome.state === "UNCERTAIN") result.uncertain++;
      else result.failed++;
    }
  }
  return result;
}

export async function resolveReport(
  db: D1Database,
  config: Config,
  resolution: {
    day: string;
    action: "confirm_sent" | "retry";
    messageId?: number;
    adminId: number;
    reason: string;
    idempotencyKey: string;
  },
  nowMs = Date.now(),
): Promise<boolean> {
  if (!config.adminIds.includes(resolution.adminId)) throw new Error("Administrator is not authorized");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(resolution.day)
    || !resolution.reason.trim() || resolution.reason.length > 1000
    || !resolution.idempotencyKey || resolution.idempotencyKey.length > 200
    || (resolution.action !== "confirm_sent" && resolution.action !== "retry")
    || (resolution.action === "confirm_sent" && (!Number.isSafeInteger(resolution.messageId) || resolution.messageId! <= 0))
    || (resolution.action === "retry" && resolution.messageId !== undefined)) {
    return false;
  }
  if (resolution.action === "retry" && await releaseHeldReport(db, config, resolution.day, resolution.adminId,
    resolution.idempotencyKey, resolution.reason, nowMs)) return true;
  // The trigger applies the resolution in the same statement as its durable audit entry.
  const applied = await db.batch([db.prepare(`INSERT OR IGNORE INTO report_resolutions
    (idempotency_key, campaign_id, day, at, admin_id, action, reason, telegram_message_id, previous_state)
    SELECT ?, campaign_id, day, ?, ?, ?, ?, ?, status FROM daily_reports
    WHERE campaign_id = ? AND day = ? AND status IN ('UNCERTAIN', 'FAILED_KNOWN')
      AND (?='confirm_sent' OR NOT EXISTS(SELECT 1 FROM campaign_controls WHERE campaign_id=? AND silent=1))
      AND NOT EXISTS(SELECT 1 FROM operational_events WHERE event_key=?)`)
    .bind(resolution.idempotencyKey, nowMs, resolution.adminId, resolution.action,
      resolution.reason.trim(), resolution.messageId ?? null, config.campaignId, resolution.day, resolution.action, config.campaignId, resolution.idempotencyKey),
    db.prepare(`UPDATE daily_reports SET publication_hold=0 WHERE campaign_id=? AND day=? AND changes()=1`)
      .bind(config.campaignId, resolution.day),
  ]);
  return (applied[0]?.meta.changes ?? 0) > 0;
}
