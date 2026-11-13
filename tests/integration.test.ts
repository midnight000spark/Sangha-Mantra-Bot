import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import worker from "../src/worker";
import { initializeTestDb as initialize } from "./db";
import { deliverNotices, enqueueNotice, notifyOperators } from "../src/admin";
import { inspect, totals } from "../src/core";
import { parseTelegramUpdate, sendTelegramMessage } from "../src/telegram";
import type { Env } from "../src/types";
import { createTestDb, seedIdentity, testConfig } from "./db";

const sent = () => Response.json({ ok: true, result: { message_id: 999 } });
const fakeFetch = (implementation: () => Promise<Response>) => implementation as unknown as typeof fetch;
let network: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeEach(() => { network = spyOn(globalThis, "fetch").mockImplementation(fakeFetch(async () => sent())); });
afterEach(() => network.mockRestore());

async function environment(startDay = testConfig.startDay, reportChatId = testConfig.reportChatId): Promise<Env> {
  const db = await createTestDb();
  await seedIdentity(db);
  await initialize(db,{...testConfig,startDay,reportChatId});
  return {
    DB: db, DEPLOYMENT_ENV: "test", EXPECTED_D1_ID: "11111111-1111-1111-1111-111111111111", EXPECTED_BOT_ID: "123456",
    BOT_TOKEN: "123456:test-token", WEBHOOK_SECRET: "a-long-local-secret-token",
    ADMIN_IDS: "42", CAMPAIGN_ID: "test", TIMEZONE: "Europe/Moscow", CAMPAIGN_START: startDay,
    REPORT_TIME: "00:05", GOAL: "1000000", MAX_AMOUNT: "1000000", ALLOWED_CHAT_IDS: "-1001,-1002", REPORT_CHAT_ID: String(reportChatId),
  };
}
const date = Math.floor(Date.parse("2026-11-03T10:00:00Z") / 1000);
function payload(text: string, id = 1, updateId = id, extra: Record<string, unknown> = {}) {
  return { update_id: updateId, message: { message_id: id, date, from: { id: 100, is_bot: false }, chat: { id: -1001, type: "supergroup" }, text, ...extra } };
}
function admin(text: string, id = 1, actorId = 42) {
  return payload(text, id, 1000 + id, { date: Math.floor(Date.now() / 1000), from: { id: actorId, is_bot: false }, chat: { id: actorId, type: "private" } });
}
async function invoke(env: Env, value: unknown, secret = env.WEBHOOK_SECRET) {
  const tasks: Promise<unknown>[] = [];
  const response = await worker.fetch(new Request("https://example.invalid/webhook", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify(value),
  }), env, { waitUntil: (task: Promise<unknown>) => tasks.push(task) } as unknown as ExecutionContext);
  await Promise.all(tasks);
  return response;
}

describe("Telegram boundary and one-attempt transport", () => {
  test("validates ids, dates, edit timestamps and sender objects at the boundary", () => {
    expect(parseTelegramUpdate(payload("108"))).not.toBeNull();
    expect(parseTelegramUpdate(payload("108", 1.5))).toBeNull();
    expect(parseTelegramUpdate(payload("108", 1, 1, { from: { id: 100, is_bot: "false" } }))).toBeNull();
    expect(parseTelegramUpdate({ update_id: 1, edited_message: payload("1").message })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 1, message: payload("1").message, my_chat_member: {} })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 1, message: { ...payload("1").message, edit_date: date - 1 } })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 1, my_chat_member: { chat: { id: -1001, type: "group" }, date, new_chat_member: { status: "restricted", can_send_messages: "false" } } })).toBeNull();
  });

  test("success is confirmed only from a verified message id", async () => {
    expect(await sendTelegramMessage("test", -1001, "hello")).toEqual({ state: "SENT", messageId: 999 });
    expect(network).toHaveBeenCalledTimes(1);
  });

  test("API rejection is known failure and 429 retains retry delay", async () => {
    network.mockImplementation(fakeFetch(async () => Response.json({ ok: false, error_code: 429, description: "ignored", parameters: { retry_after: 30 } })));
    expect(await sendTelegramMessage("test", -1001, "hello")).toEqual({ state: "FAILED_KNOWN", error: "Telegram rejected the request (429)", retryAfterSeconds: 30 });
    expect(network).toHaveBeenCalledTimes(1);
  });

  test("disconnect after accepting a request is uncertain with no internal retry", async () => {
    network.mockImplementation(fakeFetch(async () => { throw new TypeError("simulated lost response"); }));
    expect((await sendTelegramMessage("test", -1001, "hello")).state).toBe("UNCERTAIN");
    expect(network).toHaveBeenCalledTimes(1);
  });

  test("non-JSON or unrecognized responses remain uncertain", async () => {
    network.mockImplementation(fakeFetch(async () => new Response("gateway failure", { status: 502 })));
    expect((await sendTelegramMessage("test", -1001, "hello")).state).toBe("UNCERTAIN");
    network.mockImplementation(fakeFetch(async () => Response.json({ ok: true, result: {} })));
    expect((await sendTelegramMessage("test", -1001, "hello")).state).toBe("UNCERTAIN");
    network.mockImplementation(fakeFetch(async () => Response.json({ ok: false, error_code: 500 }, { status: 500 })));
    expect((await sendTelegramMessage("test", -1001, "hello")).state).toBe("UNCERTAIN");
    network.mockImplementation(fakeFetch(async () => Response.json({ ok: true, result: { message_id: 0 } })));
    expect((await sendTelegramMessage("test", -1001, "hello")).state).toBe("UNCERTAIN");
  });
});

describe("durable webhook", () => {
  test("rejects unauthenticated and malformed requests without contributions", async () => {
    const env = await environment();
    expect((await invoke(env, payload("108"), "wrong")).status).toBe(401);
    expect((await invoke(env, { update_id: "1" })).status).toBe(400);
    expect((await invoke(env, payload("1".repeat(70_000)))).status).toBe(413);
    expect((await totals(env.DB, "test")).total).toBe("0");
    expect(network).not.toHaveBeenCalled();
  });

  test("ordinary successful accumulation is silent and duplicate delivery is durable", async () => {
    const env = await environment();
    for (const update of [payload("1000", 1), payload("2000", 2), payload("108", 3), payload("1000", 1)]) {
      expect((await invoke(env, update)).status).toBe(200);
    }
    expect((await totals(env.DB, "test")).total).toBe("3108");
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM event_log").first("n")).toBe(3);
    expect(network).not.toHaveBeenCalled();
  });

  test("other chats, bots, forwarding, anonymous and private senders cannot add counts or notices", async () => {
    const env = await environment();
    const cases = [
      { chat: { id: -999, type: "supergroup" } },
      { from: { id: 101, is_bot: true } },
      { forward_origin: { type: "user" } },
      { sender_chat: { id: -1001 } },
      { chat: { id: 100, type: "private" } },
      { new_chat_title: "service" },
    ];
    for (let i = 0; i < cases.length; i++) expect((await invoke(env, payload("1000", i + 1, i + 1, cases[i]))).status).toBe(200);
    expect((await totals(env.DB, "test")).total).toBe("0");
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM operational_events WHERE kind='IGNORED'").first("n")).toBe(1);
    expect(network).not.toHaveBeenCalled();
  });

  test("rejected numbers receive one durable explanation; duplicates do not resend it", async () => {
    const env = await environment();
    const invalid = payload("-100");
    expect((await invoke(env, invalid)).status).toBe(200);
    expect((await invoke(env, invalid)).status).toBe(200);
    expect((await totals(env.DB, "test")).total).toBe("0");
    expect(network).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT state FROM notices").first("state")).toBe("SENT");
  });

  test("ambiguous edits notify an administrator once per incident", async () => {
    const env = await environment();
    await invoke(env, { update_id: 1, edited_message: { ...payload("108").message, edit_date: date + 1 } });
    await invoke(env, { update_id: 2, edited_message: { ...payload("1000").message, edit_date: date + 1 } });
    expect((await inspect(env.DB, -1001, 1))?.source_state).toBe("REVIEW");
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM notices WHERE chat_id=42").first("n")).toBe(1);
    await notifyOperators(env.DB, testConfig);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM notices WHERE chat_id=42").first("n")).toBe(1);
  });

  test("storage failure before commit is non-2xx and replay succeeds", async () => {
    const env = await environment();
    const batch = spyOn(env.DB, "batch").mockRejectedValueOnce(new Error("D1 unavailable"));
    expect((await invoke(env, payload("108"))).status).toBe(503);
    batch.mockRestore();
    expect((await invoke(env, payload("108"))).status).toBe(200);
    expect((await totals(env.DB, "test")).total).toBe("108");
  });

  test("migration retains source identity; a new source alias requires its own verified intake boundary", async () => {
    const env = await environment();
    await invoke(env, payload("108", 1));
    await invoke(env, payload("", 2, 2, { migrate_to_chat_id: -2001 }));
    const next=payload("108", 1, 3, { chat: { id: -2001, type: "supergroup" } });
    expect((await invoke(env,next)).status).toBe(503);
    await env.DB.prepare("INSERT INTO automatic_intake_boundaries VALUES('test',-2001,1,NULL,'Verified migrated test source',42,1)").run();
    expect((await invoke(env,next)).status).toBe(200);
    expect((await totals(env.DB, "test")).total).toBe("216");
    expect(await env.DB.prepare("SELECT report_chat_id FROM campaigns WHERE id='test'").first("report_chat_id")).toBe(-2001);
    expect((await inspect(env.DB, -1001, 1))?.effective_amount).toBe(108);
    expect((await inspect(env.DB, -2001, 1))?.effective_amount).toBe(108);
  });

  test("membership loss appears in authenticated health without changing counts", async () => {
    const env = await environment();
    await invoke(env, { update_id: 1, my_chat_member: { chat: { id: -1001, type: "supergroup" }, date, new_chat_member: { status: "kicked" } } });
    const response = await worker.fetch(new Request("https://example.invalid/health", { headers: { "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET } }), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const health = await response.json() as { status: string; missingAccess: unknown[] };
    expect(health.status).toBe("degraded");
    expect(health.missingAccess).toHaveLength(1);
    expect((await totals(env.DB, "test")).total).toBe("0");
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM notices WHERE chat_id=42").first("n")).toBe(1);
    await notifyOperators(env.DB, testConfig);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM notices WHERE chat_id=42").first("n")).toBe(1);
  });

  test("migration of a separate report chat never enables accumulation there", async () => {
    const env = await environment(testConfig.startDay,-3001);
    await env.DB.prepare("UPDATE deployment_identity SET report_chat_id=-3001").run();
    await invoke(env, payload("", 1, 1, { chat: { id: -3001, type: "group" }, migrate_to_chat_id: -4001 }));
    expect(await env.DB.prepare("SELECT report_chat_id FROM campaigns WHERE id='test'").first("report_chat_id")).toBe(-4001);
    expect(await env.DB.prepare("SELECT chat_id FROM chat_aliases WHERE chat_id=-4001").first("chat_id")).toBeNull();
    await invoke(env, payload("108", 2, 2, { chat: { id: -4001, type: "supergroup" } }));
    expect((await totals(env.DB, "test")).total).toBe("0");
  });

  test("leaving a retired migrated group does not report a current access failure", async () => {
    const env = await environment();
    await invoke(env, payload("108", 1));
    await invoke(env, payload("", 2, 2, { migrate_to_chat_id: -2001 }));
    await env.DB.prepare("INSERT INTO automatic_intake_boundaries VALUES('test',-2001,1,NULL,'Verified migrated test source',42,1)").run();
    await invoke(env, { update_id: 3, my_chat_member: { chat: { id: -1001, type: "group" }, date, new_chat_member: { status: "kicked" } } });
    const response = await worker.fetch(new Request("https://example.invalid/health", { headers: { "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET } }), env, {} as ExecutionContext);
    const health = await response.json() as { status: string; missingAccess: unknown[] };
    expect(health.status).toBe("ok");
    expect(health.missingAccess).toHaveLength(0);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM notices WHERE chat_id=42").first("n")).toBe(0);
    expect((await inspect(env.DB, -1001, 1))?.effective_amount).toBe(108);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM chat_aliases WHERE chat_id=-1001").first("n")).toBe(1);
  });
});

describe("private administration", () => {
  test("numeric allowlist and private context are both required", async () => {
    const env = await environment();
    await invoke(env, payload("108", 1));
    await invoke(env, admin("/override -1001 1 500 bad actor", 2, 43));
    await invoke(env, payload("/override -1001 1 500 wrong context", 3, 1003, { from: { id: 42, is_bot: false } }));
    expect((await inspect(env.DB, -1001, 1))?.effective_amount).toBe(108);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM admin_adjustments").first("n")).toBe(0);
  });

  test("override, replay, participant edit and explicit release preserve audit", async () => {
    const env = await environment();
    await invoke(env, payload("108", 1));
    const command = admin("/override -1001 1 500 confirmed with participant", 2);
    expect((await invoke(env, command)).status).toBe(200);
    expect((await invoke(env, command)).status).toBe(200);
    await invoke(env, { update_id: 10, edited_message: { ...payload("1000", 1).message, edit_date: date + 1 } });
    expect((await inspect(env.DB, -1001, 1))?.effective_amount).toBe(500);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM admin_adjustments").first("n")).toBe(1);
    expect((await invoke(env, admin("/release -1001 1 participant correction verified", 3))).status).toBe(200);
    expect((await inspect(env.DB, -1001, 1))?.effective_amount).toBe(1000);
  });

  test("missed-message import deduplicates and explains an already existing source", async () => {
    const env = await environment();
    const command = admin("/import -1001 50 108 2026-11-03T10:00:00Z Telegram Desktop export checked", 1);
    expect((await invoke(env, command)).status).toBe(200);
    expect((await invoke(env, command)).status).toBe(200);
    expect((await invoke(env, admin("/import -1001 50 108 2026-11-03T10:00:00Z second check", 2))).status).toBe(200);
    expect((await totals(env.DB, "test")).total).toBe("108");
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM admin_adjustments").first("n")).toBe(1);
  });

  test("recovery pause and human reconciliation are durable and audited", async () => {
    const env = await environment();
    expect((await invoke(env, admin("/recovery 2026-11-03T00:00:00Z restored independent backup", 1))).status).toBe(200);
    expect(await env.DB.prepare("SELECT reconciled_at FROM recovery_state").first("reconciled_at")).toBeNull();
    await env.DB.prepare("UPDATE recovery_state SET restored_at=restored_at-2000").run();
    expect((await invoke(env, admin("/reconcile compared full export and imported missing messages", 2))).status).toBe(200);
    expect(await env.DB.prepare("SELECT reconciled_by FROM recovery_state").first("reconciled_by")).toBe(42);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM operational_events WHERE kind LIKE 'RECOVERY_%'").first("n")).toBe(2);
  });

  test("redelivered pre-restore commands cannot unpause or authorize resending", async () => {
    const env = await environment();
    await invoke(env, admin("/recovery 2026-11-03T00:00:00Z restored backup", 1));
    const oldReconcile = admin("/reconcile historical approval", 2);
    oldReconcile.message.date = date;
    const oldRetry = admin("/report_retry 2026-11-03 historical approval", 3);
    oldRetry.message.date = date;
    expect((await invoke(env, oldReconcile)).status).toBe(200);
    expect((await invoke(env, oldRetry)).status).toBe(200);
    expect(await env.DB.prepare("SELECT reconciled_at FROM recovery_state").first("reconciled_at")).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM report_resolutions").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM operational_events WHERE kind='STALE_RECOVERY_COMMAND'").first("n")).toBe(2);
  });
});

describe("notification uncertainty", () => {
  test("a lost response stays uncertain across later delivery attempts", async () => {
    const env = await environment();
    await initialize(env.DB, testConfig);
    await enqueueNotice(env.DB, testConfig, "notice-test", 42, "test", Date.now());
    network.mockImplementation(fakeFetch(async () => { throw new TypeError("simulated loss"); }));
    await deliverNotices(env.DB, testConfig, env.BOT_TOKEN);
    await deliverNotices(env.DB, testConfig, env.BOT_TOKEN);
    expect(network).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT state FROM notices").first("state")).toBe("UNCERTAIN");
  });

  test("a crashed sender lease becomes uncertain without sending", async () => {
    const env = await environment();
    await initialize(env.DB, testConfig);
    await enqueueNotice(env.DB, testConfig, "crash", 42, "test", Date.now());
    await env.DB.prepare("UPDATE notices SET state='SENDING',claimed_at=1 WHERE notice_key='crash'").run();
    await deliverNotices(env.DB, testConfig, env.BOT_TOKEN);
    expect(network).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT state FROM notices").first("state")).toBe("UNCERTAIN");
  });

  test("seven-day cron catchup with alerts and backlog stays below Free subrequest limit", async () => {
    const env = await environment("2020-01-01");
    const config = { ...testConfig, startDay: env.CAMPAIGN_START };
    await initialize(env.DB, config);
    for (let i = 0; i < 5; i++) await enqueueNotice(env.DB, config, `backlog-${i}`, 42, "test", i + 1);
    let dbRequests = 0;
    const prepare = env.DB.prepare.bind(env.DB);
    const batch = env.DB.batch.bind(env.DB);
    spyOn(env.DB, "prepare").mockImplementation(sql => { dbRequests++; return prepare(sql); });
    spyOn(env.DB, "batch").mockImplementation(statements => {
      // A D1 batch is one Worker subrequest; all prepared statements here execute once.
      dbRequests += 1 - statements.length;
      return batch(statements);
    });
    network.mockImplementation(fakeFetch(async () => { throw new TypeError("simulated network loss"); }));
    await worker.scheduled({} as ScheduledController, env, {} as ExecutionContext);
    expect(network).toHaveBeenCalledTimes(9);
    expect(dbRequests + network.mock.calls.length).toBeLessThanOrEqual(50);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM daily_reports WHERE status='UNCERTAIN'").first("n")).toBe(7);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM notices WHERE notice_key LIKE 'alert:%'").first("n")).toBe(7);
  });
});

describe("free conversation MVP regressions", () => {
  test("text/emoji counts, equal independent sessions count separately, success stays silent", async () => {
    const env = await environment();
    for (const [i,text] of ["1000","1000🙏","Сегодня 1000!","Начитал 108 мантр 🙏","Всем привет, накопил 2500"].entries())
      expect((await invoke(env,payload(text,i+1))).status).toBe(200);
    expect((await totals(env.DB,"test")).total).toBe("5608");
    expect(network).not.toHaveBeenCalled();
  });

  test("conversation, photo/video/audio/voice and numeric captions create no ledger or notices", async () => {
    const env = await environment();
    const messages = [payload("Привет всем"),payload("🙏",2),
      ...["photo","video","audio","voice","document"].map((kind,i) => {
        const value = payload("",i+3); const message: Record<string,unknown> = {...value.message};
        delete message.text; message[kind] = {file_id:"local-only"}; message.caption = "1000";
        return {update_id:value.update_id,message};
      })];
    for (const value of messages) expect((await invoke(env,value)).status).toBe(200);
    expect((await totals(env.DB,"test")).messages).toBe(0);
    for (const table of ["event_log","notices","operational_events"])
      expect(await env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n")).toBe(0);
    expect(network).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT last_webhook_at FROM system_heartbeat").first("last_webhook_at")).toBeNumber();
  });

  test("whole parser/edit matrix updates one source, deactivates, preserves override and release", async () => {
    const env = await environment();
    await invoke(env,payload("1000"));
    const edit = (text:string,delta:number) => invoke(env,{update_id:100+delta,edited_message:{...payload(text).message,edit_date:date+delta}});
    await edit("Сегодня 2000🙏",1);
    expect((await totals(env.DB,"test")).total).toBe("2000");
    await edit("Привет",2);
    expect((await totals(env.DB,"test")).total).toBe("0"); expect(network).not.toHaveBeenCalled();
    await edit("1000🙏",3);
    await edit("1000 и 2000",4);
    expect((await totals(env.DB,"test")).total).toBe("0");
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM notices").first("n")).toBe(1);
    await edit("-100",5);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM notices").first("n")).toBe(1);
    await invoke(env,admin("/override -1001 1 500 Проверено",20));
    await edit("Нет числа",6);
    expect((await totals(env.DB,"test")).total).toBe("500");
    await invoke(env,admin("/release -1001 1 Сверено",21));
    expect((await totals(env.DB,"test")).total).toBe("0");
    expect((await totals(env.DB,"test")).messages).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM event_log").first("n")).toBe(7);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM admin_adjustments").first("n")).toBe(2);
  });

  test("edited no-number tombstone received before original prevents resurrection", async () => {
    const env = await environment();
    const edit = {update_id:999,edited_message:{...payload("Привет").message,edit_date:date+10}};
    await invoke(env,edit); await invoke(env,payload("1000")); await invoke(env,edit);
    expect((await totals(env.DB,"test")).total).toBe("0");
    expect((await inspect(env.DB,-1001,1))?.version_date).toBe(date+10);
    await invoke(env,{update_id:1,edited_message:{...payload("1000🙏").message,edit_date:date+11}});
    expect((await totals(env.DB,"test")).total).toBe("1000");
    expect(network).not.toHaveBeenCalled();
  });

  test("initial conversation then numeric edit creates the first contribution", async () => {
    const env = await environment(); await invoke(env,payload("Привет"));
    expect((await totals(env.DB,"test")).messages).toBe(0);
    await invoke(env,{update_id:500,edited_message:{...payload("1000🙏").message,edit_date:date+1}});
    expect((await totals(env.DB,"test")).total).toBe("1000"); expect(network).not.toHaveBeenCalled();
  });

  test("fresh update IDs for the same invalid message cannot create a notice flood", async () => {
    const env = await environment();
    for (let i=1;i<=20;i++) await invoke(env,payload("-100",1,i));
    expect((await totals(env.DB,"test")).total).toBe("0");
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM notices").first("n")).toBe(1);
    expect(network).toHaveBeenCalledTimes(1);
  });

  test("format entities exclude numeric links and code, malformed entities are rejected", async () => {
    const env = await environment();
    await invoke(env,payload("1000",1,1,{entities:[{type:"text_link",offset:0,length:4,url:"https://example.org"}]}));
    await invoke(env,payload("1000",2,2,{entities:[{type:"code",offset:0,length:4}]}));
    expect((await totals(env.DB,"test")).messages).toBe(0);
    expect((await invoke(env,payload("108",3,3,{entities:[{type:"code",offset:-1,length:3}]}))).status).toBe(400);
    expect((await invoke(env,payload("108",3,3,{entities:[{type:"code",offset:0,length:4}]}))).status).toBe(400);
    expect(network).not.toHaveBeenCalled();
  });
});

describe("TEST resource isolation fails closed", () => {
  test("other environment, bot identity, campaign, D1 marker and unprovisioned DB reject before ledger writes", async () => {
    for (const change of [
      {DEPLOYMENT_ENV:"production"}, {EXPECTED_BOT_ID:"987654"},
      {EXPECTED_D1_ID:"22222222-2222-2222-2222-222222222222"}, {CAMPAIGN_ID:"production"},
      {ALLOWED_CHAT_IDS:"-999"},
    ]) {
      const env = {...await environment(),...change};
      expect((await invoke(env,payload("108"))).status).toBe(503);
      expect(await env.DB.prepare("SELECT COUNT(*) n FROM contributions").first("n")).toBe(0);
      expect(await env.DB.prepare("SELECT COUNT(*) n FROM campaigns").first("n")).toBe(1);
    }
    const env = await environment(); env.DB = await createTestDb();
    expect((await invoke(env,payload("108"))).status).toBe(503);
    expect(network).not.toHaveBeenCalled();
  });

  test("TEST webhook secret is rejected by a second environment before any DB access", async () => {
    const env = await environment();
    const second = {...env,WEBHOOK_SECRET:"separate-other-environment-secret",DEPLOYMENT_ENV:"production"};
    expect((await invoke(second,payload("108"),env.WEBHOOK_SECRET)).status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM campaigns").first("n")).toBe(1);
  });

  test("reloaded Worker using the same D1 does not duplicate a committed contribution", async () => {
    const env = await environment(); const value=payload("1000🙏");
    expect((await invoke(env,value)).status).toBe(200);
    const fresh = await import(`../src/worker.ts?reload=${Date.now()}`);
    const response=await fresh.default.fetch(new Request("https://example.invalid/webhook",{
      method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":env.WEBHOOK_SECRET},body:JSON.stringify(value),
    }),env,{waitUntil:()=>{}});
    expect(response.status).toBe(200);
    expect((await totals(env.DB,"test")).total).toBe("1000");
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM event_log").first("n")).toBe(1);
  });
});


test("opt-in TEST diagnostics persist structural evidence for ignored group contexts without their contents", async()=>{
  const env=await environment();env.TEST_INPUT_DIAGNOSTICS="true";
  await invoke(env,payload("108",501,501,{sender_chat:{id:-2001,title:"private sender"}}));
  const row=await env.DB.prepare("SELECT detail FROM operational_events WHERE kind='TEST_INPUT_DIAGNOSTIC'").first<{detail:string}>();
  const detail=JSON.parse(row!.detail);
  expect(detail.chatId).toBe(-1001);expect(detail.hasSenderChat).toBe(true);expect(detail.numericKind).toBe("ONE_VALID");
  expect(detail.parserAccepted).toBe(true);expect(row!.detail).not.toContain("private sender");
  expect((await totals(env.DB,"test")).total).toBe("0");
});

test("invalid numeric inputs warn once outside silence; silence backlog stays held",async()=>{
  const env=await environment();
  const {setSilence}=await import("../src/controls");
  const invalid=payload("1.5",601);
  expect((await invoke(env,invalid)).status).toBe(200);await invoke(env,invalid);
  expect(network).toHaveBeenCalledTimes(1);
  await invoke(env,payload("1000 и 2000",602));expect(network).toHaveBeenCalledTimes(2);
  const now=Date.now();await setSilence(env.DB,testConfig,true,42,"fraction-silent-on",now);
  await invoke(env,payload("2.5",603));expect(network).toHaveBeenCalledTimes(2);
  await setSilence(env.DB,testConfig,false,42,"fraction-silent-off",now+1);
  await deliverNotices(env.DB,testConfig,env.BOT_TOKEN);expect(network).toHaveBeenCalledTimes(2);
  await invoke(env,payload("3.5",604,604,{date:Math.ceil(Date.now()/1000)+1}));
  expect(network).toHaveBeenCalledTimes(3);
  expect(await env.DB.prepare("SELECT state,publication_hold FROM notices WHERE reply_message_id=603").first())
    .toEqual({state:"PENDING",publication_hold:1});
  expect((await totals(env.DB,"test")).total).toBe("0");
});

test("TEST bot intake and private administration require exact sender/chat and verified D1 identity", async () => {
  const env=await environment();
  env.TEST_SENDER_BOT_ID="101"; env.TEST_SENDER_CHAT_ID="-1001"; env.ADMIN_IDS="42,101";
  await invoke(env,payload("108",701,701,{from:{id:101,is_bot:true}}));
  expect((await totals(env.DB,"test")).total).toBe("108");
  for(const extra of [{from:{id:102,is_bot:true}}, {from:{id:101,is_bot:true},chat:{id:-1002,type:"supergroup"}},
    {from:{id:101,is_bot:true},sender_chat:{id:-1001}}, {from:{id:101,is_bot:true},forward_origin:{type:"user"}}]) {
    await invoke(env,payload("108",702,702,extra));
  }
  expect((await totals(env.DB,"test")).total).toBe("108");
  const dm=payload("/silent on",710,710,{date:Math.floor(Date.now()/1000),from:{id:101,is_bot:true},chat:{id:101,type:"private"}});
  await invoke(env,dm);
  expect(await env.DB.prepare("SELECT silent FROM campaign_controls").first("silent")).toBe(1);
  await env.DB.prepare("UPDATE deployment_identity SET bot_id=654321").run();
  expect((await invoke(env,payload("1000",711,711,{from:{id:101,is_bot:true}}))).status).toBe(503);
  expect((await totals(env.DB,"test")).total).toBe("108");
});

test("TEST sender configuration fails closed for production, partial IDs, self and foreign chat", async()=>{
  const {getConfig}=await import("../src/config");
  const env=await environment();
  for(const patch of [
    {TEST_SENDER_BOT_ID:"101"}, {TEST_SENDER_CHAT_ID:"-1001"},
    {TEST_SENDER_BOT_ID:"123456",TEST_SENDER_CHAT_ID:"-1001"},
    {TEST_SENDER_BOT_ID:"101",TEST_SENDER_CHAT_ID:"-999"},
    {TEST_SENDER_BOT_ID:"101,102",TEST_SENDER_CHAT_ID:"-1001"},
    {DEPLOYMENT_ENV:"production",CAMPAIGN_ID:"sangha-production",ALLOWED_CHAT_IDS:"-1001234567891",REPORT_CHAT_ID:"-1001234567891",TEST_SENDER_BOT_ID:"101",TEST_SENDER_CHAT_ID:"-1001234567891"},
  ]) expect(()=>getConfig({...env,...patch})).toThrow();
});

test("required numeric matrix, media and edits preserve one notice per source in both silence states",async()=>{
  for(const silent of [false,true]) {
    const env=await environment();
    if(silent) {const {setSilence}=await import("../src/controls");await setSilence(env.DB,testConfig,true,42,"matrix-on",Date.now());}
    const initialCalls=network.mock.calls.length;
    const texts=["1000","1000🙏","10 и 10","1000 2000","1.5","0","Привет"];
    for(const [i,text] of texts.entries()) {
      const input=payload(text,800+i);await invoke(env,input);await invoke(env,input);
    }
    await invoke(env,payload("",810,810,{photo:[{file_id:"test"}],caption:"500"}));
    await invoke(env,payload("",811,811,{video:{file_id:"test"},caption:"500"}));
    expect((await totals(env.DB,"test")).total).toBe("2000");
    expect(network.mock.calls.length-initialCalls).toBe(silent ? 0:4);
    const base=payload("10 и 10",802).message;
    for(const [i,text] of ["12 и 13","108","1.5","108"].entries()) {
      const update={update_id:900+i,edited_message:{...base,text,edit_date:date+i+1}};
      await invoke(env,update);await invoke(env,update);
    }
    expect((await totals(env.DB,"test")).total).toBe("2108");
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM notices WHERE reply_message_id=802").first("n")).toBe(1);
    expect(network.mock.calls.length-initialCalls).toBe(silent ? 0:4);
  }
});
