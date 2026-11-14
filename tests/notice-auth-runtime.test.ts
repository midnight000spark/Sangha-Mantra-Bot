import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { Miniflare, Response as RuntimeResponse } from "miniflare";
import { enqueueNotice } from "../src/admin";
import { initializeTestDb, seedIdentity, testConfig } from "./db";
import { noticeAuthorizationCases } from "./notice-auth-cases";
import { ingest } from "../src/core";

async function migrate(db: D1Database) {
  for (const file of Array.from(new Glob("*.sql").scanSync("migrations")).sort()) {
    let sql = "";
    for (const line of (await Bun.file(`migrations/${file}`).text()).split(/\r?\n/)) {
      sql += line + "\n";
      const trigger = /^\s*CREATE TRIGGER/i.test(sql.trim());
      if ((trigger && /^END;\s*$/.test(line)) || (!trigger && /;\s*$/.test(line))) {
        await db.prepare(sql.trim()).run(); sql = "";
      }
    }
  }
}

describe("notice authorization", () => noticeAuthorizationCases("real D1/workerd", async () => {
  const runtime = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}",
    d1Databases: { DB: "notice-auth-runtime" } });
  try {
    const db = await runtime.getD1Database("DB") as unknown as D1Database;
    await migrate(db);
    await initializeTestDb(db, testConfig);
    return { db, close: () => runtime.dispose() };
  } catch (error) { await runtime.dispose(); throw error; }
}));

test("compiled Worker: new env denies all admin namespaces; old env still requires drain", async () => {
  const build = await Bun.build({ entrypoints: ["src/worker.ts"], target: "browser", format: "esm" });
  if (!build.success) throw new Error(`Worker bundle failed: ${build.logs}`);
  const script = await build.outputs[0]!.text();
  const sends: { chat_id: number; text: string }[] = [];
  const bindings = { DEPLOYMENT_ENV: "test", EXPECTED_D1_ID: "11111111-1111-1111-1111-111111111111",
    EXPECTED_BOT_ID: "123456", BOT_TOKEN: "123456:local-token", WEBHOOK_SECRET: "local-secret-123456",
    CAMPAIGN_ID: testConfig.campaignId, TIMEZONE: testConfig.timezone, CAMPAIGN_START: testConfig.startDay,
    REPORT_TIME: testConfig.reportTime, GOAL: String(testConfig.goal), MAX_AMOUNT: String(testConfig.maxAmount),
    ALLOWED_CHAT_IDS: "-1001,-1002", REPORT_CHAT_ID: "-1001" };
  const runtime = new Miniflare({ workers: ["old", "new"].map(name => ({ name, modules: true, script,
    d1Databases: { DB: "shared-notice-auth" },
    bindings: { ...bindings, ADMIN_IDS: name === "old" ? "42" : "43" },
    outboundService: async (request: unknown) => {
      const { chat_id, text } = await (request as Request).json() as { chat_id: number; text: string };
      sends.push({ chat_id, text });
      return new RuntimeResponse(JSON.stringify({ ok: true, result: { message_id: 100 + sends.length } }),
        { headers: { "Content-Type": "application/json" } });
    },
  })) });
  const cron = async (name: string) => {
    const worker = await runtime.getWorker(name);
    expect((await worker.scheduled()).outcome).toBe("ok");
  };
  try {
    const db = await runtime.getD1Database("DB", "old") as unknown as D1Database;
    await migrate(db); await seedIdentity(db); await initializeTestDb(db, testConfig);
    // Suppress unrelated overdue reports without changing notice delivery/recovery rules.
    await db.prepare("INSERT INTO recovery_state(campaign_id,restored_at,backup_at,reason) VALUES(?,1,1,'Synthetic report hold')")
      .bind(testConfig.campaignId).run();
    const now = Date.now();
    for (const prefix of ["admin:", "ui:", "alert:"]) {
      await enqueueNotice(db, testConfig, `${prefix}old-config`, 42, "private administrative fixture", now);
    }
    await enqueueNotice(db, testConfig, "participant:regular", 77, "participant fixture", now);
    await ingest(db, testConfig, { key: "auth-group-source", updateId: 1, chatId: -1001, messageId: 7, userId: 77,
      originalDate: Math.floor(now / 1000), versionDate: Math.floor(now / 1000), isEdit: false,
      amount: 0, state: "INVALID", reason: "fixture", now });
    await enqueueNotice(db, testConfig, "rejected:regular", -1001, "group fixture", now, 7, now, "auth-group-source");
    await enqueueNotice(db, testConfig, "admin:retained", 43, "current admin fixture", now);
    for (let i = 0; i < 4; i++) await cron("new");
    expect(sends.map(s => s.chat_id).sort((a, b) => a - b)).toEqual([-1001, 43, 77]);
    expect(await db.prepare("SELECT COUNT(*) n FROM notices WHERE state='FAILED_KNOWN'").first("n")).toBe(3);
    expect(await db.prepare("SELECT COUNT(*) n FROM operational_events WHERE kind='NOTICE_AUTH_DENIED'").first("n")).toBe(3);
    // Two Workers share one D1 but retain separate ADMIN_IDS: deployment alone is not revocation.
    await enqueueNotice(db, testConfig, "admin:old-invocation-boundary", 42, "old env still authorized", now + 1);
    await cron("old");
    expect(sends.filter(s => s.chat_id === 42)).toEqual([{ chat_id: 42, text: "old env still authorized" }]);
  } finally { await runtime.dispose(); }
}, 30_000);
