import { expect, test } from "bun:test";
import { Glob } from "bun";
import { Miniflare } from "miniflare";
import { initialize } from "../src/config";
import { ingest } from "../src/core";
import { resolveReport, runReports } from "../src/reports";
import { testConfig } from "./db";

test("real workerd D1 guards concurrent report claims, frozen snapshots and manual resolution", async () => {
  const runtime = new Miniflare({
    modules: true, script: "export default {fetch(){return new Response('ok')}}",
    d1Databases: { DB: "report-runtime" },
  });
  try {
    const db = await runtime.getD1Database("DB") as unknown as D1Database;
    for (const file of Array.from(new Glob("*.sql").scanSync("migrations")).sort()) {
      let statement = "";
      for (const line of (await Bun.file(`migrations/${file}`).text()).split(/\r?\n/)) {
        statement += `${line}\n`;
        const trigger = /^\s*CREATE TRIGGER/i.test(statement.trim());
        if ((trigger && /^END;\s*$/.test(line)) || (!trigger && /;\s*$/.test(line))) {
          await db.prepare(statement.trim()).run();
          statement = "";
        }
      }
    }
    const config = { ...testConfig, startDay: "2026-11-10" };
    await initialize(db, config);
    const date = Date.parse("2026-11-10T20:59:59Z") / 1000;
    await ingest(db, config, { key: "runtime-count", updateId: 1, chatId: -1001, messageId: 1,
      originalDate: date, versionDate: date, isEdit: false, amount: 108, state: "VALID",
      reason: null, userId: 7, now: date * 1000 });
    const now = Date.parse("2026-11-10T21:05:00Z");
    let sends = 0;
    const send = async () => { sends++; return { state: "SENT" as const, messageId: 700 }; };
    await Promise.all([runReports(db, config, "local", now, send), runReports(db, config, "local", now, send)]);
    expect(sends).toBe(1);
    expect(await db.prepare("SELECT status,attempt_count,CAST(total AS TEXT) AS total FROM daily_reports").first())
      .toEqual({ status: "SENT", attempt_count: 1, total: "108" });
    await expect(db.prepare("UPDATE daily_reports SET total=999").run()).rejects.toThrow("Report snapshots are immutable");
    await expect(db.prepare("UPDATE daily_reports SET body='changed'").run()).rejects.toThrow("Report text is immutable");

    await runReports(db, config, "local", now + 86400_000,
      async () => ({ state: "UNCERTAIN", error: "Simulated lost response" }));
    expect(await resolveReport(db, config, { day: "2026-11-11", action: "confirm_sent", messageId: 701,
      adminId: 42, reason: "Verified in report chat", idempotencyKey: "runtime-resolve" }, now + 86401_000)).toBe(true);
    expect(await db.prepare("SELECT status,telegram_message_id FROM daily_reports WHERE day='2026-11-11'").first())
      .toEqual({ status: "SENT", telegram_message_id: 701 });
    expect(await db.prepare("SELECT previous_state,reason FROM report_resolutions").first())
      .toEqual({ previous_state: "UNCERTAIN", reason: "Verified in report chat" });
  } finally {
    await runtime.dispose();
  }
}, 30_000);
