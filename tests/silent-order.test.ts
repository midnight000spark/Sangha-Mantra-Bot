import { beforeEach, expect, test } from "bun:test";
import { handleAdmin, enqueueNotice } from "../src/admin";
import { silenceState, releaseHeldReport } from "../src/controls";
import { runReports } from "../src/reports";
import { createTestDb, initializeTestDb, testConfig } from "./db";

const config = { ...testConfig, adminIds: [42, 43], startDay: "2026-11-10" };
const date = Date.parse("2026-11-10T21:05:00Z") / 1000;
let db: D1Database;
let receipt: number;
beforeEach(async () => {
  db = await createTestDb();
  await initializeTestDb(db, config);
  receipt = 0;
});
const state = () => silenceState(db, config.campaignId);
const orders = async () => (await db.prepare("SELECT * FROM campaign_silent_watermarks ORDER BY actor_id,source_chat_id").all()).results;
async function command(on: boolean, sent: number, id: number, actor = 42, key?: string) {
  const n = ++receipt;
  return handleAdmin(db, config, {
    service: false, message_id: id, date: sent, from: { id: actor, is_bot: false },
    chat: { id: actor, type: "private" }, text: `/silent ${on ? "on" : "off"}`,
  }, key ?? `command-${n}`, (date + 100 + n) * 1000);
}

test("F04: first delivery of an old OFF cannot cancel a later ON", async () => {
  await command(true, date + 2, 20);
  const before = await state();
  await command(false, date + 1, 999);
  expect(await state()).toEqual(before);
  expect(await db.prepare("SELECT COUNT(*) n FROM operational_events WHERE kind='SILENT_CHANGE'").first("n")).toBe(2);
  const events = (await db.prepare("SELECT source_chat_id,message_id,detail FROM operational_events ORDER BY created_at").all<{source_chat_id:number;message_id:number;detail:string}>()).results;
  expect(events.map(e => [e.source_chat_id, e.message_id, JSON.parse(e.detail).sentAt, JSON.parse(e.detail).accepted]))
    .toEqual([[42,20,(date+2)*1000,1],[42,999,(date+1)*1000,0]]);
});

test("fresh repeated ON advances source order without rewriting change metadata", async () => {
  await command(true, date, 10);
  const before = await state();
  await command(true, date + 2, 20);
  expect(await state()).toEqual(before);
  expect((await orders())[0]).toMatchObject({ command_at: (date+2)*1000, message_id: 20 });
  await command(false, date + 1, 999);
  expect(await state()).toEqual(before);
  await command(false, date + 3, 21);
  expect((await state()).silent).toBe(0);
});

for (const reverse of [false, true]) test(`same admin/second uses message IDs, reverse=${reverse}`, async () => {
  const inputs = [{ on: false, id: 10 }, { on: true, id: 20 }];
  if (reverse) inputs.reverse();
  for (const c of inputs) await command(c.on, date, c.id);
  expect((await state()).silent).toBe(1);
  await command(false, date, 21);
  expect((await state()).silent).toBe(0);
});

test("same-second repeated ON advances message watermark without changing changed_at", async () => {
  await command(true, date, 10);
  const before = await state();
  await command(true, date, 30);
  expect(await state()).toEqual(before);
  expect((await orders())[0]).toMatchObject({ command_at: date*1000, message_id: 30 });
  await command(false, date, 20);
  expect(await state()).toEqual(before);
  await command(false, date, 31);
  expect((await state()).silent).toBe(0);
});

// Retain each admin's order: replacing A's ON with B's ON must not let B's
// later same-second OFF erase A's still-current ON.
for (const order of [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]]) {
  test(`two admins/one second retain ON across delivery permutation ${order}`, async () => {
    const inputs = [{ on: true, id: 10, actor: 42 }, { on: true, id: 20, actor: 43 }, { on: false, id: 21, actor: 43 }];
    for (const i of order) {
      const c = inputs[i]!;
      await command(c.on, date, c.id, c.actor);
    }
    expect((await state()).silent).toBe(1);
    await command(false, date + 1, 1, 43);
    expect((await state()).silent).toBe(0);
  });
}

test("stale ON cannot add notice/report holds or change OFF cutoffs", async () => {
  await command(true, date, 10);
  await runReports(db, config, "unused-local-token", date * 1000, async () => { throw new Error("silent must not send"); });
  await command(false, date + 2, 20);
  expect(await releaseHeldReport(db, config, "2026-11-10", 42, "release", "Checked locally", (date + 200) * 1000)).toBe(true);
  await enqueueNotice(db, config, "fresh", -1001, "fresh", (date + 200) * 1000);
  const before = await state();
  const orderBefore = await orders();
  await command(true, date + 1, 999);
  expect(await state()).toEqual(before);
  expect(await orders()).toEqual(orderBefore);
  expect(await db.prepare("SELECT publication_hold FROM notices WHERE notice_key='fresh'").first("publication_hold")).toBe(0);
  expect(await db.prepare("SELECT publication_hold FROM daily_reports").first("publication_hold")).toBe(0);
});

test("redelivery with a new receipt cannot change the same source command", async () => {
  await command(true, date, 10, 42, "original");
  await command(false, date + 1, 11);
  const before = await state();
  await command(true, date, 10, 42, "new-wrapper");
  expect(await state()).toEqual(before);
});

test("restore boundary blocks old and same-second admin commands; fresh OFF still works", async () => {
  await command(true, date, 10);
  await db.prepare("INSERT INTO recovery_state(campaign_id,restored_at,backup_at,reason) VALUES(?,?,?,'Synthetic restore')")
    .bind(config.campaignId, (date + 5) * 1000 + 500, date * 1000).run();
  const before = await state();
  for (const sent of [date + 4, date + 5]) await command(false, sent, 999);
  expect(await state()).toEqual(before);
  await command(false, date + 6, 11);
  expect((await state()).silent).toBe(0);
});

test("batch failure rolls back source order, policy, receipt and notice holds; replay succeeds", async () => {
  await command(true, date, 10);
  await runReports(db, config, "unused-local-token", date * 1000, async () => { throw new Error("silent must not send"); });
  await command(false, date + 1, 11);
  await enqueueNotice(db, config, "fresh", -1001, "fresh", (date + 200) * 1000);
  const before = await state();
  const orderBefore = await orders();
  await db.prepare("CREATE TRIGGER fail_hold BEFORE UPDATE OF publication_hold ON daily_reports BEGIN SELECT RAISE(ABORT,'injected hold failure'); END").run();
  await expect(command(true, date + 2, 12, 42, "failed-command")).rejects.toThrow("injected hold failure");
  expect(await state()).toEqual(before);
  expect(await orders()).toEqual(orderBefore);
  expect(await db.prepare("SELECT 1 FROM operational_events WHERE event_key='failed-command'").first()).toBeNull();
  expect(await db.prepare("SELECT publication_hold FROM notices WHERE notice_key='fresh'").first("publication_hold")).toBe(0);
  await db.prepare("DROP TRIGGER fail_hold").run();
  await command(true, date + 2, 12, 42, "failed-command");
  expect((await state()).silent).toBe(1);
  expect(await db.prepare("SELECT publication_hold FROM notices WHERE notice_key='fresh'").first("publication_hold")).toBe(1);
});

test("additive migration preserves legacy silence and fences commands using the last legacy receipt", async () => {
  db = await createTestDb("0007_campaign_controls.sql");
  await initializeTestDb(db, config);
  await db.prepare("INSERT INTO campaign_controls VALUES(?,1,?,42,'2026-11-09',?)")
    .bind(config.campaignId, date * 1000, date * 1000 - 1000).run();
  await db.prepare("INSERT INTO operational_events(event_key,campaign_id,kind,detail,created_at) VALUES('legacy-repeat',?,'SILENT_CHANGE','{}',?)")
    .bind(config.campaignId, (date + 2) * 1000 + 500).run();
  const before = await state();
  await db.exec(await Bun.file("migrations/0008_silent_command_order.sql").text());
  expect(await state()).toEqual(before);
  expect((await orders())[0]).toMatchObject({ actor_id: 0, source_chat_id: 0, command_at: (date + 2) * 1000, silent: 1 });
  for (const sent of [date + 1, date + 2]) await command(false, sent, 999);
  expect(await state()).toEqual(before);
  await command(false, date + 3, 11);
  expect((await state()).silent).toBe(0);
  expect((await state()).held_reports_through).toBe("2026-11-10");
});
