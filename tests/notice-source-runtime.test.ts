import { Glob } from "bun";
import { describe, expect, test, spyOn } from "bun:test";
import { Miniflare, Response as RuntimeResponse } from "miniflare";
import { initializeTestDb, seedIdentity, testConfig } from "./db";
import { noticeSourceCases } from "./notice-source-cases";
import { deliverNotices, enqueueNotice, handleAdmin } from "../src/admin";
import { ingest } from "../src/core";
import { parseAmount } from "../src/parser";

type Transport = (request: Request, sends: { chat_id: number; text: string; reply_parameters?: { message_id: number } }[]) => Promise<RuntimeResponse>;
const okTransport: Transport = async (request, sends) => {
  sends.push(await request.json() as typeof sends[number]);
  return new RuntimeResponse(JSON.stringify({ ok: true, result: { message_id: 100 + sends.length } }),
    { headers: { "Content-Type": "application/json" } });
};

async function openRuntime(compiled = false, throughMigration?: string, transport: Transport = okTransport) {
  const sends: { chat_id: number; text: string; reply_parameters?: { message_id: number } }[] = [];
  const build = compiled ? await Bun.build({ entrypoints: ["tests/notice-source-worker.ts"], target: "browser", format: "esm" }) : null;
  if (build && !build.success) throw new Error(`Worker bundle failed: ${build.logs}`);
  const runtime = new Miniflare({ modules: true, script: build ? await build.outputs[0]!.text() : "export default {fetch(){return new Response('ok')}}",
    d1Databases: { DB: "notice-source-runtime" },
    bindings: { DEPLOYMENT_ENV: "test", EXPECTED_D1_ID: "11111111-1111-1111-1111-111111111111", EXPECTED_BOT_ID: "123456",
      BOT_TOKEN: "123456:local-token", WEBHOOK_SECRET: "runtime-secret-1234567890", ADMIN_IDS: "42", CAMPAIGN_ID: testConfig.campaignId,
      TIMEZONE: testConfig.timezone, CAMPAIGN_START: testConfig.startDay, REPORT_TIME: testConfig.reportTime,
      GOAL: "1000000", MAX_AMOUNT: "1000000", ALLOWED_CHAT_IDS: "-1001,-1002", REPORT_CHAT_ID: "-1001" },
    outboundService: async (request: unknown) => transport(request as Request, sends),
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

// --- A06 F2 regressions: one automatic warning per source message across revisions and failures ---

const f2Now = Date.parse("2026-11-10T21:05:00Z");
const f2Date = f2Now / 1000 - 100;
const f2Key = (revision: string, chatId = -1001, messageId = 10) => `rejected:${chatId}:${messageId}:${revision}`;
async function f2Input(db: D1Database, revision: string, text: string, version = f2Date, isEdit = false, chatId = -1001, messageId = 10) {
  await ingest(db, testConfig, { key: revision, updateId: 100, chatId, messageId, userId: 77,
    originalDate: f2Date, versionDate: version, isEdit, ...parseAmount(text, testConfig.maxAmount), now: f2Now });
  await enqueueNotice(db, testConfig, f2Key(revision, chatId, messageId), chatId, `warning:${revision}`, f2Now, messageId, f2Date * 1000, revision);
}
const f2State = (db: D1Database, revision: string, chatId = -1001, messageId = 10) =>
  db.prepare("SELECT state,publication_hold,sent_message_id FROM notices WHERE notice_key=?").bind(f2Key(revision, chatId, messageId)).first();
function adminCommand(id: number, at: number, text: string) {
  return { service: false, message_id: id, date: at, chat: { id: 42, type: "private" as const }, from: { id: 42, is_bot: false }, text };
}
const badGateway = () => new RuntimeResponse("<html>502 Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });

test("F2-R1 compiled Worker: unverifiable first send blocks every later invalid revision of the same source", async () => {
  let calls = 0;
  const { db, runtime, sends, close } = await openRuntime(true, undefined, async (request, list) => {
    calls++;
    if (calls === 1) { list.push(await request.json() as typeof list[number]); return badGateway(); }
    return okTransport(request, list);
  });
  try {
    await seedIdentity(db);
    await db.prepare("INSERT INTO recovery_state(campaign_id,restored_at,backup_at,reason) VALUES(?,1,1,'Synthetic report hold')")
      .bind(testConfig.campaignId).run();
    const post = async (value: unknown) => {
      const response = await runtime.dispatchFetch("https://example.invalid/webhook", { method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "runtime-secret-1234567890" }, body: JSON.stringify(value) });
      expect(response.status).toBe(200);
    };
    const cron = async () => { const worker = await runtime.getWorker(); expect((await worker.scheduled()).outcome).toBe("ok"); };
    const source = { message_id: 10, date: f2Date, from: { id: 77, is_bot: false }, chat: { id: -1001, type: "supergroup" }, text: "0" };
    await post({ update_id: 1, message: source });
    await cron();
    expect(calls).toBe(1);
    const first = await db.prepare("SELECT notice_key,state FROM notices WHERE chat_id=-1001 AND reply_message_id=10").first();
    expect(first?.state).toBe("UNCERTAIN");
    await post({ update_id: 2, edited_message: { ...source, edit_date: f2Date + 1, text: "1.5" } });
    await cron();
    expect(calls).toBe(1); // baseline performs a second send here
    await post({ update_id: 1, message: source }); // exact original envelope replay
    await post({ update_id: 3, edited_message: { ...source, edit_date: f2Date + 2, text: "2.5" } });
    await cron(); await cron();
    expect(calls).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.reply_parameters?.message_id).toBe(10);
    const rows = await db.prepare("SELECT state,COUNT(*) n FROM notices WHERE chat_id=-1001 AND reply_message_id=10 GROUP BY state ORDER BY state").all();
    expect(rows.results).toEqual([{ state: "PENDING", n: 2 }, { state: "UNCERTAIN", n: 1 }]);
  } finally { await close(); }
}, 30_000);

test("F2-R2 real D1: second sender loses the SQL claim while sibling is SENDING; UNCERTAIN and expired lease keep blocking", async () => {
  const { db, close } = await openRuntime();
  const calls: string[] = [];
  let releaseFirst!: (response: Response) => void;
  const firstReleased = new Promise<Response>(resolve => { releaseFirst = resolve; });
  let inFlight!: () => void;
  const firstInFlight = new Promise<void>(resolve => { inFlight = resolve; });
  const network = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)).text);
    if (calls.length === 1) { inFlight(); return firstReleased; }
    return Response.json({ ok: true, result: { message_id: 900 + calls.length } });
  }) as unknown as typeof fetch);
  try {
    await f2Input(db, "bad", "0");
    const first = deliverNotices(db, testConfig, "synthetic-token", f2Now);
    await firstInFlight; // first claim committed, final gate passed, transport in flight
    expect(await f2State(db, "bad")).toMatchObject({ state: "SENDING" });
    await f2Input(db, "bad2", "1.5", f2Date + 1, true);
    await deliverNotices(db, testConfig, "synthetic-token", f2Now); // second real SQL claim attempt
    expect(calls).toHaveLength(1); // baseline: the second sender claims and sends warning:bad2
    expect(await f2State(db, "bad2")).toMatchObject({ state: "PENDING" });
    releaseFirst(new Response("<html>502</html>", { status: 502, headers: { "Content-Type": "text/html" } }));
    await first;
    expect(await f2State(db, "bad")).toMatchObject({ state: "UNCERTAIN" });
    await deliverNotices(db, testConfig, "synthetic-token", f2Now + 1);
    expect(calls).toHaveLength(1);
    // An expired SENDING lease becomes UNCERTAIN and still blocks the source message.
    await db.prepare("UPDATE notices SET state='SENDING',claimed_at=? WHERE notice_key=?").bind(f2Now - 400_000, f2Key("bad")).run();
    await deliverNotices(db, testConfig, "synthetic-token", f2Now + 2);
    expect(calls).toHaveLength(1);
    expect(await f2State(db, "bad")).toMatchObject({ state: "UNCERTAIN" });
    expect(await f2State(db, "bad2")).toMatchObject({ state: "PENDING" });
  } finally { network.mockRestore(); await close(); }
}, 30_000);

test("F2-R3 real D1: manual paths survive; sibling UNCERTAIN blocks retry; notice_sent closes the source permanently", async () => {
  const { db, close } = await openRuntime();
  const calls: { text: string; chat_id: number }[] = [];
  let mode: "429" | "502" | "ok" = "429";
  const network = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ text: body.text, chat_id: body.chat_id });
    if (mode === "429") return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 30 } });
    if (mode === "502") return new Response("<html>502</html>", { status: 502, headers: { "Content-Type": "text/html" } });
    return Response.json({ ok: true, result: { message_id: 900 + calls.length } });
  }) as unknown as typeof fetch);
  const groupCalls = () => calls.filter(call => call.chat_id < 0);
  const { setTestSilence } = await import("./db");
  try {
    // A proven 429 keeps the source blocked for automatic sends; the manual retry permits one current send.
    await f2Input(db, "bad", "0");
    await deliverNotices(db, testConfig, "synthetic-token", f2Now);
    expect(await f2State(db, "bad")).toMatchObject({ state: "FAILED_KNOWN" });
    mode = "ok";
    await handleAdmin(db, testConfig, adminCommand(99, f2Now / 1000 + 60, `/notice_retry ${f2Key("bad")} Checked absent`), "f2-retry-bad", f2Now + 60_000);
    await deliverNotices(db, testConfig, "synthetic-token", f2Now + 61_000);
    // One known 429 attempt plus exactly one permitted send after the audited manual retry.
    expect(groupCalls().map(call => call.text)).toEqual(["warning:bad", "warning:bad"]);
    expect(await f2State(db, "bad")).toMatchObject({ state: "SENT" });
    // A sibling UNCERTAIN on another source blocks a manually released newer intent; notice_sent closes it.
    mode = "502";
    await f2Input(db, "u1", "1.5", f2Date, false, -1001, 20);
    await deliverNotices(db, testConfig, "synthetic-token", f2Now + 62_000);
    expect(await f2State(db, "u1", -1001, 20)).toMatchObject({ state: "UNCERTAIN" });
    await setTestSilence(db, testConfig, true, 42, "f2-on", f2Now + 63_000);
    await f2Input(db, "u2", "2.5", f2Date + 1, true, -1001, 20);
    await setTestSilence(db, testConfig, false, 42, "f2-off", f2Now + 64_000);
    expect(await f2State(db, "u2", -1001, 20)).toMatchObject({ state: "PENDING", publication_hold: 1 });
    await handleAdmin(db, testConfig, adminCommand(100, f2Now / 1000 + 65, `/notice_retry ${f2Key("u2", -1001, 20)} Checked absent`), "f2-retry", f2Now + 65_000);
    expect(await f2State(db, "u2", -1001, 20)).toMatchObject({ state: "PENDING", publication_hold: 0 });
    mode = "ok";
    await deliverNotices(db, testConfig, "synthetic-token", f2Now + 66_000);
    // warning:u1 is the single unverifiable attempt on message 20; u2 must never be attempted.
    expect(groupCalls().map(call => call.text)).toEqual(["warning:bad", "warning:bad", "warning:u1"]); // baseline adds warning:u2
    await handleAdmin(db, testConfig, adminCommand(101, f2Now / 1000 + 67, `/notice_sent ${f2Key("u1", -1001, 20)} 555 Found in Telegram`), "f2-sent", f2Now + 67_000);
    expect(await f2State(db, "u1", -1001, 20)).toMatchObject({ state: "SENT", sent_message_id: 555 });
    mode = "ok";
    await deliverNotices(db, testConfig, "synthetic-token", f2Now + 68_000);
    await deliverNotices(db, testConfig, "synthetic-token", f2Now + 69_000);
    expect(groupCalls().map(call => call.text)).toEqual(["warning:bad", "warning:bad", "warning:u1"]);
    expect(await f2State(db, "u2", -1001, 20)).toMatchObject({ state: "PENDING" });
  } finally { network.mockRestore(); await close(); }
}, 30_000);

test("F2-R3 real D1: final gate refuses when operator confirms a sibling after claim; own claim returns unheld", async () => {
  const { db, close } = await openRuntime();
  const calls: { text: string; chat_id: number }[] = [];
  const network = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ text: body.text, chat_id: body.chat_id });
    if (calls.length === 1) return Response.json({ ok: false, error_code: 403 });
    return Response.json({ ok: true, result: { message_id: 900 + calls.length } });
  }) as unknown as typeof fetch);
  const { sourceGate } = await import("./notice-source-cases");
  try {
    await f2Input(db, "old", "0");
    await deliverNotices(db, testConfig, "synthetic-token", f2Now); // known 403 non-send
    await f2Input(db, "good", "108", f2Date + 1, true);
    await deliverNotices(db, testConfig, "synthetic-token", f2Now + 1); // old intent becomes stale FAILED_KNOWN
    expect(await f2State(db, "old")).toMatchObject({ state: "FAILED_KNOWN", sent_message_id: null });
    await f2Input(db, "new", "1.5", f2Date + 2, true);
    const controlled = sourceGate(db, () => handleAdmin(db, testConfig,
      adminCommand(102, f2Now / 1000 + 3, `/notice_sent ${f2Key("old")} 555 Found in Telegram`), "f2-race", f2Now + 3000));
    await deliverNotices(controlled, testConfig, "synthetic-token", f2Now + 2);
    // The only legitimate group attempt is the earlier known 403 for warning:old.
    expect(calls.filter(call => call.chat_id < 0).map(call => call.text)).toEqual(["warning:old"]); // baseline adds warning:new
    expect(await f2State(db, "new")).toMatchObject({ state: "PENDING", publication_hold: 0 });
    expect(await f2State(db, "old")).toMatchObject({ state: "SENT", sent_message_id: 555 });
    await deliverNotices(db, testConfig, "synthetic-token", f2Now + 4);
    expect(calls.filter(call => call.chat_id < 0).map(call => call.text)).toEqual(["warning:old"]);
    expect(await f2State(db, "new")).toMatchObject({ state: "PENDING" });
  } finally { network.mockRestore(); await close(); }
}, 30_000);

test("F2-R4 real D1: blocked siblings never starve independent notices; other messages/chats stay independent", async () => {
  const { db, close } = await openRuntime();
  let calls = 0;
  const network = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
    calls++;
    if (calls === 1) return badGateway();
    return Response.json({ ok: true, result: { message_id: 900 + calls } });
  }) as unknown as typeof fetch);
  try {
    await f2Input(db, "u0", "0");
    await deliverNotices(db, testConfig, "synthetic-token", f2Now);
    expect(await f2State(db, "u0")).toMatchObject({ state: "UNCERTAIN" });
    await f2Input(db, "uA", "1.5", f2Date + 1, true);
    await f2Input(db, "uB", "2.5", f2Date + 2, true);
    await enqueueNotice(db, testConfig, f2Key("ind", -1001, 11), -1001, "warning:ind", f2Now + 3, 11, f2Date * 1000, "ind");
    await ingest(db, testConfig, { key: "ind", updateId: 101, chatId: -1001, messageId: 11, userId: 77,
      originalDate: f2Date, versionDate: f2Date, isEdit: false, ...parseAmount("3.5", testConfig.maxAmount), now: f2Now + 3 });
    await f2Input(db, "other", "4.5", f2Date, false, -1002, 10); // different chat, same message id
    const before = calls;
    await deliverNotices(db, testConfig, "synthetic-token", f2Now + 4);
    expect(calls).toBe(before + 2); // independent msg 11 and other-chat warning, not the blocked siblings
    expect(await f2State(db, "uA")).toMatchObject({ state: "PENDING" });
    expect(await f2State(db, "uB")).toMatchObject({ state: "PENDING" });
    expect(await f2State(db, "ind", -1001, 11)).toMatchObject({ state: "SENT" });
    expect(await f2State(db, "other", -1002, 10)).toMatchObject({ state: "SENT" });
  } finally { network.mockRestore(); await close(); }
}, 30_000);

test("F2 real D1: legacy unbound UNCERTAIN/SENT sibling blocks new bound revisions of the same source", async () => {
  const { db, close } = await openRuntime();
  const calls: string[] = [];
  const network = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.chat_id < 0) calls.push(body.text); // ignore private admin answers
    return Response.json({ ok: true, result: { message_id: 900 + calls.length } });
  }) as unknown as typeof fetch);
  try {
    await db.prepare("INSERT INTO notices(notice_key,campaign_id,chat_id,reply_message_id,body,state,created_at) VALUES('rejected:legacy-10',?,-1001,10,'legacy warning','UNCERTAIN',1)")
      .bind(testConfig.campaignId).run();
    await f2Input(db, "bad", "0");
    await deliverNotices(db, testConfig, "synthetic-token", f2Now);
    expect(calls).toEqual([]); // baseline sends warning:bad despite the legacy UNCERTAIN
    expect(await f2State(db, "bad")).toMatchObject({ state: "PENDING" });
    await handleAdmin(db, testConfig, adminCommand(110, f2Now / 1000 + 1, "/notice_sent rejected:legacy-10 555 Found in Telegram"), "legacy-sent", f2Now + 1000);
    expect(await db.prepare("SELECT state,sent_message_id FROM notices WHERE notice_key='rejected:legacy-10'").first())
      .toEqual({ state: "SENT", sent_message_id: 555 });
    await deliverNotices(db, testConfig, "synthetic-token", f2Now + 2000);
    await deliverNotices(db, testConfig, "synthetic-token", f2Now + 3000);
    expect(calls).toEqual([]);
    expect(await f2State(db, "bad")).toMatchObject({ state: "PENDING" });
  } finally { network.mockRestore(); await close(); }
}, 30_000);
