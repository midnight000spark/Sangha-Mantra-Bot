import { expect, test } from "bun:test";
import { Glob } from "bun";
import { Miniflare } from "miniflare";
import { initializeTestDb, setTestSilence, testConfig } from "./db";
import { ingest } from "../src/core";
import { runReports } from "../src/reports";

test("A06 D1 midnight partition, report cutoff, long silence and late correction without wall-clock waiting", async () => {
  const runtime = new Miniflare({ modules: true,
    script: "export default {fetch(){return new Response('local')}}",
    d1Databases: { DB: "a06-report-boundary" } });
  try {
    const db = await runtime.getD1Database("DB") as unknown as D1Database;
    for (const file of Array.from(new Glob("*.sql").scanSync("migrations")).sort()) {
      let sql = "";
      for (const line of (await Bun.file(`migrations/${file}`).text()).split(/\r?\n/)) {
        sql += line + "\n";
        const trigger = /^\s*CREATE TRIGGER/i.test(sql.trim());
        if ((trigger && /^END;\s*$/.test(line)) || (!trigger && /;\s*$/.test(line))) {
          await db.prepare(sql.trim()).run(); sql = "";
        }
      }
      if (sql.trim()) throw Error("Unconsumed migration SQL");
    }
    const config = { ...testConfig, allowedChatIds: [-1001], startDay: "2026-11-10" };
    await initializeTestDb(db, config);
    const midnight = Date.parse("2026-11-10T21:00:00Z") / 1000;
    const cutoff = Date.parse("2026-11-10T21:05:00Z");
    const add = (id: number, seconds: number, amount: number, edit = false, version = seconds) => ingest(db, config, {
      key: `a06:${id}:${version}`, updateId: id, chatId: -1001, messageId: id, userId: 7,
      originalDate: seconds, versionDate: version, isEdit: edit, amount, state: "VALID", reason: null, now: version * 1000,
    });
    await add(1, midnight - 1, 100);
    await add(2, midnight, 200);
    await add(3, midnight + 1, 300);
    const days = await db.prepare("SELECT message_id,local_day FROM contributions ORDER BY message_id").all();
    expect(days.results).toEqual([{ message_id: 1, local_day: "2026-11-10" },
      { message_id: 2, local_day: "2026-11-11" }, { message_id: 3, local_day: "2026-11-11" }]);
    let sends = 0;
    const send = async () => ({ state: "SENT" as const, messageId: ++sends });
    await setTestSilence(db, config, true, 42, "a06:on", cutoff - 2000);
    expect((await runReports(db, config, "local", cutoff - 1000, send)).created).toBe(0);
    // D1 meta.changes includes the report_audit trigger; count actual rows below.
    expect((await runReports(db, config, "local", cutoff, send)).created).toBeGreaterThan(0);
    const snapshot = () => db.prepare(`SELECT day,day_total,total,correction,publication_hold,status
      FROM daily_reports ORDER BY day`).all();
    expect((await snapshot()).results).toEqual([{ day: "2026-11-10", day_total: 100,
      total: 100, correction: 0, publication_hold: 1, status: "PENDING" }]);
    await add(1, midnight - 1, 150, true, midnight + 600);
    // Three calendar reports while silent, using the existing explicit nowMs seam.
    for (let day = 1; day <= 2; day++) {
      const now = cutoff + day * 86400_000;
      expect((await runReports(db, config, "local", now, send)).created).toBeGreaterThan(0);
      expect((await runReports(db, config, "local", now, send)).created).toBe(0);
    }
    expect(sends).toBe(0);
    const held = (await snapshot()).results;
    expect(held).toEqual([
      { day: "2026-11-10", day_total: 100, total: 100, correction: 0, publication_hold: 1, status: "PENDING" },
      { day: "2026-11-11", day_total: 500, total: 650, correction: 50, publication_hold: 1, status: "PENDING" },
      { day: "2026-11-12", day_total: 0, total: 650, correction: 0, publication_hold: 1, status: "PENDING" },
    ]);
    await setTestSilence(db, config, false, 42, "a06:off", cutoff + 2 * 86400_000 + 1000);
    await runReports(db, config, "local", cutoff + 2 * 86400_000 + 2000, send);
    expect((await snapshot()).results).toEqual(held);
    expect(sends).toBe(0);
    await runReports(db, config, "local", cutoff + 3 * 86400_000, send);
    expect(sends).toBe(1);
    expect((await snapshot()).results.slice(0, 3)).toEqual(held);
    expect(await db.prepare("SELECT status,day_total,total FROM daily_reports WHERE day='2026-11-13'").first())
      .toEqual({ status: "SENT", day_total: 0, total: 650 });
  } finally { await runtime.dispose(); }
}, 30_000);
