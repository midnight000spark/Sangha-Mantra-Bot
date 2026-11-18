import { expect, test, spyOn } from "bun:test";
import { Glob } from "bun";
import { Miniflare, Response as RuntimeResponse } from "miniflare";
import { initializeTestDb as initialize } from "./db";
import { ingest, totals } from "../src/core";
import { deliverNotices, enqueueNotice, handleAdmin } from "../src/admin";
import { silenceState, setSilence as setOrderedSilence } from "../src/controls";
import { setTestSilence as setSilence } from "./db";
import { runReports, resolveReport } from "../src/reports";
import { testConfig, seedIdentity } from "./db";
import { eventKey } from "../src/parser";
import { parseTelegramUpdate } from "../src/telegram";

const config={...testConfig,startDay:"2026-11-10"};
const now=Date.parse("2026-11-10T21:05:00Z");
async function applyMigration(db:D1Database, file:string) {
  let sql="";
  for(const line of (await Bun.file(`migrations/${file}`).text()).split(/\r?\n/)) {
    sql+=line+"\n";
    // The first migration comment must not hide CREATE TRIGGER classification.
    const trigger=/^\s*CREATE TRIGGER/i.test(sql.trim());
    if((trigger && /^END;\s*$/.test(line)) || (!trigger && /;\s*$/.test(line))) {await db.prepare(sql.trim()).run();sql="";}
  }
}
async function runtimeDb(compiled=false, adminIds="42", throughMigration?:string) {
  const sent:{chat_id:number;text:string}[]=[];
  const build=compiled ? await Bun.build({entrypoints:["src/worker.ts"],target:"browser",format:"esm"}) : null;
  if(build && !build.success) throw new Error("bundle failed");
  const runtime=new Miniflare({modules:true,script:build ? await build.outputs[0]!.text():"export default {fetch(){return new Response('ok')}}",
    d1Databases:{DB:"maintenance-runtime"},outboundService:async (_request:unknown) => {
      const request=_request as Request;
      sent.push(await request.json() as {chat_id:number;text:string});
      return new RuntimeResponse(JSON.stringify({ok:true,result:{message_id:sent.length+100}}),{headers:{"Content-Type":"application/json"}});
    },bindings:{DEPLOYMENT_ENV:"test",EXPECTED_D1_ID:"11111111-1111-1111-1111-111111111111",EXPECTED_BOT_ID:"123456",
      BOT_TOKEN:"123456:local-token",WEBHOOK_SECRET:"runtime-secret-1234567890",ADMIN_IDS:adminIds,CAMPAIGN_ID:config.campaignId,
      TIMEZONE:config.timezone,CAMPAIGN_START:config.startDay,REPORT_TIME:config.reportTime,GOAL:"1000000",MAX_AMOUNT:"1000000",ALLOWED_CHAT_IDS:"-1001,-1002",REPORT_CHAT_ID:"-1001"}});
  const db=await runtime.getD1Database("DB") as unknown as D1Database;
  for(const file of Array.from(new Glob("*.sql").scanSync("migrations")).sort()) {
    if(!throughMigration || file<=throughMigration) await applyMigration(db,file);
  }
  await seedIdentity(db); await initialize(db,config);
  return {runtime,db,sent};
}

/** Pause at the actual final D1 gate, before or after its read; no timers or probabilistic races. */
function withGate(db:D1Database, pattern:string, afterRead:boolean, action:()=>Promise<unknown>):D1Database {
  let intercepted=false;
  return new Proxy(db,{get(target,prop) {
    if(prop!=="prepare") {const value=Reflect.get(target,prop);return typeof value==="function" ? value.bind(target):value;}
    return (sql:string) => {
      const original=target.prepare(sql);
      if(!sql.includes(pattern)) return original;
      const wrap=(stmt:D1PreparedStatement):D1PreparedStatement => new Proxy(stmt,{get(s,p) {
        if(p==="bind") return (...values:(string|number|null)[])=>wrap(s.bind(...values));
        if(p==="first") return async()=>{
          if(intercepted) return s.first(); intercepted=true;
          if(afterRead) {const row=await s.first();await action();return row;}
          await action();return s.first();
        };
        const value=Reflect.get(s,p);return typeof value==="function" ? value.bind(s):value;
      }});
      return wrap(original);
    };
  }});
}

for(const afterRead of [false,true]) for(const path of ["notice","report"]) test(`real D1 ${path} ON race ${afterRead ? "after" : "before"} final send gate`,async()=>{
  const {runtime,db}=await runtimeDb(); let sends=0;
  const network=spyOn(globalThis,"fetch").mockImplementation((async()=>{sends++;return Response.json({ok:true,result:{message_id:900}});}) as unknown as typeof fetch);
  try {
    const controlled=withGate(db,path==="notice" ? "SELECT 1 FROM notices WHERE" : "SELECT 1 FROM daily_reports WHERE",afterRead,
      ()=>setSilence(db,config,true,42,`on-${path}`,now));
    if(path==="notice") {await enqueueNotice(db,config,"group",-1001,"test",now);await deliverNotices(controlled,config,"test",now);}
    else await runReports(controlled,config,"test",now,async()=>{sends++;return {state:"SENT",messageId:901};});
    expect(sends).toBe(afterRead ? 1:0);
    const row=await db.prepare(path==="notice" ? "SELECT state status,publication_hold FROM notices":"SELECT status,publication_hold FROM daily_reports").first();
    expect(row).toEqual({status:afterRead ? "SENT":"PENDING",publication_hold:1});
    expect((await silenceState(db,config.campaignId)).silent).toBe(1);
  } finally {network.mockRestore();await runtime.dispose();}
},30_000);

test("compiled Worker F04: source order, repeated ON, cross-admin ties, stale holds and recovery boundary",async()=>{
  const {runtime,db,sent}=await runtimeDb(true,"42,43");
  let receipt=1000;
  const date=now/1000;
  const command=async(on:boolean,at:number,id:number,actor=42)=>{
    const response=await runtime.dispatchFetch("https://local.test/webhook",{method:"POST",
      headers:{"X-Telegram-Bot-Api-Secret-Token":"runtime-secret-1234567890"},
      body:JSON.stringify({update_id:++receipt,message:{message_id:id,date:at,chat:{id:actor,type:"private"},
        from:{id:actor,is_bot:false},text:`/silent ${on ? "on":"off"}`}})});
    expect(response.status).toBe(200);
  };
  const state=()=>silenceState(db,config.campaignId);
  const orders=async()=>(await db.prepare("SELECT * FROM campaign_silent_watermarks ORDER BY actor_id").all()).results;
  try {
    await command(true,date+2,20);
    const before=await state();
    const orderBefore=await orders();
    await command(false,date+1,999);
    expect(await state()).toEqual(before);
    expect(await orders()).toEqual(orderBefore);
    await command(true,date+4,21);
    expect(await state()).toEqual(before);
    await command(false,date+3,1000);
    expect(await state()).toEqual(before);
    await command(false,date+4,22);
    expect((await state()).silent).toBe(0);
    await enqueueNotice(db,config,"fresh-after-off",-1001,"must remain unheld",Date.now()+10000);
    const off=await state();
    const offOrder=await orders();
    await command(true,date+2,20); // Same source, different update receipt.
    expect(await state()).toEqual(off);
    expect(await orders()).toEqual(offOrder);
    expect(await db.prepare("SELECT publication_hold FROM notices WHERE notice_key='fresh-after-off'").first("publication_hold")).toBe(0);

    for(const [n,order] of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]].entries()) {
      const at=date+10+n*10;
      const inputs=[{on:true,id:10,actor:42},{on:true,id:20,actor:43},{on:false,id:21,actor:43}];
      for(const i of order) {const c=inputs[i]!;await command(c.on,at,c.id,c.actor);}
      expect((await state()).silent).toBe(1);
      await command(false,at+1,1,43);
      expect((await state()).silent).toBe(0);
    }
    await command(true,date+80,30);
    await db.prepare("INSERT INTO recovery_state(campaign_id,restored_at,backup_at,reason) VALUES(?,?,?,'Synthetic restore')")
      .bind(config.campaignId,(date+90)*1000+500,now).run();
    const restored=await state();
    const restoredOrder=await orders();
    await command(false,date+89,999);
    await command(false,date+90,1000);
    expect(await state()).toEqual(restored);
    expect(await orders()).toEqual(restoredOrder);
    await command(false,date+91,31);
    expect((await state()).silent).toBe(0);
    expect(sent.filter(message=>message.chat_id<0).map(message=>message.text)).toEqual(["must remain unheld"]);
    const source=await db.prepare("SELECT source_chat_id,message_id,json_extract(detail,'$.sentAt') sent_at,json_extract(detail,'$.accepted') accepted FROM operational_events WHERE kind='SILENT_CHANGE' AND message_id=999 ORDER BY created_at LIMIT 1").first();
    expect(source).toEqual({source_chat_id:42,message_id:999,sent_at:(date+1)*1000,accepted:0});
  } finally {await runtime.dispose();}
},30_000);

test("real D1 source watermarks serialize concurrent commands and roll back with failed holds",async()=>{
  const {runtime,db}=await runtimeDb();
  const admins={...config,adminIds:[42,43]};
  const command=(on:boolean,actor:number,id:number,key:string,at=now)=>setOrderedSilence(db,admins,on,actor,key,now,
    {sentAt:at,chatId:actor,messageId:id});
  try {
    await Promise.all([command(true,42,10,"a-on"),command(true,43,20,"b-on"),command(false,43,21,"b-off"),command(true,42,10,"a-on")]);
    expect((await silenceState(db,config.campaignId)).silent).toBe(1);
    expect((await db.prepare("SELECT actor_id,message_id,silent FROM campaign_silent_watermarks ORDER BY actor_id").all()).results)
      .toEqual([{actor_id:42,message_id:10,silent:1},{actor_id:43,message_id:21,silent:0}]);
    expect(await db.prepare("SELECT COUNT(*) n FROM operational_events WHERE kind='SILENT_CHANGE'").first("n")).toBe(3);
    await runReports(db,config,"unused-local-token",now,async()=>{throw new Error("silent must not send");});
    await command(false,42,11,"off-later",now+1000);
    await enqueueNotice(db,config,"fresh",-1001,"fresh",now+10000);
    const before=await silenceState(db,config.campaignId);
    const orders=(await db.prepare("SELECT * FROM campaign_silent_watermarks ORDER BY actor_id").all()).results;
    await db.prepare("CREATE TRIGGER fail_hold BEFORE UPDATE OF publication_hold ON daily_reports BEGIN SELECT RAISE(ABORT,'injected hold failure'); END").run();
    await expect(command(true,42,12,"failed",now+2000)).rejects.toThrow("injected hold failure");
    expect(await silenceState(db,config.campaignId)).toEqual(before);
    expect((await db.prepare("SELECT * FROM campaign_silent_watermarks ORDER BY actor_id").all()).results).toEqual(orders);
    expect(await db.prepare("SELECT 1 FROM operational_events WHERE event_key='failed'").first()).toBeNull();
    expect(await db.prepare("SELECT publication_hold FROM notices WHERE notice_key='fresh'").first("publication_hold")).toBe(0);
    await db.prepare("DROP TRIGGER fail_hold").run();
    await command(true,42,12,"failed",now+2000);
    expect((await silenceState(db,config.campaignId)).silent).toBe(1);
    expect(await db.prepare("SELECT publication_hold FROM notices WHERE notice_key='fresh'").first("publication_hold")).toBe(1);
  } finally {await runtime.dispose();}
},30_000);

test("real D1 additive silent-order migration preserves legacy policy and rejects old OFF",async()=>{
  const {runtime,db}=await runtimeDb(false,"42","0007_campaign_controls.sql");
  try {
    await db.prepare("INSERT INTO campaign_controls VALUES(?,1,?,42,'2026-11-09',?)").bind(config.campaignId,now,now-1000).run();
    await db.prepare("INSERT INTO operational_events(event_key,campaign_id,kind,detail,created_at) VALUES('legacy',?,'SILENT_CHANGE','{}',?)")
      .bind(config.campaignId,now+2500).run();
    const before=await silenceState(db,config.campaignId);
    await applyMigration(db,"0008_silent_command_order.sql");
    expect(await silenceState(db,config.campaignId)).toEqual(before);
    await setOrderedSilence(db,config,false,42,"old-off",now+3000,{sentAt:now+1000,chatId:42,messageId:999});
    await setOrderedSilence(db,config,false,42,"same-second-off",now+4000,{sentAt:now+2000,chatId:42,messageId:1000});
    expect(await silenceState(db,config.campaignId)).toEqual(before);
    await setOrderedSilence(db,config,false,42,"fresh-off",now+5000,{sentAt:now+3000,chatId:42,messageId:1});
    expect((await silenceState(db,config.campaignId)).silent).toBe(0);
  } finally {await runtime.dispose();}
},30_000);

test("real D1 concurrent silence commands, held release, uncertain resolution and replay remain atomic",async()=>{
  const {runtime,db}=await runtimeDb();
  try {
    await Promise.all([setSilence(db,config,true,42,"on",now),setSilence(db,config,true,42,"on",now)]);
    expect(await db.prepare("SELECT COUNT(*) n FROM operational_events WHERE event_key='on'").first("n")).toBe(1);
    await runReports(db,config,"test",now,async()=>{throw new Error("silent must not send");});
    await setSilence(db,config,false,42,"off",now+1);
    const resolution={day:"2026-11-10",action:"retry" as const,adminId:42,reason:"Checked absent",idempotencyKey:"release"};
    const releases=await Promise.all([resolveReport(db,config,resolution,now+2),resolveReport(db,config,resolution,now+2)]);
    expect(releases.filter(Boolean)).toHaveLength(1);
    await runReports(db,config,"test",now+3,async()=>({state:"UNCERTAIN",error:"lost response"}));
    expect(await resolveReport(db,config,resolution,now+4)).toBe(false);
    expect(await resolveReport(db,config,{...resolution,idempotencyKey:"verified-retry"},now+5)).toBe(true);
    expect(await db.prepare("SELECT status,publication_hold FROM daily_reports").first()).toEqual({status:"PENDING",publication_hold:0});
    await setSilence(db,config,true,42,"on-again",now+6);
    expect(await resolveReport(db,config,{...resolution,idempotencyKey:"verified-retry"},now+7)).toBe(false);
    expect(await db.prepare("SELECT publication_hold FROM daily_reports").first("publication_hold")).toBe(1);
  } finally {await runtime.dispose();}
},30_000);

test("compiled Worker real D1 excludes old edits and keeps counting during persisted silence across restart",async()=>{
  const {runtime,db,sent}=await runtimeDb(true);
  try {
    await db.prepare("INSERT INTO automatic_intake_boundaries VALUES('test',-1001,41,NULL,'Verified test boundary',42,?) ON CONFLICT(campaign_id,chat_id) DO UPDATE SET first_message_id=41").bind(now).run();
    const submit=(value:unknown)=>runtime.dispatchFetch("https://local.test/webhook",{method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":"runtime-secret-1234567890"},body:JSON.stringify(value)});
    const date=Date.parse("2026-11-10T10:00:00Z")/1000;
    const source={date,chat:{id:-1001,type:"supergroup"},from:{id:7,is_bot:false}};
    for(const [id,amount] of [[32,500],[38,2700]]) expect((await submit({update_id:id,edited_message:{...source,message_id:id,text:String(amount),edit_date:date+1000}})).status).toBe(200);
    expect((await totals(db,config.campaignId)).total).toBe("0");
    await setSilence(db,config,true,42,"on",now);
    expect((await submit({update_id:51,message:{...source,message_id:51,text:"Сегодня 1000🙏"}})).status).toBe(200);
    expect((await submit({update_id:52,edited_message:{...source,message_id:51,text:"2000",edit_date:date+1}})).status).toBe(200);
    expect((await totals(db,config.campaignId)).total).toBe("2000");
    // A newly initialized runtime path reads D1 state, never an isolate-local flag.
    await initialize(db,config);await runReports(db,config,"test",now);
    expect(sent.filter(r=>r.chat_id<0)).toHaveLength(0);
    const status=await runtime.dispatchFetch("https://local.test/health",{headers:{"X-Telegram-Bot-Api-Secret-Token":"runtime-secret-1234567890"}});
    expect(status.status).toBe(200);
  } finally {await runtime.dispose();}
},30_000);

// --- A06 F1/F3 regressions: deterministic barriers, compiled Worker, real webhook migration ---

const webhookHeaders = { "X-Telegram-Bot-Api-Secret-Token": "runtime-secret-1234567890" };
async function post(runtime: Miniflare, value: unknown) {
  return runtime.dispatchFetch("https://local.test/webhook", { method: "POST", headers: webhookHeaders, body: JSON.stringify(value) });
}
async function cron(runtime: Miniflare) {
  const worker = await runtime.getWorker();
  expect((await worker.scheduled()).outcome).toBe("ok");
}
function adminMessage(id: number, at: number, text: string) {
  return { message_id: id, date: at, chat: { id: 42, type: "private" as const }, from: { id: 42, is_bot: false }, text };
}
const groupSends = (sent: { chat_id: number }[]) => sent.filter(message => message.chat_id < 0);
async function enrollBoundary(db: D1Database, chatId: number, at: number) {
  await db.prepare(`INSERT INTO automatic_intake_boundaries(campaign_id,chat_id,first_message_id,reason,approved_by,created_at)
    VALUES(?,?,1,'Synthetic verified boundary',42,?) ON CONFLICT(campaign_id,chat_id) DO NOTHING`)
    .bind(config.campaignId, chatId, at).run();
}
/** A ready PENDING report with no hold, produced through the real outbox and audited retry. */
async function readyPendingReport(db: D1Database, at: number) {
  await runReports(db, config, "test", at, async () => ({ state: "FAILED_KNOWN", error: "403 synthetic" }));
  expect(await resolveReport(db, config, { day: "2026-11-10", action: "retry", adminId: 42,
    reason: "Synthetic ready report", idempotencyKey: `ready-${at}` }, at + 1)).toBe(true);
  expect(await db.prepare("SELECT status,publication_hold FROM daily_reports WHERE day='2026-11-10'").first())
    .toEqual({ status: "PENDING", publication_hold: 0 });
}
const migrationUpdate = (updateId: number, at: number, oldId = -1001, newId = -2001) => ({
  update_id: updateId, message: { message_id: 90, date: at, chat: { id: oldId, type: "group" },
    from: { id: 7, is_bot: false }, migrate_to_chat_id: newId },
});

/** Pause before/after a whole D1 batch containing the pattern; SQL tracked through bind(). */
function withBatchGate(db: D1Database, pattern: string, afterCommit: boolean, action: () => Promise<unknown>): D1Database {
  const sqls = new WeakMap<object, string>();
  let intercepted = false;
  const track = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, prop) {
      if (prop === "bind") return (...values: unknown[]) => track(target.bind(...values as never[]), sql);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    sqls.set(proxy, sql);
    return proxy;
  };
  return new Proxy(db, { get(target, prop) {
    if (prop === "prepare") return (sql: string) => track(target.prepare(sql), sql);
    if (prop === "batch") return async (statements: D1PreparedStatement[]) => {
      const hit = !intercepted && statements.some(statement => sqls.get(statement)?.includes(pattern));
      if (!hit) return target.batch(statements);
      intercepted = true;
      if (!afterCommit) await action();
      const result = await target.batch(statements);
      if (afterCommit) await action();
      return result;
    };
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("F1-R1 compiled Worker: denied report_retry during ON stays denied after OFF and exact envelope replay", async () => {
  const { runtime, db, sent } = await runtimeDb(true);
  const date = now / 1000;
  try {
    expect((await post(runtime, { update_id: 500, message: adminMessage(10, date, "/silent on") })).status).toBe(200);
    await cron(runtime);
    expect(await db.prepare("SELECT status,publication_hold FROM daily_reports WHERE day='2026-11-10'").first())
      .toEqual({ status: "PENDING", publication_hold: 1 });
    await db.prepare("CREATE TRIGGER fail_heartbeat BEFORE INSERT ON system_heartbeat BEGIN SELECT RAISE(ABORT,'injected heartbeat failure'); END").run();
    const retryEnvelope = { update_id: 600, message: adminMessage(11, date + 1, "/report_retry 2026-11-10 Checked absent") };
    const retryKey = await eventKey(parseTelegramUpdate(retryEnvelope));
    expect((await post(runtime, retryEnvelope)).status).toBe(503);
    expect(await db.prepare("SELECT publication_hold FROM daily_reports WHERE day='2026-11-10'").first("publication_hold")).toBe(1);
    const refusal = await db.prepare("SELECT body FROM notices WHERE notice_key=?").bind(`admin:${retryKey}`).first("body");
    expect(String(refusal)).toContain("Нет изменения");
    expect(groupSends(sent)).toHaveLength(0);
    await db.prepare("DROP TRIGGER fail_heartbeat").run();
    expect((await post(runtime, { update_id: 501, message: adminMessage(12, date + 2, "/silent off") })).status).toBe(200);
    await cron(runtime);
    expect((await post(runtime, retryEnvelope)).status).toBe(200); // exact same envelope, same idempotency key
    await cron(runtime);
    expect(await db.prepare("SELECT status,publication_hold FROM daily_reports WHERE day='2026-11-10'").first())
      .toEqual({ status: "PENDING", publication_hold: 1 });
    expect(groupSends(sent)).toHaveLength(0);
    expect(await db.prepare("SELECT body FROM notices WHERE notice_key=?").bind(`admin:${retryKey}`).first("body")).toBe(refusal);
    expect(await db.prepare("SELECT COUNT(*) n FROM operational_events WHERE event_key=? AND kind='REPORT_RESOLUTION_DENIED'").bind(retryKey).first("n")).toBe(1);
    expect((await post(runtime, { update_id: 502, message: adminMessage(13, date + 3, "/report_retry 2026-11-10 Fresh verified release") })).status).toBe(200);
    await cron(runtime);
    expect(await db.prepare("SELECT status,publication_hold FROM daily_reports WHERE day='2026-11-10'").first())
      .toEqual({ status: "SENT", publication_hold: 0 });
    expect(groupSends(sent)).toHaveLength(1);
  } finally { await runtime.dispose(); }
}, 30_000);

test("F1-R2 real D1: denied UNCERTAIN retry during ON keeps UNCERTAIN after OFF and replay; fresh retry sends once", async () => {
  const { runtime, db } = await runtimeDb();
  let sends = 0;
  const send = async () => { sends++; return { state: "SENT" as const, messageId: 700 }; };
  try {
    await runReports(db, config, "test", now, async () => ({ state: "UNCERTAIN", error: "lost response" }));
    await setSilence(db, config, true, 42, "on", now + 1);
    const envelope = { service: false, ...adminMessage(20, (now + 2) / 1000, "/report_retry 2026-11-10 Checked absent") };
    expect(await handleAdmin(db, config, envelope, "uncertain-denied", now + 2)).toBe(true);
    expect(await db.prepare("SELECT status FROM daily_reports WHERE day='2026-11-10'").first("status")).toBe("UNCERTAIN");
    await setSilence(db, config, false, 42, "off", now + 3);
    expect(await handleAdmin(db, config, envelope, "uncertain-denied", now + 4)).toBe(true);
    expect(await db.prepare("SELECT status FROM daily_reports WHERE day='2026-11-10'").first("status")).toBe("UNCERTAIN");
    expect(sends).toBe(0);
    expect(await resolveReport(db, config, { day: "2026-11-10", action: "retry", adminId: 42,
      reason: "Fresh verified absent", idempotencyKey: "uncertain-fresh" }, now + 5)).toBe(true);
    await runReports(db, config, "test", now + 6, send);
    expect(sends).toBe(1);
    expect(await db.prepare("SELECT status FROM daily_reports WHERE day='2026-11-10'").first("status")).toBe("SENT");
  } finally { await runtime.dispose(); }
}, 30_000);

test("F1-R3 real D1: commit order decides the key; SQL faults roll back the whole decision batch", async () => {
  const { runtime, db } = await runtimeDb();
  const date = now / 1000;
  try {
    // OFF commits before the command batch: the initially admissible command applies once.
    await setSilence(db, config, true, 42, "on", now);
    await runReports(db, config, "test", now, async () => { throw new Error("silent must not send"); });
    const resolution = { day: "2026-11-10", action: "retry" as const, adminId: 42, reason: "Checked absent", idempotencyKey: "order-off-first" };
    const offFirst = withBatchGate(db, "HELD_REPORT_RELEASE", false,
      () => setSilence(db, config, false, 42, "off-first", now + 1));
    expect(await resolveReport(offFirst, config, resolution, now + 2)).toBe(true);
    expect(await resolveReport(db, config, resolution, now + 3)).toBe(false);
    expect(await db.prepare("SELECT publication_hold FROM daily_reports WHERE day='2026-11-10'").first("publication_hold")).toBe(0);
    // ON commits before the command batch: the denial is durable across later OFF and replay.
    await db.prepare("UPDATE daily_reports SET publication_hold=1 WHERE day='2026-11-10'").run();
    const denied = { ...resolution, idempotencyKey: "order-on-first" };
    const onFirst = withBatchGate(db, "HELD_REPORT_RELEASE", false,
      () => setSilence(db, config, true, 42, "on-first", now + 4));
    expect(await resolveReport(onFirst, config, denied, now + 5)).toBe(false);
    await setSilence(db, config, false, 42, "off-later", now + 6);
    expect(await resolveReport(db, config, denied, now + 7)).toBe(false);
    expect(await db.prepare("SELECT publication_hold FROM daily_reports WHERE day='2026-11-10'").first("publication_hold")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) n FROM operational_events WHERE event_key='order-on-first' AND kind='REPORT_RESOLUTION_DENIED'").first("n")).toBe(1);
    // Two concurrent duplicates of one denied key record one denial and no effect.
    const dup = { ...resolution, idempotencyKey: "dup-denied" };
    await setSilence(db, config, true, 42, "on-dup", now + 8);
    const both = await Promise.all([resolveReport(db, config, dup, now + 9), resolveReport(db, config, dup, now + 9)]);
    expect(both).toEqual([false, false]);
    await setSilence(db, config, false, 42, "off-dup", now + 10);
    expect(await resolveReport(db, config, dup, now + 11)).toBe(false);
    expect(await db.prepare("SELECT publication_hold FROM daily_reports WHERE day='2026-11-10'").first("publication_hold")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) n FROM operational_events WHERE event_key='dup-denied'").first("n")).toBe(1);
    // SQL failure between held receipt and its UPDATE rolls back the entire batch.
    await db.prepare("CREATE TRIGGER fail_release BEFORE UPDATE OF publication_hold ON daily_reports WHEN NEW.publication_hold=0 BEGIN SELECT RAISE(ABORT,'injected release failure'); END").run();
    const rolled = { ...resolution, idempotencyKey: "rolled-release" };
    await expect(resolveReport(db, config, rolled, now + 12)).rejects.toThrow("injected release failure");
    expect(await db.prepare("SELECT 1 FROM operational_events WHERE event_key='rolled-release'").first()).toBeNull();
    expect(await db.prepare("SELECT publication_hold FROM daily_reports WHERE day='2026-11-10'").first("publication_hold")).toBe(1);
    await db.prepare("DROP TRIGGER fail_release").run();
    expect(await resolveReport(db, config, rolled, now + 13)).toBe(true); // full rollback permits first processing
    // SQL failure inside the terminal resolution trigger rolls back receipt and state together.
    await runReports(db, config, "test", now + 14, async () => ({ state: "UNCERTAIN", error: "lost response" }));
    await db.prepare("CREATE TRIGGER fail_resolution BEFORE UPDATE OF status ON daily_reports WHEN OLD.status='UNCERTAIN' AND NEW.status='PENDING' BEGIN SELECT RAISE(ABORT,'injected resolution failure'); END").run();
    const terminal = { ...resolution, idempotencyKey: "rolled-terminal" };
    await expect(resolveReport(db, config, terminal, now + 15)).rejects.toThrow("injected resolution failure");
    expect(await db.prepare("SELECT 1 FROM report_resolutions WHERE idempotency_key='rolled-terminal'").first()).toBeNull();
    expect(await db.prepare("SELECT status FROM daily_reports WHERE day='2026-11-10'").first("status")).toBe("UNCERTAIN");
    await db.prepare("DROP TRIGGER fail_resolution").run();
    expect(await resolveReport(db, config, terminal, now + 16)).toBe(true);
  } finally { await runtime.dispose(); }
}, 30_000);

test("F1-R3 compiled Worker: failure after commit before ACK replays the saved answer with one effect", async () => {
  const { runtime, db, sent } = await runtimeDb(true);
  const date = now / 1000;
  try {
    expect((await post(runtime, { update_id: 510, message: adminMessage(30, date, "/silent on") })).status).toBe(200);
    await cron(runtime);
    expect((await post(runtime, { update_id: 511, message: adminMessage(31, date + 1, "/silent off") })).status).toBe(200);
    await db.prepare("CREATE TRIGGER fail_heartbeat BEFORE INSERT ON system_heartbeat BEGIN SELECT RAISE(ABORT,'injected heartbeat failure'); END").run();
    const envelope = { update_id: 512, message: adminMessage(32, date + 2, "/report_retry 2026-11-10 Verified absent") };
    const key = await eventKey(parseTelegramUpdate(envelope));
    expect((await post(runtime, envelope)).status).toBe(503);
    expect(await db.prepare("SELECT publication_hold FROM daily_reports WHERE day='2026-11-10'").first("publication_hold")).toBe(0);
    const answer = await db.prepare("SELECT body FROM notices WHERE notice_key=?").bind(`admin:${key}`).first("body");
    expect(String(answer)).toContain("разрешена одна отправка");
    await db.prepare("DROP TRIGGER fail_heartbeat").run();
    expect((await post(runtime, envelope)).status).toBe(200);
    expect(await db.prepare("SELECT body FROM notices WHERE notice_key=?").bind(`admin:${key}`).first("body")).toBe(answer);
    await cron(runtime);
    expect(groupSends(sent)).toHaveLength(1);
    await cron(runtime);
    expect(groupSends(sent)).toHaveLength(1);
  } finally { await runtime.dispose(); }
}, 30_000);

test("F3-R1 real D1 + real webhook migration between preflight and snapshot: zero snapshots until enrollment and replay", async () => {
  const { runtime, db, sent } = await runtimeDb(true);
  let sends = 0;
  try {
    const controlled = withGate(db, "boundary_missing", true, async () => {
      expect((await post(runtime, migrationUpdate(900, now / 1000))).status).toBe(200);
      const contribution = { update_id: 901, message: { message_id: 51, date: now / 1000 - 3600,
        chat: { id: -2001, type: "supergroup" }, from: { id: 7, is_bot: false }, text: "108" } };
      expect((await post(runtime, contribution)).status).toBe(503); // unenrolled alias refuses intake
    });
    const result = await runReports(controlled, config, "test", now, async () => { sends++; return { state: "SENT" as const, messageId: 1 }; });
    expect(result.created).toBe(0);
    expect(sends).toBe(0);
    expect(groupSends(sent)).toHaveLength(0);
    expect(await db.prepare("SELECT COUNT(*) n FROM daily_reports").first("n")).toBe(0);
    await enrollBoundary(db, -2001, now);
    expect((await post(runtime, { update_id: 901, message: { message_id: 51, date: now / 1000 - 3600,
      chat: { id: -2001, type: "supergroup" }, from: { id: 7, is_bot: false }, text: "108" } })).status).toBe(200);
    expect((await totals(db, config.campaignId)).total).toBe("108");
    // The report calendar uses the explicit nowMs seam; workerd Cron reads the wall clock.
    await runReports(db, config, "test", now, async () => { sends++; return { state: "SENT" as const, messageId: 1 }; });
    expect((await db.prepare("SELECT day,CAST(total AS TEXT) total,target_chat_id,status FROM daily_reports").all()).results)
      .toEqual([{ day: "2026-11-10", total: "108", target_chat_id: -2001, status: "SENT" }]);
    expect(sends).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) n FROM daily_reports").first("n")).toBe(1);
  } finally { await runtime.dispose(); }
}, 30_000);

test("F3-R2 real D1: boundary appearing before claim blocks claim and send; enrollment restores availability", async () => {
  const { runtime, db } = await runtimeDb(true);
  let sends = 0;
  const send = async () => { sends++; return { state: "SENT" as const, messageId: 1 }; };
  try {
    await readyPendingReport(db, now);
    const controlled = withGate(db, "boundary_missing", true, async () => {
      await db.prepare("INSERT INTO chat_aliases(chat_id,campaign_id) VALUES(-2001,?)").bind(config.campaignId).run();
    });
    const result = await runReports(controlled, config, "test", now + 1000, send);
    expect(sends).toBe(0);
    expect(result.sent).toBe(0);
    expect(await db.prepare("SELECT status,attempt_count,publication_hold FROM daily_reports WHERE day='2026-11-10'").first())
      .toEqual({ status: "PENDING", attempt_count: 1, publication_hold: 0 });
    await enrollBoundary(db, -2001, now + 2000);
    await runReports(db, config, "test", now + 3000, send);
    expect(sends).toBe(1);
    expect(await db.prepare("SELECT status FROM daily_reports WHERE day='2026-11-10'").first("status")).toBe("SENT");
    // Silence still governs the restored route: a held report is not auto-published.
    await db.prepare("UPDATE daily_reports SET status='PENDING',publication_hold=1 WHERE day='2026-11-10'").run();
    await setSilence(db, config, true, 42, "on-after", now + 4000);
    await runReports(db, config, "test", now + 5000, send);
    expect(sends).toBe(1);
  } finally { await runtime.dispose(); }
}, 30_000);

for (const variant of ["missing-boundary", "registered-alias-route", "concurrent-on"] as const) {
  test(`F3-R3 real D1 + webhook migration after claim (${variant}): no API call, own claim released correctly`, async () => {
    const { runtime, db, sent } = await runtimeDb(true);
    let sends = 0;
    const send = async () => { sends++; return { state: "SENT" as const, messageId: 1 }; };
    try {
      if (variant === "registered-alias-route") {
        await db.prepare("INSERT INTO chat_aliases(chat_id,campaign_id) VALUES(-2001,?)").bind(config.campaignId).run();
        await enrollBoundary(db, -2001, now - 1000);
      }
      await readyPendingReport(db, now);
      const controlled = withGate(db, "UPDATE daily_reports SET status = 'SENDING'", true, async () => {
        if (variant === "concurrent-on") await setSilence(db, config, true, 42, "on-race", now + 1000);
        else expect((await post(runtime, migrationUpdate(910, now / 1000 + 1))).status).toBe(200);
      });
      await runReports(controlled, config, "test", now + 2000, send);
      expect(sends).toBe(0);
      expect(groupSends(sent)).toHaveLength(0);
      const row = await db.prepare("SELECT status,attempt_token,lease_until,publication_hold,target_chat_id FROM daily_reports WHERE day='2026-11-10'").first();
      if (variant === "concurrent-on") {
        expect(row).toMatchObject({ status: "PENDING", publication_hold: 1, attempt_token: null, lease_until: null });
      } else {
        expect(row).toMatchObject({ status: "PENDING", publication_hold: 0, attempt_token: null, lease_until: null });
        expect(await db.prepare("SELECT COUNT(*) n FROM report_audit WHERE to_state='UNCERTAIN'").first("n")).toBe(0);
        await enrollBoundary(db, -2001, now + 3000);
        await runReports(db, config, "test", now + 4000, send);
        expect(sends).toBe(1);
        expect(await db.prepare("SELECT status,target_chat_id FROM daily_reports WHERE day='2026-11-10'").first())
          .toEqual({ status: "SENT", target_chat_id: -2001 });
      }
    } finally { await runtime.dispose(); }
  }, 30_000);
}

test("F3-LIMIT demonstration: migration after the final SQL read may complete one already authorized call", async () => {
  const { runtime, db } = await runtimeDb(true);
  const calls: { chat: number; body: string }[] = [];
  try {
    await readyPendingReport(db, now);
    const controlled = withGate(db, "SELECT 1 FROM daily_reports WHERE", true, async () => {
      expect((await post(runtime, migrationUpdate(920, now / 1000 + 1))).status).toBe(200);
    });
    await runReports(controlled, config, "test", now + 2000, async (_token, chat, body) => {
      calls.push({ chat: Number(chat), body }); return { state: "SENT" as const, messageId: 9 };
    });
    // The residual TOCTOU window: one authorized call to the captured address is permitted.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.chat).toBe(-1001);
    expect(await db.prepare("SELECT status,target_chat_id,telegram_message_id FROM daily_reports WHERE day='2026-11-10'").first())
      .toEqual({ status: "SENT", target_chat_id: -1001, telegram_message_id: 9 });
  } finally { await runtime.dispose(); }
}, 30_000);

test("F3 late contribution: immutable day snapshot keeps its total; accepted late intake appears once as a later correction", async () => {
  const { runtime, db, sent } = await runtimeDb(true);
  const date = now / 1000;
  try {
    expect((await post(runtime, { update_id: 930, message: { message_id: 60, date: date - 3600,
      chat: { id: -1001, type: "supergroup" }, from: { id: 7, is_bot: false }, text: "100" } })).status).toBe(200);
    let sends = 0;
    const controlled = withGate(db, "UPDATE daily_reports SET status = 'SENDING'", true, async () => {
      expect((await post(runtime, migrationUpdate(931, date))).status).toBe(200);
      expect((await post(runtime, { update_id: 932, message: { message_id: 61, date: date - 1800,
        chat: { id: -2001, type: "supergroup" }, from: { id: 7, is_bot: false }, text: "108" } })).status).toBe(503);
    });
    await runReports(controlled, config, "test", now, async () => { sends++; return { state: "SENT" as const, messageId: 1 }; });
    expect(sends).toBe(0);
    const frozen = await db.prepare("SELECT CAST(day_total AS TEXT) day_total,CAST(total AS TEXT) total,CAST(correction AS TEXT) correction,body,status FROM daily_reports WHERE day='2026-11-10'").first();
    expect(frozen).toMatchObject({ day_total: "100", total: "100", correction: "0", status: "PENDING" });
    await enrollBoundary(db, -2001, now + 1000);
    expect((await post(runtime, { update_id: 932, message: { message_id: 61, date: date - 1800,
      chat: { id: -2001, type: "supergroup" }, from: { id: 7, is_bot: false }, text: "108" } })).status).toBe(200);
    expect((await totals(db, config.campaignId)).total).toBe("208");
    await runReports(db, config, "test", now, async () => { sends++; return { state: "SENT" as const, messageId: 1 }; });
    expect(sends).toBe(1); // frozen day snapshot published to the current route
    expect(await db.prepare("SELECT CAST(day_total AS TEXT) day_total,CAST(total AS TEXT) total,CAST(correction AS TEXT) correction,body,status FROM daily_reports WHERE day='2026-11-10'").first())
      .toEqual({ ...frozen, status: "SENT" });
    expect(await db.prepare("SELECT target_chat_id FROM daily_reports WHERE day='2026-11-10'").first("target_chat_id")).toBe(-2001);
    await runReports(db, config, "test", now + 1000, async () => { sends++; return { state: "SENT" as const, messageId: 1 }; });
    expect(sends).toBe(1); // no second publication of the same day
    // The late contribution is visible exactly once, as a correction in the next day's report.
    const next = await runReports(db, config, "test", now + 86400_000, async () => ({ state: "SENT" as const, messageId: 2 }));
    expect(next.created).toBeGreaterThan(0); // meta.changes includes the audit trigger; count rows below
    expect(await db.prepare("SELECT COUNT(*) n FROM daily_reports WHERE day='2026-11-11'").first("n")).toBe(1);
    expect(await db.prepare("SELECT CAST(day_total AS TEXT) day_total,CAST(total AS TEXT) total,CAST(correction AS TEXT) correction,body FROM daily_reports WHERE day='2026-11-11'").first())
      .toMatchObject({ day_total: "0", total: "208", correction: "108" });
    expect(String(await db.prepare("SELECT body FROM daily_reports WHERE day='2026-11-11'").first("body"))).toContain("Поправки к ранее учтённым дням: +108");
    await runReports(db, config, "test", now + 2 * 86400_000, async () => ({ state: "SENT" as const, messageId: 3 }));
    expect(await db.prepare("SELECT CAST(total AS TEXT) total,CAST(correction AS TEXT) correction FROM daily_reports WHERE day='2026-11-12'").first())
      .toEqual({ total: "208", correction: "0" }); // no double counting
    // The real compiled Cron continues: the OFF watermark holds wall-clock catch-up days.
    await setSilence(db, config, true, 42, "late-on", Date.now());
    await setSilence(db, config, false, 42, "late-off", Date.now() + 1);
    await cron(runtime);
    expect(groupSends(sent)).toHaveLength(0);
    expect(await db.prepare("SELECT COUNT(*) n FROM daily_reports WHERE publication_hold=1").first("n")).toBeGreaterThan(0);
  } finally { await runtime.dispose(); }
}, 30_000);

test("F1-R4 real D1: legacy receipts and legacy refusal answers are honored; confirm_sent works during ON; recovery rule", async () => {
  const { runtime, db } = await runtimeDb();
  try {
    // Legacy positive held receipt (old code): the replay reconstructs the answer without a new effect.
    await setSilence(db, config, true, 42, "on", now);
    await runReports(db, config, "test", now, async () => { throw new Error("silent must not send"); });
    await setSilence(db, config, false, 42, "off", now + 1);
    await db.prepare("UPDATE daily_reports SET publication_hold=0 WHERE day='2026-11-10'").run();
    await db.prepare("INSERT INTO operational_events(event_key,campaign_id,kind,actor_id,detail,created_at) VALUES('legacy-held',?,'HELD_REPORT_RELEASE',42,?,?)")
      .bind(config.campaignId, JSON.stringify({ day: "2026-11-10", reason: "Old release", nonce: "legacy-nonce" }), now + 2).run();
    expect(await handleAdmin(db, config, { service: false, ...adminMessage(40, (now + 3) / 1000, "/report_retry 2026-11-10 Old release") }, "legacy-held", now + 3)).toBe(true);
    expect(String(await db.prepare("SELECT body FROM notices WHERE notice_key='admin:legacy-held'").first("body"))).toContain("разрешена одна отправка");
    expect(await db.prepare("SELECT COUNT(*) n FROM operational_events WHERE event_key='legacy-held'").first("n")).toBe(1);
    expect(await db.prepare("SELECT publication_hold FROM daily_reports WHERE day='2026-11-10'").first("publication_hold")).toBe(0);
    // Legacy terminal receipt: a lost answer is restored from the saved resolution.
    await runReports(db, config, "test", now + 4, async () => ({ state: "UNCERTAIN", error: "lost response" }));
    expect(await resolveReport(db, config, { day: "2026-11-10", action: "confirm_sent", messageId: 800,
      adminId: 42, reason: "Verified", idempotencyKey: "legacy-terminal" }, now + 5)).toBe(true);
    expect(await handleAdmin(db, config, { service: false, ...adminMessage(41, (now + 6) / 1000, "/report_sent 2026-11-10 800 Verified") }, "legacy-terminal", now + 6)).toBe(true);
    expect(String(await db.prepare("SELECT body FROM notices WHERE notice_key='admin:legacy-terminal'").first("body"))).toContain("подтверждена публикация 800");
    expect(await resolveReport(db, config, { day: "2026-11-10", action: "confirm_sent", messageId: 800,
      adminId: 42, reason: "Verified", idempotencyKey: "legacy-terminal" }, now + 7)).toBe(false);
    // Legacy refusal saved only the admin answer: the replay neither releases nor rewrites it.
    await db.prepare("UPDATE daily_reports SET status='PENDING',publication_hold=1,telegram_message_id=NULL WHERE day='2026-11-10'").run();
    await db.prepare("INSERT INTO notices(notice_key,campaign_id,chat_id,body,created_at) VALUES('admin:legacy-refusal',?,42,'Старый отказ: нет изменения.',?)")
      .bind(config.campaignId, now + 8).run();
    expect(await handleAdmin(db, config, { service: false, ...adminMessage(42, (now + 9) / 1000, "/report_retry 2026-11-10 Checked absent") }, "legacy-refusal", now + 9)).toBe(true);
    expect(await db.prepare("SELECT publication_hold FROM daily_reports WHERE day='2026-11-10'").first("publication_hold")).toBe(1);
    expect(await db.prepare("SELECT body FROM notices WHERE notice_key='admin:legacy-refusal'").first("body")).toBe("Старый отказ: нет изменения.");
    expect(await db.prepare("SELECT COUNT(*) n FROM operational_events WHERE event_key='legacy-refusal'").first("n")).toBe(0);
    // A fresh confirm_sent with a valid Telegram ID still confirms a found publication during ON.
    await setSilence(db, config, true, 42, "on-again", now + 10);
    await db.prepare("UPDATE daily_reports SET status='UNCERTAIN',publication_hold=1 WHERE day='2026-11-10'").run();
    expect(await resolveReport(db, config, { day: "2026-11-10", action: "confirm_sent", messageId: 801,
      adminId: 42, reason: "Found during silence", idempotencyKey: "confirm-on" }, now + 11)).toBe(true);
    expect(await db.prepare("SELECT status,telegram_message_id FROM daily_reports WHERE day='2026-11-10'").first())
      .toEqual({ status: "SENT", telegram_message_id: 801 });
    // Recovery rule: undecided old commands are stale; a decided command keeps its saved outcome.
    await db.prepare("INSERT INTO recovery_state(campaign_id,restored_at,backup_at,reason) VALUES(?,?,?,'Synthetic restore')")
      .bind(config.campaignId, now + 20_000, now).run();
    expect(await handleAdmin(db, config, { service: false, ...adminMessage(43, (now + 12) / 1000, "/report_retry 2026-11-10 Old command") }, "stale-undecided", now + 21_000)).toBe(true);
    expect(String(await db.prepare("SELECT body FROM notices WHERE notice_key='admin:stale-undecided'").first("body"))).toContain("до восстановления");
    expect(await handleAdmin(db, config, { service: false, ...adminMessage(42, (now + 9) / 1000, "/report_retry 2026-11-10 Checked absent") }, "legacy-refusal", now + 22_000)).toBe(true);
    expect(await db.prepare("SELECT body FROM notices WHERE notice_key='admin:legacy-refusal'").first("body")).toBe("Старый отказ: нет изменения.");
    expect(await db.prepare("SELECT COUNT(*) n FROM operational_events WHERE event_key='legacy-refusal' AND kind='STALE_RECOVERY_COMMAND'").first("n")).toBe(0);
  } finally { await runtime.dispose(); }
}, 30_000);
