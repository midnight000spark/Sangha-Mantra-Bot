import { afterEach, beforeEach, expect, test } from "bun:test";
import { initialize } from "../src/config";
import { adjust, importContribution, ingest, inspect, totals } from "../src/core";
import { runReports } from "../src/reports";
import { testConfig } from "./db";
import type { ContributionEvent } from "../src/types";

export const boundaryConfig = { ...testConfig, startDay: "2026-11-12", allowedChatIds: [-1001] };
export const originalDate = Date.parse("2026-11-12T10:00:00Z") / 1000;
export const incidentNow = Date.parse("2026-11-13T21:05:00Z");
export function boundaryEvent(id: number, amount: number, revision = 0, chatId = -1001): ContributionEvent {
  return { key: `boundary:${chatId}:${id}:${amount}:${revision}`, updateId: 1000 + revision,
    chatId, messageId: id, userId: 7, originalDate, versionDate: originalDate + revision,
    isEdit: revision > 0, amount, state: amount ? "VALID" : "INVALID", reason: null, now: incidentNow };
}
export async function installBoundary(db: D1Database, first: number | null = 41, time: number | null = null, chatId = -1001) {
  await db.prepare(`INSERT INTO automatic_intake_boundaries VALUES(?,?,?,?, 'Synthetic approved source marker',42,?)
    ON CONFLICT(campaign_id,chat_id) DO UPDATE SET first_message_id=excluded.first_message_id,original_not_before=excluded.original_not_before`)
    .bind(boundaryConfig.campaignId, chatId, first, time, incidentNow).run();
}
export const openingImport = { key: "synthetic-opening-14950", actorId: 42, chatId: -1001, messageId: 900,
  amount: 14950, originalDate, reason: "Synthetic opening aggregate; original membership UNKNOWN", now: incidentNow };

/** Same domain corpus runs against SQLite and actual local D1/workerd. No inferred import members. */
export function intakeBoundaryCases(label: string, open: () => Promise<{ db: D1Database; close?: () => Promise<void> }>) {
  let db: D1Database;
  let close: (() => Promise<void>) | undefined;
  beforeEach(async () => { ({ db, close } = await open()); await initialize(db, boundaryConfig); });
  afterEach(async () => { await close?.(); });
  const total = async () => (await totals(db, boundaryConfig.campaignId)).total;

  test(`${label}: initialization never invents a boundary, even with a production identity`, async () => {
    await initialize(db, boundaryConfig); await initialize(db, boundaryConfig);
    expect(await db.prepare("SELECT COUNT(*) n FROM automatic_intake_boundaries").first("n")).toBe(0);
    await expect(ingest(db, boundaryConfig, boundaryEvent(32, 500, 86400))).rejects.toThrow("not provisioned");
    expect(await total()).toBe("0");
    expect((await runReports(db, boundaryConfig, "unused", incidentNow, async () => { throw Error("unexpected send"); })).paused).toBe(true);
    const production = { ...boundaryConfig, deployment: { environment: "production" as const,
      databaseId: "00000000-0000-4000-8000-000000000004", botId: 123456, sourceChatIds: "-1001", reportChatId: -1001 } };
    await db.prepare("INSERT INTO production_deployment_identity VALUES(1,'production',?,'test',123456,'-1001',-1001)")
      .bind(production.deployment.databaseId).run();
    await initialize(db, production);
    expect(await db.prepare("SELECT COUNT(*) n FROM automatic_intake_boundaries").first("n")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) n FROM event_log").first("n")).toBe(0);
  });

  for (const reverse of [false, true]) test(`${label}: absent 32/35/38, three edits plus late originals, reverse=${reverse}`, async () => {
    await installBoundary(db); await importContribution(db, boundaryConfig, openingImport);
    for (const [id, amount] of [[32, 500], [35, 5000], [38, 2700]] as const) {
      const events = [0, 86400, 86401, 86402].map(r => boundaryEvent(id, amount, r));
      if (reverse) events.reverse();
      for (const e of [...events, ...events]) {
        expect((await ingest(db, boundaryConfig, e)).outcome).toBe("REJECTED");
        expect(await total()).toBe("14950");
      }
      expect(await inspect(db, -1001, id)).toBeNull();
    }
    expect(await db.prepare("SELECT COUNT(*) n FROM event_log WHERE old_amount!=0 OR new_amount!=0").first("n")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) n FROM event_log").first("n")).toBe(12);
  });

  for (const [first, time] of [[41, null], [null, originalDate + 1], [41, originalDate + 1]] as const) {
    test(`${label}: inclusive independent ID/time predicates: ${first}/${time}`, async () => {
      await installBoundary(db, first, time);
      const e = (id: number, date: number) => ({ ...boundaryEvent(id, 108), originalDate: date, versionDate: date + 86400, isEdit: true });
      if (first !== null) expect((await ingest(db, boundaryConfig, e(40, originalDate + 10))).outcome).toBe("REJECTED");
      if (time !== null) expect((await ingest(db, boundaryConfig, e(100, originalDate))).outcome).toBe("REJECTED");
      expect((await ingest(db, boundaryConfig, e(first ?? 41, time ?? originalDate))).outcome).toBe("APPLIED");
      expect(await total()).toBe("108");
    });
  }

  test(`${label}: existing zero32/38 and uncorrected35 survive installation, edits and missing boundary`, async () => {
    await installBoundary(db, 1);
    for (const [id, amount] of [[32, 500], [35, 5000], [38, 2700]] as const) {
      await ingest(db, boundaryConfig, boundaryEvent(id, amount));
      if (id !== 35) await adjust(db, boundaryConfig, { ...openingImport, key: `zero:${id}`, messageId: id, amount: 0,
        reason: "Synthetic prior explicit correction; no proof of opening composition" });
    }
    const adjustments = (await db.prepare("SELECT * FROM admin_adjustments ORDER BY adjustment_key").all()).results;
    const rows = (await db.prepare("SELECT * FROM contributions ORDER BY message_id").all()).results;
    await installBoundary(db);
    expect((await db.prepare("SELECT * FROM contributions ORDER BY message_id").all()).results).toEqual(rows);
    await db.prepare("DELETE FROM automatic_intake_boundaries").run();
    for (const id of [32, 35, 38]) {
      for (const revision of [3, 2, 3, 0, 4]) await ingest(db, boundaryConfig, boundaryEvent(id, id === 35 ? 5000 : 999, revision));
    }
    expect(await total()).toBe("5000");
    expect((await inspect(db, -1001, 32))?.override_amount).toBe(0);
    expect((await inspect(db, -1001, 38))?.effective_amount).toBe(0);
    expect((await inspect(db, -1001, 35))?.override_amount).toBeNull();
    expect((await db.prepare("SELECT * FROM admin_adjustments ORDER BY adjustment_key").all()).results).toEqual(adjustments);
    await expect(ingest(db, boundaryConfig, boundaryEvent(100, 777))).rejects.toThrow("not provisioned");
    expect(await total()).toBe("5000");
  });

  test(`${label}: import14950 once, no overwrite via another key, edits preserve opening override`, async () => {
    await installBoundary(db); await importContribution(db, boundaryConfig, openingImport);
    await importContribution(db, boundaryConfig, openingImport);
    await expect(importContribution(db, boundaryConfig, { ...openingImport, key: "different-import-key" })).rejects.toThrow("already exists");
    for (const r of [3, 2, 0, 3, 4]) await ingest(db, boundaryConfig, boundaryEvent(900, 777, r));
    expect(await total()).toBe("14950");
    expect(await db.prepare("SELECT COUNT(*) n FROM admin_adjustments WHERE action='IMPORT'").first("n")).toBe(1);
    expect((await inspect(db, -1001, 900))?.override_amount).toBe(14950);
  });

  test(`${label}: new source never inherits another chat's ID/time boundary`, async () => {
    await installBoundary(db);
    const expanded = { ...boundaryConfig, allowedChatIds: [-1001, -2001] };
    await initialize(db, expanded);
    await expect(ingest(db, expanded, boundaryEvent(10000, 108, 0, -2001))).rejects.toThrow("not provisioned");
    await installBoundary(db, 101, originalDate + 1, -2001);
    expect((await ingest(db, expanded, boundaryEvent(100, 108, 86400, -2001))).outcome).toBe("REJECTED");
    expect((await ingest(db, expanded, boundaryEvent(102, 108, 86400, -2001))).outcome).toBe("REJECTED");
    const accepted = { ...boundaryEvent(101, 108, 0, -2001), originalDate: originalDate + 1, versionDate: originalDate + 1 };
    expect((await ingest(db, expanded, accepted)).outcome).toBe("APPLIED");
    expect(await total()).toBe("108");
    expect(await inspect(db, -1001, 101)).toBeNull();
  });

  test(`${label}: incident35 32050+26500+5000=63550; only explicit correction gives58550; published immutable`, async () => {
    await installBoundary(db, 1); await importContribution(db, boundaryConfig, openingImport);
    // 17100 and source IDs are synthetic balancing fixtures, not reconstructed legacy members.
    await ingest(db, boundaryConfig, boundaryEvent(41, 17100));
    const send = async () => ({ state: "SENT" as const, messageId: 700 });
    await runReports(db, boundaryConfig, "unused", Date.parse("2026-11-12T21:05:00Z"), send);
    expect(await db.prepare("SELECT total FROM daily_reports WHERE day='2026-11-12'").first("total")).toBe(32050);
    await ingest(db, boundaryConfig, boundaryEvent(35, 5000, 86400));
    const today = { ...boundaryEvent(42, 26500), originalDate: originalDate + 86400, versionDate: originalDate + 86400 };
    await ingest(db, boundaryConfig, today); await installBoundary(db);
    for (const r of [86401, 86402, 86403, 0, 86402]) await ingest(db, boundaryConfig, boundaryEvent(35, 5000, r));
    expect(await total()).toBe("63550");
    await runReports(db, boundaryConfig, "unused", incidentNow, send);
    const snapshot = await db.prepare("SELECT * FROM daily_reports WHERE day='2026-11-13'").first();
    expect(snapshot?.day_total).toBe(26500); expect(snapshot?.correction).toBe(5000); expect(snapshot?.total).toBe(63550);
    expect(await db.prepare("SELECT SUM(new_amount-old_amount) n FROM event_log WHERE message_id=35").first("n")).toBe(5000);
    expect(await db.prepare("SELECT COUNT(*) n FROM admin_adjustments WHERE message_id=35").first("n")).toBe(0);
    const correction = { ...openingImport, key: "explicit-correction35", messageId: 35, amount: 0,
      reason: "Synthetic approved correction of duplicate35; actual production execution UNKNOWN" };
    await adjust(db, boundaryConfig, correction); await adjust(db, boundaryConfig, correction);
    await ingest(db, boundaryConfig, boundaryEvent(35, 7777, 86404));
    expect(await total()).toBe("58550");
    expect(await db.prepare("SELECT old_amount,new_amount FROM admin_adjustments WHERE message_id=35").first()).toEqual({ old_amount: 5000, new_amount: 0 });
    await runReports(db, boundaryConfig, "unused", incidentNow + 1, send);
    expect(await db.prepare("SELECT * FROM daily_reports WHERE day='2026-11-13'").first()).toEqual(snapshot);
  });
}
