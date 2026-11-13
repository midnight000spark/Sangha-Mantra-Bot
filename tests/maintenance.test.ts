import { beforeEach, afterEach, expect, spyOn, test } from "bun:test";
import { initializeTestDb as initialize } from "./db";
import { adjust, importContribution, ingest, inspect, totals } from "../src/core";
import { deliverNotices, enqueueNotice, handleAdmin } from "../src/admin";
import { silenceState, setSilence } from "../src/controls";
import { adminHelp } from "../src/admin-text";
import { resolveReport, runReports } from "../src/reports";
import { createTestDb, testConfig } from "./db";
import worker from "../src/worker";
import { seedIdentity } from "./db";
import type { Env, ContributionEvent } from "../src/types";

const config = { ...testConfig, startDay: "2026-11-10" };
const date = Date.parse("2026-11-10T10:00:00Z") / 1000;
const now = Date.parse("2026-11-10T21:05:00Z");
let db: D1Database;
let sends: { chat_id: number; text: string }[];
let network: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeEach(async () => {
  db = await createTestDb(); await initialize(db, config); sends = [];
  network = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
    sends.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: 100 + sends.length } });
  }) as typeof fetch);
});
afterEach(() => network.mockRestore());
const event = (id: number, amount: number, edit = false, delta = 0): ContributionEvent => ({
  key: `event-${id}-${amount}-${edit}-${delta}`, updateId: id + delta, chatId: -1001, messageId: id,
  userId: 7, originalDate: date, versionDate: date + delta, isEdit: edit, amount,
  state: amount ? "VALID" : "INVALID", reason: null, now,
});
async function boundary(first: number | null, time: number | null = null) {
  await db.prepare(`INSERT INTO automatic_intake_boundaries VALUES(?,-1001,?,?, 'Operator-approved test boundary',42,?) ON CONFLICT(campaign_id,chat_id) DO UPDATE SET first_message_id=excluded.first_message_id,original_not_before=excluded.original_not_before`)
    .bind(config.campaignId, first, time, now).run();
}
async function command(text: string, key = text, actor = 42, type: "private" | "supergroup" = "private") {
  return handleAdmin(db, config, { service: false, message_id: 555, date: now/1000, from: { id: actor, is_bot: false },
    chat: { id: type === "private" ? actor : -1001, type }, text }, key, now);
}
async function reply(key: string) { return String(await db.prepare("SELECT body FROM notices WHERE notice_key=?").bind(`admin:${key}`).first("body")); }
const groupSends = () => sends.filter(r => r.chat_id < 0);

for (const reverse of [false,true]) test(`old 500/2700 edits and delayed originals cannot create new ledger rows, order=${reverse}`, async () => {
  await boundary(41);
  const events = [event(32,500,true,10000),event(38,2700,true,20000),event(32,500),event(38,2700)];
  if (reverse) events.reverse();
  for (const e of [...events,...events]) expect((await ingest(db,config,e)).outcome).toBe("REJECTED");
  expect((await totals(db,config.campaignId)).total).toBe("0");
  expect(await inspect(db,-1001,32)).toBeNull(); expect(await inspect(db,-1001,38)).toBeNull();
  expect(await db.prepare("SELECT COUNT(*) n FROM event_log").first("n")).toBe(4);
  await ingest(db,config,event(41,14950)); await ingest(db,config,event(42,1000));
  await ingest(db,config,event(42,2000,true,10));
  expect((await totals(db,config.campaignId)).total).toBe("16950");
  await ingest(db,config,event(42,0,true,11));
  expect((await totals(db,config.campaignId)).total).toBe("14950");
});

test("timestamp boundary uses original date rather than edit date and explicit historical import stays possible", async () => {
  await boundary(null,date+1);
  expect((await ingest(db,config,event(50,500,true,10000))).outcome).toBe("REJECTED");
  await importContribution(db,config,{key:"import",actorId:42,chatId:-1001,messageId:30,amount:14950,originalDate:date,reason:"Verified historical aggregate",now});
  await ingest(db,config,event(30,500,true,10000));
  expect((await inspect(db,-1001,30))?.effective_amount).toBe(14950);
  const modern={...event(51,108),originalDate:date+1,versionDate:date+1};
  expect((await ingest(db,config,modern)).outcome).toBe("APPLIED");
});

test("existing historical rows and both zero overrides survive boundary installation and late edits", async () => {
  for(const [id,amount] of [[32,500],[38,2700]] as const) {
    await ingest(db,config,event(id,amount,true,1));
    await adjust(db,config,{key:`already-corrected-${id}`,actorId:42,chatId:-1001,messageId:id,amount:0,reason:"Already included in initial transfer",now});
  }
  const before=JSON.stringify((await db.prepare("SELECT * FROM admin_adjustments ORDER BY adjustment_key").all()).results);
  await boundary(41);
  for(const id of [32,38]) for(const e of [event(id,999,true,20),event(id,999,true,20)]) await ingest(db,config,e);
  expect((await totals(db,config.campaignId)).total).toBe("0");
  expect(JSON.stringify((await db.prepare("SELECT * FROM admin_adjustments ORDER BY adjustment_key").all()).results)).toBe(before);
});

test("silence persists, repeated/concurrent ON is safe, duplicate ON cannot undo subsequent OFF", async () => {
  await Promise.all([setSilence(db,config,true,42,"on-a",now),setSilence(db,config,true,42,"on-b",now+1)]);
  const initial=await silenceState(db,config.campaignId); expect(initial.silent).toBe(1);
  await initialize(db,config); expect(await silenceState(db,config.campaignId)).toEqual(initial);
  await setSilence(db,config,false,42,"off",now+2);
  await setSilence(db,config,true,42,"on-a",now+3);
  expect((await silenceState(db,config.campaignId)).silent).toBe(0);
  expect(await db.prepare("SELECT COUNT(*) n FROM operational_events WHERE kind='SILENT_CHANGE'").first("n")).toBe(3);
});

test("silence blocks pending and new group notices and reports while count/edit/override/admin help continue", async () => {
  await enqueueNotice(db,config,"old",-1001,"old",now);
  await setSilence(db,config,true,42,"on",now);
  await enqueueNotice(db,config,"new",-1001,"new",now+1);
  await ingest(db,config,event(51,1000)); await ingest(db,config,event(51,2000,true,1));
  await adjust(db,config,{key:"correction",actorId:42,chatId:-1001,messageId:51,amount:108,reason:"Checked",now});
  await ingest(db,config,event(51,3000,true,2));
  await command("/help"); await deliverNotices(db,config,"test");
  await runReports(db,config,"test",now);
  expect(groupSends()).toHaveLength(0); expect(sends.some(r=>r.chat_id===42)).toBe(true);
  expect((await totals(db,config.campaignId)).total).toBe("108");
  expect(await db.prepare("SELECT status FROM daily_reports").first("status")).toBe("PENDING");
  expect(await db.prepare("SELECT publication_hold FROM daily_reports").first("publication_hold")).toBe(1);
  expect(await db.prepare("SELECT COUNT(*) n FROM notices WHERE chat_id<0 AND publication_hold=1").first("n")).toBe(2);
});

test("OFF never bursts backlog, held report and notice require individual audited release", async () => {
  await setSilence(db,config,true,42,"on",now);
  await enqueueNotice(db,config,"held",-1001,"held",now);
  await runReports(db,config,"test",now);
  await setSilence(db,config,false,42,"off",now+1);
  await runReports(db,config,"test",now+2); await deliverNotices(db,config,"test");
  expect(groupSends()).toHaveLength(0);
  await command("/report_retry 2026-11-10 Checked absent","release-report");
  await runReports(db,config,"test",now+3); expect(groupSends()).toHaveLength(1);
  await command("/notice_retry held Checked absent","release-notice");
  await deliverNotices(db,config,"test"); expect(groupSends()).toHaveLength(2);
  await runReports(db,config,"test",now+4); await deliverNotices(db,config,"test");
  expect(groupSends()).toHaveLength(2);
  expect(await db.prepare("SELECT COUNT(*) n FROM operational_events WHERE kind IN ('HELD_REPORT_RELEASE','NOTICE_RESOLUTION')").first("n")).toBe(2);
});

test("OFF watermark holds reports that were not materialized by Cron during a long silence", async () => {
  await setSilence(db,config,true,42,"on",now);
  await setSilence(db,config,false,42,"off",now+10*86400_000);
  for(let i=0;i<3;i++) await runReports(db,config,"test",now+10*86400_000);
  expect(groupSends()).toHaveLength(0);
  expect(await db.prepare("SELECT COUNT(*) n FROM daily_reports WHERE publication_hold=1").first("n")).toBe(11);
  await runReports(db,config,"test",now+11*86400_000);
  expect(groupSends()).toHaveLength(1);
});

test("redundant OFF never suppresses ordinary overdue reports", async () => {
  await setSilence(db,config,false,42,"off",now);
  await runReports(db,config,"test",now); expect(groupSends()).toHaveLength(1);
});

test("UNCERTAIN is never retried by silence toggling; held release replay cannot retry a later uncertain send", async () => {
  await setSilence(db,config,true,42,"on",now); await runReports(db,config,"test",now);
  await setSilence(db,config,false,42,"off",now+1);
  const r={day:"2026-11-10",action:"retry" as const,adminId:42,reason:"Checked absent",idempotencyKey:"single-release"};
  expect(await resolveReport(db,config,r,now+2)).toBe(true);
  await runReports(db,config,"test",now+3,async()=>({state:"UNCERTAIN",error:"lost response"}));
  expect(await resolveReport(db,config,r,now+4)).toBe(false);
  await setSilence(db,config,true,42,"on2",now+5); await setSilence(db,config,false,42,"off2",now+6);
  await runReports(db,config,"test",now+7);
  expect(await db.prepare("SELECT status FROM daily_reports").first("status")).toBe("UNCERTAIN");
  expect(groupSends()).toHaveLength(0);
});

test("private administrator authorization is enforced, status/help work while silent", async () => {
  expect(await command("/silent", "outsider",77)).toBe(false);
  expect(await command("/silent", "group",42,"supergroup")).toBe(false);
  expect((await silenceState(db,config.campaignId)).silent).toBe(0);
  await command("/silent", "admin-on"); await command("/silent status", "status");
  await command("/silent nonsense", "bad"); await command("/help", "help");
  expect(await reply("status")).toContain("включена"); expect(await reply("bad")).toContain("Используйте");
  const help=await reply("help"); expect(help).toContain("Для участников"); expect(help).toContain("Для ответственных");
  expect(help).toContain("UNCERTAIN"); expect(help).toContain("docs/RUNBOOK.md"); expect(help.length).toBeLessThanOrEqual(4000);
  expect(adminHelp(config)).toBe(help);
});

test("Russian status and inspect, legacy JSON, correction/import/release confirmations and invalid args", async () => {
  await ingest(db,config,event(41,28050)); await command("/status","status");
  const body=await reply("status"); expect(body).toContain("Накоплено: 28 050"); expect(body).toContain("Осталось: 971 950"); expect(body).toContain("2,805%");
  await command("/status json","json"); expect(JSON.parse(await reply("json")).summary.total).toBe("28050");
  await command("/inspect -1001 41","inspect"); expect(await reply("inspect")).toContain("Фактически учтено: 28 050");
  await command("/inspect -1001 41 json","inspect-json"); expect(JSON.parse(await reply("inspect-json")).source_amount).toBe(28050);
  await command("/override -1001 41 0 Already counted","override"); expect(await reply("override")).toContain("28 050 → 0");
  expect(await reply("override")).not.toContain("nonce"); expect(await reply("override")).toContain("Already counted");
  await command("/release -1001 41 Verified","release"); expect(await reply("release")).toContain("0 → 28 050");
  await command("/import -1001 60 108 2026-11-10T12:00:00+03:00 Verified source","import"); expect(await reply("import")).toContain("0 → 108");
  await command("/override -1001 41 wrong Reason","invalid"); expect(await reply("invalid")).toContain("Нужны");
  await command("/reports","reports"); await command("/notices","notices");
  expect(await reply("reports")).not.toContain('[{'); expect(await reply("notices")).not.toContain('[{');
});

test("Worker restart/replayed webhook honors cutoff, silent commands in replies and deduplicated multi-number warnings", async () => {
  await seedIdentity(db); await boundary(41);
  const env={DB:db,DEPLOYMENT_ENV:"test",EXPECTED_D1_ID:"11111111-1111-1111-1111-111111111111",EXPECTED_BOT_ID:"123456",BOT_TOKEN:"123456:local-token",WEBHOOK_SECRET:"local-secret-123456",ADMIN_IDS:"42",CAMPAIGN_ID:config.campaignId,TIMEZONE:config.timezone,CAMPAIGN_START:config.startDay,REPORT_TIME:config.reportTime,GOAL:"1000000",MAX_AMOUNT:"1000000",ALLOWED_CHAT_IDS:"-1001,-1002",REPORT_CHAT_ID:"-1001"} as Env;
  async function submit(payload:unknown, handler=worker) {
    const tasks:Promise<unknown>[]=[];
    const response=await handler.fetch(new Request("https://local.test/webhook",{method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":env.WEBHOOK_SECRET},body:JSON.stringify(payload)}),env,{waitUntil:(p:Promise<unknown>)=>tasks.push(p)} as unknown as ExecutionContext);
    await Promise.all(tasks); expect(response.status).toBe(200);
  }
  const message={message_id:32,date,edit_date:date+10000,chat:{id:-1001,type:"supergroup"},from:{id:7,is_bot:false},text:"500"};
  const old={update_id:1,edited_message:message}; await submit(old);
  const fresh=(await import(`../src/worker.ts?restart=${crypto.randomUUID()}`)).default;
  await submit(old,fresh); expect((await totals(db,config.campaignId)).total).toBe("0");
  await submit({update_id:2,message:{...message,message_id:55,edit_date:undefined,text:"1000🙏"}});
  for(const [index,text] of ["2 раза по 108","1 000","1000 и 2000","Привет"].entries()) await submit({update_id:3+index,edited_message:{...message,message_id:55,edit_date:date+10001+index,text}});
  expect((await totals(db,config.campaignId)).total).toBe("0"); expect(groupSends()).toHaveLength(1);
  await submit({update_id:10,message:{message_id:100,date,chat:{id:42,type:"private"},from:{id:42,is_bot:false},text:"/silent on",reply_to_message:{message_id:99}}});
  expect((await silenceState(db,config.campaignId)).silent).toBe(1);
});

test("unconfigured intake fails closed without acknowledging or persisting a new contribution; approved replay succeeds", async()=>{
  const empty=await createTestDb();
  const {initialize: realInitialize}=await import("../src/config");
  await realInitialize(empty,config);
  await expect(ingest(empty,config,event(999,108))).rejects.toThrow("boundary");
  expect(await empty.prepare("SELECT COUNT(*) n FROM event_log").first("n")).toBe(0);
  const report=await runReports(empty,config,"test",now);
  expect(report.paused).toBe(true); expect(await empty.prepare("SELECT COUNT(*) n FROM daily_reports").first("n")).toBe(0);
  await initialize(empty,config);
  expect((await ingest(empty,config,event(999,108))).outcome).toBe("APPLIED");
});

test("delayed notices for events before OFF remain held even when processed after OFF", async()=>{
  await setSilence(db,config,true,42,"on",now);
  await setSilence(db,config,false,42,"off",now+2000);
  await enqueueNotice(db,config,"delayed",-1001,"old event",now+3000,1,now+1000);
  await enqueueNotice(db,config,"fresh",-1001,"new event",now+4000,2,now+4000);
  await deliverNotices(db,config,"test",now+5000);
  expect(groupSends().map(r=>r.text)).toEqual(["new event"]);
  expect(await db.prepare("SELECT publication_hold FROM notices WHERE notice_key='delayed'").first("publication_hold")).toBe(1);
});

test("old OFF command cannot override silence restored from a backup",async()=>{
  await setSilence(db,config,true,42,"on",now);
  await db.prepare("INSERT INTO recovery_state(campaign_id,restored_at,backup_at,reason) VALUES(?,?,?,'Test restore')")
    .bind(config.campaignId,now+1000,now-10000).run();
  await command("/silent off","stale-off");
  expect((await silenceState(db,config.campaignId)).silent).toBe(1);
  expect(await reply("stale-off")).toContain("до восстановления");
});
