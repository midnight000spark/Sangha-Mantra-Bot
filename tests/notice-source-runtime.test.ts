import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { Miniflare, Response as RuntimeResponse } from "miniflare";
import { initializeTestDb, seedIdentity, testConfig } from "./db";
import { noticeSourceCases } from "./notice-source-cases";

async function openRuntime(compiled = false, throughMigration?: string) {
  const sends: { chat_id: number; text: string; reply_parameters?: { message_id: number } }[] = [];
  const build = compiled ? await Bun.build({ entrypoints: ["tests/notice-source-worker.ts"], target: "browser", format: "esm" }) : null;
  if (build && !build.success) throw new Error(`Worker bundle failed: ${build.logs}`);
  const runtime = new Miniflare({ modules: true, script: build ? await build.outputs[0]!.text() : "export default {fetch(){return new Response('ok')}}",
    d1Databases: { DB: "notice-source-runtime" },
    bindings: { DEPLOYMENT_ENV: "test", EXPECTED_D1_ID: "11111111-1111-1111-1111-111111111111", EXPECTED_BOT_ID: "123456",
      BOT_TOKEN: "123456:local-token", WEBHOOK_SECRET: "runtime-secret-1234567890", ADMIN_IDS: "42", CAMPAIGN_ID: testConfig.campaignId,
      TIMEZONE: testConfig.timezone, CAMPAIGN_START: testConfig.startDay, REPORT_TIME: testConfig.reportTime,
      GOAL: "1000000", MAX_AMOUNT: "1000000", ALLOWED_CHAT_IDS: "-1001,-1002", REPORT_CHAT_ID: "-1001" },
    outboundService: async (request: unknown) => {
      sends.push(await (request as Request).json() as typeof sends[number]);
      return new RuntimeResponse(JSON.stringify({ ok: true, result: { message_id: 100 + sends.length } }),
        { headers: { "Content-Type": "application/json" } });
    },
  });
  try {
    const db = await runtime.getD1Database("DB") as unknown as D1Database;
    for (const file of Array.from(new Glob("*.sql").scanSync("migrations")).sort()) {
      if (throughMigration && file > throughMigration) continue;
      let sql = "";
      for (const line of (await Bun.file(`migrations/${file}`).text()).split(/\r?\n/)) {
        sql += line + "\n";
        const trigger = /^\s*CREATE TRIGGER/i.test(sql.trim());
        if ((trigger && /^END;\s*$/.test(line)) || (!trigger && /;\s*$/.test(line))) {
          await db.prepare(sql.trim()).run(); sql = "";
        }
      }
    }
    await initializeTestDb(db, testConfig);
    return { db, runtime, sends, close: () => runtime.dispose() };
  } catch (error) { await runtime.dispose(); throw error; }
}

describe("notice source fence", () => noticeSourceCases("D1/workerd", () => openRuntime()));

test("compiled Worker webhook to D1 queue to Cron: latest source only, duplicates cannot resurrect", async () => {
  const { db, runtime, sends, close } = await openRuntime(true);
  try {
    await seedIdentity(db);
    await db.prepare("INSERT INTO recovery_state(campaign_id,restored_at,backup_at,reason) VALUES(?,1,1,'Synthetic report hold')")
      .bind(testConfig.campaignId).run();
    // Deterministic stand-in for a delayed sender. No silent-policy mutation is involved.
    await db.prepare("CREATE TRIGGER delay_warning AFTER INSERT ON notices WHEN NEW.notice_key LIKE 'rejected:%' BEGIN UPDATE notices SET publication_hold=1 WHERE notice_key=NEW.notice_key; END").run();
    const date = Math.floor(Date.now() / 1000) - 100;
    const source = { message_id: 10, date, from: { id: 77, is_bot: false }, chat: { id: -1001, type: "supergroup" }, text: "-5" };
    const post = async (value: unknown) => {
      const response = await runtime.dispatchFetch("https://example.invalid/webhook", { method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "runtime-secret-1234567890" }, body: JSON.stringify(value) });
      expect(response.status).toBe(200);
    };
    const cron = async () => { const worker = await runtime.getWorker(); expect((await worker.scheduled()).outcome).toBe("ok"); };
    await post({ update_id: 1, message: source });
    expect(await db.prepare("SELECT COUNT(*) n FROM notices WHERE notice_key LIKE 'rejected:%'").first("n")).toBe(1);
    await post({ update_id: 2, edited_message: { ...source, edit_date: date + 1, text: "108" } });
    await post({ update_id: 1, message: source }); // exact duplicate APPLIED receipt
    await post({ update_id: 3, message: source }); // different update_id, stale source
    expect(await db.prepare("SELECT effective_amount FROM contributions WHERE message_id=10").first("effective_amount")).toBe(108);
    await db.prepare("UPDATE notices SET publication_hold=0 WHERE notice_key LIKE 'rejected:%'").run();
    await cron(); expect(sends).toEqual([]);
    expect(await db.prepare("SELECT state FROM notices WHERE notice_key LIKE 'rejected:%'").first("state")).toBe("FAILED_KNOWN");
    await post({ update_id: 4, edited_message: { ...source, edit_date: date + 2, text: "1.5" } });
    await db.prepare("UPDATE notices SET publication_hold=0 WHERE state='PENDING'").run();
    await cron(); await cron();
    expect(sends).toHaveLength(1); expect(sends[0]?.chat_id).toBe(-1001);
    expect(sends[0]?.reply_parameters?.message_id).toBe(10);
    expect(await db.prepare("SELECT COUNT(*) n FROM notices WHERE source_event_key IS NOT NULL").first("n")).toBe(2);
    expect(await db.prepare("SELECT COUNT(*) n FROM notices WHERE state='SENT'").first("n")).toBe(1);
  } finally { await close(); }
}, 30_000);

test("real D1 additive 0009 preserves legacy notices and A01 watermark, refuses unbound warning", async () => {
  const { db, close } = await openRuntime(false, "0008_silent_command_order.sql");
  try {
    await db.prepare("INSERT INTO notices(notice_key,campaign_id,chat_id,reply_message_id,body,created_at) VALUES('rejected:legacy',?,-1001,10,'old warning',1)")
      .bind(testConfig.campaignId).run();
    const before = await db.prepare("SELECT * FROM campaign_controls").all();
    await db.prepare(await Bun.file("migrations/0009_notice_source_revision.sql").text()).run();
    expect((await db.prepare("SELECT * FROM campaign_controls").all()).results).toEqual(before.results);
    expect(await db.prepare("SELECT body,source_event_key FROM notices").first()).toEqual({ body: "old warning", source_event_key: null });
    const { deliverNotices } = await import("../src/admin");
    // A forbidden call fails the test directly instead of touching any real network.
    const { spyOn } = await import("bun:test");
    const network = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("unexpected transport"); }) as unknown as typeof fetch);
    try {
      await deliverNotices(db, testConfig, "synthetic-token");
      expect(network).not.toHaveBeenCalled();
      expect(await db.prepare("SELECT state,sent_message_id FROM notices").first()).toEqual({ state: "FAILED_KNOWN", sent_message_id: null });
    } finally { network.mockRestore(); }
  } finally { await close(); }
}, 30_000);
