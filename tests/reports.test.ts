import { describe, expect, test } from "bun:test";
import { formatReport, resolveReport, runReports, type DailyReport } from "../src/reports";
import type { SendResult } from "../src/telegram";
import { localDay } from "../src/time";
import { createTestDb, testConfig } from "./db";

const config = { ...testConfig, startDay: "2026-11-10" };
const firstRun = Date.parse("2026-11-10T21:05:00Z");
const nextRun = Date.parse("2026-11-11T21:05:00Z");

async function fixture() {
  const db = await createTestDb();
  await db.prepare(`INSERT INTO campaigns(id, timezone, start_day, goal, report_chat_id)
    VALUES (?, ?, ?, ?, ?)`).bind(config.campaignId, config.timezone, config.startDay, config.goal, config.reportChatId).run();
  await db.prepare(`INSERT INTO chat_aliases(chat_id,campaign_id) VALUES (?,?)`)
    .bind(config.allowedChatIds[0]!, config.campaignId).run();
  return db;
}

async function contribute(db: D1Database, id: number, at: string, amount: number) {
  const date = Date.parse(at) / 1000;
  await db.prepare(`INSERT INTO contributions(source_chat_id,message_id,campaign_id,original_date,
    local_day,source_amount,source_state,version_date,is_edit,last_event_key,updated_at)
    VALUES (?,?,?,?,?,?,'VALID',?,0,?,?)`)
    .bind(config.allowedChatIds[0]!, id, config.campaignId, date, localDay(date, config.timezone), amount,
      date, `fixture-${id}`, date * 1000).run();
}

const sent = async (): Promise<SendResult> => ({ state: "SENT", messageId: 101 });
const uncertain = async (): Promise<SendResult> => ({ state: "UNCERTAIN", error: "Response lost after delivery" });

describe("daily report snapshot and outbox", () => {
  test("snapshot excludes the next local day and a repeated Cron never resends SENT", async () => {
    const db = await fixture();
    await contribute(db, 1, "2026-11-10T20:59:59Z", 108);
    await contribute(db, 2, "2026-11-10T21:00:00Z", 999);
    const texts: string[] = [];
    const send = async (_token: string, _chat: string | number, body: string) => { texts.push(body); return sent(); };
    expect(await runReports(db, config, "test", firstRun, send)).toMatchObject({ created: 1, sent: 1 });
    await runReports(db, config, "test", firstRun + 60_000, send);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("За сутки: 108");
    expect(texts[0]).toContain("Всего к концу этих суток: 108");
    expect((await db.prepare("SELECT total,day_total,telegram_message_id,status FROM daily_reports").first()))
      .toEqual({ total: 108, day_total: 108, telegram_message_id: 101, status: "SENT" });
  });

  test("late edits stay out of frozen history and appear as next report corrections", async () => {
    const db = await fixture();
    await contribute(db, 1, "2026-11-10T10:00:00Z", 108);
    await runReports(db, config, "test", firstRun, sent);
    const before = await db.prepare("SELECT body FROM daily_reports WHERE day='2026-11-10'").first("body");
    await db.prepare("UPDATE contributions SET source_amount=208 WHERE message_id=1").run();
    await contribute(db, 2, "2026-11-11T10:00:00Z", 50);
    await runReports(db, config, "test", nextRun, sent);
    expect(await db.prepare("SELECT body FROM daily_reports WHERE day='2026-11-10'").first("body")).toBe(before);
    expect(await db.prepare("SELECT total,day_total,correction FROM daily_reports WHERE day='2026-11-11'").first())
      .toEqual({ total: 258, day_total: 50, correction: 100 });
    expect(await db.prepare("SELECT body FROM daily_reports WHERE day='2026-11-11'").first("body"))
      .toContain("Поправки к ранее учтённым дням: +100");
    await expect(db.prepare("UPDATE daily_reports SET total=0 WHERE day='2026-11-10'").run())
      .rejects.toThrow("Report snapshots are immutable");
  });

  test("parallel Cron invocations have exactly one SQL claim winner", async () => {
    const db = await fixture();
    let sends = 0;
    const send = async () => { sends++; await Promise.resolve(); return sent(); };
    await Promise.all([runReports(db, config, "test", firstRun, send), runReports(db, config, "test", firstRun, send)]);
    expect(sends).toBe(1);
    expect(await db.prepare("SELECT attempt_count FROM daily_reports").first("attempt_count")).toBe(1);
  });

  test("lost Telegram response remains UNCERTAIN until an audited admin resolution", async () => {
    const db = await fixture();
    let sends = 0;
    await runReports(db, config, "test", firstRun, async () => { sends++; return uncertain(); });
    await runReports(db, config, "test", firstRun + 180_000, async () => { sends++; return sent(); });
    expect(sends).toBe(1);
    expect(await db.prepare("SELECT status FROM daily_reports").first("status")).toBe("UNCERTAIN");
    const resolution = { day: "2026-11-10", action: "confirm_sent" as const, messageId: 812,
      adminId: 42, reason: "Report verified in chat", idempotencyKey: "resolution-1" };
    expect(await resolveReport(db, config, resolution, firstRun + 200_000)).toBe(true);
    expect(await resolveReport(db, config, resolution, firstRun + 201_000)).toBe(false);
    expect(await db.prepare("SELECT status,telegram_message_id FROM daily_reports").first())
      .toEqual({ status: "SENT", telegram_message_id: 812 });
    expect(await db.prepare("SELECT reason,admin_id,previous_state FROM report_resolutions").first())
      .toEqual({ reason: "Report verified in chat", admin_id: 42, previous_state: "UNCERTAIN" });
  });

  test("crashed SENDING lease becomes UNCERTAIN without a second request", async () => {
    const db = await fixture();
    await runReports(db, config, "test", firstRun, uncertain);
    await db.prepare("UPDATE daily_reports SET status='SENDING', lease_until=?, attempt_token='crashed'")
      .bind(firstRun - 1).run();
    let sends = 0;
    await runReports(db, config, "test", firstRun + 1, async () => { sends++; return sent(); });
    expect(sends).toBe(0);
    expect(await db.prepare("SELECT status FROM daily_reports").first("status")).toBe("UNCERTAIN");
  });

  test("only a proven 429 failure with retry_after is retried automatically", async () => {
    const db = await fixture();
    await runReports(db, config, "test", firstRun,
      async () => ({ state: "FAILED_KNOWN", error: "429", retryAfterSeconds: 60 }));
    expect((await runReports(db, config, "test", firstRun + 1_000, sent)).sent).toBe(0);
    expect((await runReports(db, config, "test", firstRun + 61_000, sent)).sent).toBe(1);
    const other = await fixture();
    await runReports(other, config, "test", firstRun, async () => ({ state: "FAILED_KNOWN", error: "403" }));
    expect((await runReports(other, config, "test", firstRun + 3600_000, sent)).sent).toBe(0);
  });

  test("catchup persists progress over bounded runs and includes empty days", async () => {
    const db = await fixture();
    const afterGap = Date.parse("2026-11-20T21:05:00Z");
    expect((await runReports(db, config, "test", afterGap, sent)).created).toBe(7);
    expect((await runReports(db, config, "test", afterGap + 1000, sent)).created).toBe(4);
    expect((await runReports(db, config, "test", afterGap + 2000, sent)).created).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) FROM daily_reports WHERE status='SENT'").first("COUNT(*)")).toBe(11);
  });

  test("a safe retry uses the migrated report destination and audits both attempts", async () => {
    const db = await fixture();
    await runReports(db, config, "test", firstRun, async () => ({ state: "FAILED_KNOWN", error: "400 migrated chat" }));
    await db.prepare("UPDATE campaigns SET report_chat_id=-10099 WHERE id=?").bind(config.campaignId).run();
    await resolveReport(db, config, { day: "2026-11-10", action: "retry", adminId: 42,
      reason: "Report chat migrated", idempotencyKey: "migration-retry" });
    const chats: (string | number)[] = [];
    await runReports(db, config, "test", firstRun + 1000, async (_token, chatId) => { chats.push(chatId); return sent(); });
    expect(chats).toEqual([-10099]);
    expect((await db.prepare("SELECT target_chat_id FROM report_audit WHERE to_state='SENDING' ORDER BY id").all()).results)
      .toEqual([{ target_chat_id: config.reportChatId }, { target_chat_id: -10099 }]);
  });

  test("restoration pauses publication; missing old reports remain uncertain after reconciliation", async () => {
    const db = await fixture();
    await db.prepare(`INSERT INTO recovery_state(campaign_id,restored_at,backup_at,reason) VALUES (?,?,?,?)`)
      .bind(config.campaignId, firstRun - 180_000, firstRun - 86400_000, "Restore drill").run();
    expect((await runReports(db, config, "test", firstRun, sent)).paused).toBe(true);
    expect(await db.prepare("SELECT COUNT(*) FROM daily_reports").first("COUNT(*)")).toBe(0);
    await db.prepare("UPDATE recovery_state SET reconciled_at=?,reconciled_by=42").bind(firstRun).run();
    expect((await runReports(db, config, "test", firstRun, sent)).sent).toBe(0);
    expect(await db.prepare("SELECT status,reconstructed_after_restore FROM daily_reports").first())
      .toEqual({ status: "UNCERTAIN", reconstructed_after_restore: 1 });
    expect(await resolveReport(db, config, { day: "2026-11-10", action: "retry", adminId: 42,
      reason: "Confirmed absent from chat", idempotencyKey: "restore-retry" }, firstRun + 1)).toBe(true);
    expect((await runReports(db, config, "test", firstRun + 2, sent)).sent).toBe(1);
  });

  test("exact large totals and nonnegative remainder are formatted without Number rounding", () => {
    const report = { day: "2026-11-10", day_total: "108", total: "9007199254740993",
      correction: "-100", goal: "1000000", reconstructed_after_restore: 0 } as DailyReport;
    const text = formatReport(report).replaceAll("\u00a0", " ");
    expect(text).toContain("9 007 199 254 740 993");
    expect(text).toContain("Осталось до 1 000 000: 0");
    expect(text).toContain("Поправки к ранее учтённым дням: -100");
  });
});
