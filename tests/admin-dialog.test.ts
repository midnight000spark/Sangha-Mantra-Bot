import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { handleAdminDialog, parseMessageLink } from "../src/admin-dialog";
import { initializeTestDb as initialize } from "./db";
import { adjust, ingest, inspect, totals } from "../src/core";
import { deliverNotices } from "../src/admin";
import { parseTelegramUpdate, type TelegramCallback, type TelegramMessage } from "../src/telegram";
import { createTestDb, testConfig as base } from "./db";
import type { Config } from "../src/types";

let db: D1Database;
let config: Config;
let seq: number;
let clock: number;
let network: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let outgoing: Record<string, unknown>[];
const date = Date.parse("2026-11-10T10:00:00Z") / 1000;
beforeEach(async () => {
  config = { ...base, adminIds: [42, 43] }; seq = 0; clock = date * 1000 + 60_000; outgoing = [];
  db = await createTestDb(); await initialize(db, config);
  await source(1, 108);
  network = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
    outgoing.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: 10_000 + outgoing.length } });
  }) as unknown as typeof fetch);
});
afterEach(() => network?.mockRestore());
async function source(id: number, amount: number, version = 0) {
  await ingest(db, config, { key: `source:${id}:${version}`, updateId: id + version, chatId: -1001, messageId: id,
    userId: 7, originalDate: date + id, versionDate: date + id + version, isEdit: version > 0,
    amount, state: "VALID", reason: null, now: ++clock });
}
function message(text: string, reply?: number, actor = 42): TelegramMessage {
  return { message_id: ++seq, date: Math.floor(clock / 1000), chat: { id: actor, type: "private" },
    from: { id: actor, is_bot: false }, text, service: false, ...(reply ? { reply_to_message_id: reply } : {}) };
}
async function send(text: string, reply?: number, actor = 42) {
  const msg = message(text, reply, actor); const key = `message:${msg.message_id}`;
  expect(await handleAdminDialog(db, config, { message: msg }, key, ++clock, "local-token")).toBe(true);
  return { msg, key };
}
async function session() {
  return (await db.prepare("SELECT * FROM admin_sessions ORDER BY created_at DESC LIMIT 1").first())!;
}
async function click(action: string, id: string, actor = 42, key = `click:${++seq}`) {
  const callback: TelegramCallback = { id: key, from: { id: actor, is_bot: false }, data: `au:${action}:${id}`,
    message: { message_id: 99, chat: { id: actor, type: "private" } } };
  expect(await handleAdminDialog(db, config, { callback }, key, ++clock, "local-token")).toBe(true);
  return { callback, key };
}
async function promptId() {
  // Exercise the existing one-attempt outbox including its persisted markup and sent id.
  for (let n = 0; n < 4; n++) await deliverNotices(db, config, "local-token", clock);
  const row = await session();
  return (await db.prepare("SELECT sent_message_id FROM notices WHERE notice_key=?").bind(row.prompt_key).first<number>("sent_message_id"))!;
}
async function begin() {
  await send("https://t.me/c/1/1"); const row = await session();
  await click("e", String(row.id)); return String(row.id);
}
async function toReason(amount = "500") {
  const id = await begin(); await send(amount, await promptId()); return { id, prompt: await promptId() };
}
async function count(table: string) { return await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<number>("n"); }

test("strict public/private/topic links identify messages; ambiguous comment, foreign host and unsafe ids fail", () => {
  expect(parseMessageLink("https://t.me/example_group/27")).toEqual({ username: "example_group", messageId: 27 });
  expect(parseMessageLink("t.me/c/1234567891/27")).toEqual({ chatId: -1001234567891, messageId: 27 });
  expect(parseMessageLink("https://t.me/c/1234567891/12/27?thread=12")).toEqual({ chatId: -1001234567891, messageId: 27 });
  expect(parseMessageLink("https://t.me/example_group/12/27?single")).toEqual({ username: "example_group", messageId: 27 });
  for (const bad of ["https://t.me/example_group/27?comment=28", "https://evil.test/example_group/27", "https://t.me.evil/example_group/27",
    "https://t.me/example_group/0", "https://t.me/c/99999999999999999/27", "https://t.me/example_group/9007199254740992",
    "https://t.me/example_group/27/", "https://t.me/example_group/27 extra", "https://t.me/c/01/27", "https://t.me/s/example_group/27"])
    expect(parseMessageLink(bad)).toBeNull();
});

test("link → current value/buttons → number → reason uses existing override/audit exactly once", async () => {
  const { id, prompt } = await toReason();
  expect(outgoing.some(p => JSON.stringify(p.reply_markup).includes('"text":"Исправить"'))).toBe(true);
  expect(outgoing.some(p => JSON.stringify(p.reply_markup).includes('"force_reply":true'))).toBe(true);
  const final = await send("Участник подтвердил верное число", prompt);
  const row = await inspect(db, -1001, 1);
  expect(row?.effective_amount).toBe(500); expect(row?.source_amount).toBe(108);
  expect((await session()).state).toBe("DONE");
  const audit = await db.prepare("SELECT * FROM admin_adjustments").first();
  expect(audit).toMatchObject({ adjustment_key: `ui-session:${id}`, actor_id: 42, old_amount: 108, new_amount: 500,
    action: "OVERRIDE", reason: "Участник подтвердил верное число" });
  const events = await count("admin_ui_events");
  await handleAdminDialog(db, config, { message: final.msg }, final.key, ++clock, "local-token");
  await send("Старый ответ", prompt); await click("e", id); await click("c", id);
  expect(await count("admin_adjustments")).toBe(1);
  expect((await totals(db, config.campaignId)).total).toBe("500");
  expect(await count("admin_ui_events")).toBe(events! + 3);
  // Source edits remain lower priority, and the original release command still works.
  await source(1, 216, 5); expect((await inspect(db, -1001, 1))?.effective_amount).toBe(500);
  await adjust(db, config, { key: "release", actorId: 42, chatId: -1001, messageId: 1, amount: null, reason: "Проверено", now: ++clock });
  expect((await inspect(db, -1001, 1))?.effective_amount).toBe(216);
});

test("admin rights, private owner and forwarding restrictions are checked at every step", async () => {
  await begin(); const before = await session();
  const forged = message("999", undefined, 7);
  await handleAdminDialog(db, config, { message: forged }, "outsider", ++clock, "local-token");
  await click("c", String(before.id), 43); // another authorized admin cannot operate this session
  config = { ...config, adminIds: [43] };
  await send("999", await promptId()); await click("c", String(before.id));
  expect((await session()).state).toBe("AMOUNT");
  expect(await count("admin_adjustments")).toBe(0);
  expect(await count("operational_events")).toBe(3);
  config = { ...config, adminIds: [42, 43] };
  const forwarded = { ...message("https://t.me/c/1/1"), forward_origin: { type: "chat" } };
  await handleAdminDialog(db, config, { message: forwarded }, "forward", ++clock, "local-token");
  expect(await count("admin_sessions")).toBe(1);
  const inGroup = { ...message("https://t.me/c/1/1"), chat: { id: -1001, type: "supergroup" as const } };
  expect(await handleAdminDialog(db, config, { message: inGroup }, "group", ++clock, "local-token")).toBe(false);
  expect(await count("admin_adjustments")).toBe(0);
});

test("cancel by button or command and superseding selection never changes the contribution", async () => {
  const id = await begin(); await click("c", id); expect((await session()).state).toBe("CANCELLED");
  await begin(); await send("/cancel"); expect((await session()).state).toBe("CANCELLED");
  const old = await begin(); await send("https://t.me/c/1/1"); await click("e", old);
  expect((await session()).state).toBe("VIEW");
  expect(await count("admin_adjustments")).toBe(0);
  expect((await totals(db, config.campaignId)).total).toBe("108");
});

test("number validation keeps the prompt bound to its step, reason required, zero allowed", async () => {
  await begin();
  await send("500"); expect((await session()).state).toBe("AMOUNT");
  for (const bad of ["-1", "1.5", "1 000", "1000001", "١٠٨"]) {
    await send(bad, await promptId()); expect((await session()).state).toBe("AMOUNT");
  }
  const amountPrompt = await promptId(); const amount = await send("0", amountPrompt);
  await handleAdminDialog(db, config, { message: amount.msg }, amount.key, ++clock, "local-token");
  await send("500", amountPrompt); expect(await count("admin_adjustments")).toBe(0);
  await send(" ", await promptId()); expect((await session()).state).toBe("REASON");
  await send("a".repeat(1001), await promptId()); expect((await session()).state).toBe("REASON");
  await send("Отмена ошибочного учёта", await promptId());
  expect((await inspect(db, -1001, 1))?.effective_amount).toBe(0);
  expect(await count("admin_adjustments")).toBe(1);
});

test("changed source or another admin's correction blocks a stale preview", async () => {
  const first = await toReason(); await source(1, 216, 3);
  await send("Проверено", first.prompt); expect(await count("admin_adjustments")).toBe(0);
  const second = await toReason();
  await adjust(db, config, { key: "other-admin", actorId: 43, chatId: -1001, messageId: 1, amount: 700, reason: "Сверка", now: ++clock });
  await send("Проверено", second.prompt);
  expect(await count("admin_adjustments")).toBe(1); expect((await inspect(db, -1001, 1))?.effective_amount).toBe(700);
});

test("expired and pre-restore sessions cannot correct even with valid reply ids", async () => {
  const first = await toReason(); clock += 30 * 60_000;
  await send("Проверено", first.prompt); expect(await count("admin_adjustments")).toBe(0);
  const second = await toReason();
  await db.prepare("INSERT INTO recovery_state(campaign_id,restored_at,backup_at,reason) VALUES(?,?,?,'restore')")
    .bind(config.campaignId, ++clock, clock - 1000).run();
  await send("Проверено", second.prompt); expect(await count("admin_adjustments")).toBe(0);
});

test("correction failure rolls back receipt/session/outbox/audit, then retry safely succeeds", async () => {
  const { prompt } = await toReason(); const msg = message("Проверено", prompt); const key = "failure-retry";
  const events = await count("admin_ui_events"); const notices = await count("notices");
  await db.prepare("CREATE TRIGGER fail_ui BEFORE INSERT ON admin_adjustments BEGIN SELECT RAISE(ABORT,'injected'); END").run();
  await expect(handleAdminDialog(db, config, { message: msg }, key, ++clock, "local-token")).rejects.toThrow("injected");
  expect(await count("admin_ui_events")).toBe(events); expect(await count("notices")).toBe(notices);
  expect((await session()).state).toBe("REASON"); expect((await inspect(db, -1001, 1))?.effective_amount).toBe(108);
  await db.prepare("DROP TRIGGER fail_ui").run(); // synthetic in-memory test only
  await handleAdminDialog(db, config, { message: msg }, key, ++clock, "local-token");
  expect((await session()).state).toBe("DONE"); expect(await count("admin_adjustments")).toBe(1);
});

test("recent shows only this campaign's newest 20 and its DB-backed buttons open a record", async () => {
  await db.prepare("INSERT INTO campaigns VALUES('other','UTC','2026-11-01',1000,-2000,NULL)").run();
  await db.prepare("INSERT INTO chat_aliases VALUES(-2000,'other')").run();
  await db.prepare("INSERT INTO automatic_intake_boundaries VALUES('other',-2000,1,NULL,'Synthetic fixture',42,1)").run();
  await ingest(db, { ...config, campaignId: "other" }, { key: "other", updateId: 999, chatId: -2000, messageId: 999,
    userId: 8, originalDate: date + 1000, versionDate: date + 1000, isEdit: false, amount: 999, state: "VALID", reason: null, now: clock });
  for (let n = 2; n <= 25; n++) await source(n, n);
  const recent = await send("/recent"); await deliverNotices(db, config, "local-token", clock);
  const body = outgoing.at(-1)!;
  expect(String(body.text)).toContain("25"); expect(String(body.text)).not.toContain("-2000");
  expect(String(body.text)).toContain("принято"); expect(String(body.text)).not.toMatch(/\b(VALID|INVALID|REVIEW)\b/);
  const buttons = (body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
  expect(buttons.length).toBe(20); expect(buttons[0]![0]!.callback_data).toBe("au:r:-1001:25");
  expect(buttons.at(-1)![0]!.callback_data).toBe("au:r:-1001:6");
  const sentId = await db.prepare("SELECT sent_message_id FROM notices WHERE notice_key=?").bind(`ui:${recent.key}`).first<number>("sent_message_id");
  const cb: TelegramCallback = { id: "recent-pick", from: { id: 42, is_bot: false }, data: buttons[0]![0]!.callback_data,
    message: { message_id: sentId!, chat: { id: 42, type: "private" } } };
  await handleAdminDialog(db, config, { callback: cb }, cb.id, ++clock, "local-token");
  expect((await session()).message_id).toBe(25);
  await handleAdminDialog(db, config, { callback: { ...cb, data: "au:r:-2000:999" } }, "forged", ++clock, "local-token");
  expect(await count("admin_sessions")).toBe(1);
});

test("public link resolution uses getChat only, verifies actual allowed group and never imports a missing message", async () => {
  network.mockImplementation((async (url: unknown) => {
    expect(String(url)).toBe("https://api.telegram.org/botlocal-token/getChat");
    return Response.json({ ok: true, result: { id: -1001, type: "supergroup", username: "example_group" } });
  }) as unknown as typeof fetch);
  await send("https://t.me/example_group/1"); expect((await session()).message_id).toBe(1);
  await send("https://t.me/example_group/999"); expect(await count("contributions")).toBe(1);
  network.mockImplementation((async () => Response.json({ ok: true, result: { id: -9999, type: "supergroup", username: "example_group" } })) as unknown as typeof fetch);
  await send("https://t.me/example_group/1"); expect(await count("admin_sessions")).toBe(1);
  network.mockImplementation((async () => { throw new Error("token-bearing remote error"); }) as unknown as typeof fetch);
  await send("https://t.me/example_group/1"); expect(await count("admin_sessions")).toBe(1);
  const notices = await db.prepare("SELECT body FROM notices").all<{ body: string }>();
  expect(JSON.stringify(notices.results)).not.toContain("token-bearing");
});

test("callback boundary supports inaccessible private messages and rejects malformed/mixed updates", () => {
  const callback = { id: "test", from: { id: 42, is_bot: false }, data: "au:e:" + "a".repeat(32),
    message: { message_id: 9, date: 0, chat: { id: 42, type: "private" } } };
  expect(parseTelegramUpdate({ update_id: 1, callback_query: callback })?.callback_query?.message?.message_id).toBe(9);
  expect(parseTelegramUpdate({ update_id: 1, callback_query: { ...callback, data: "я".repeat(33) } })).toBeNull();
  expect(parseTelegramUpdate({ update_id: 1, callback_query: { ...callback, from: { id: 42, is_bot: "false" } } })).toBeNull();
  expect(parseTelegramUpdate({ update_id: 1, callback_query: callback, message: message("108") })).toBeNull();
  expect(parseTelegramUpdate({ update_id: 1, message: { ...message("500"), reply_to_message: { message_id: 12 } } })?.message?.reply_to_message_id).toBe(12);
});


test("revocation before the final reason or queued delivery prevents correction and disclosure", async () => {
  const { prompt } = await toReason();
  await send("/recent");
  const sentBefore = outgoing.length;
  config = { ...config, adminIds: [43] };
  await send("Проверено", prompt);
  await deliverNotices(db, config, "local-token", clock);
  expect(await count("admin_adjustments")).toBe(0);
  expect(outgoing.length).toBe(sentBefore);
  expect(await db.prepare("SELECT state FROM notices WHERE body LIKE 'Последние накопления%'").first("state")).toBe("FAILED_KNOWN");
});
