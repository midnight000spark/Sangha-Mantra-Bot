import { expect, test, spyOn } from "bun:test";
import { Glob } from "bun";
import { Miniflare, Response as RuntimeResponse } from "miniflare";
import { initializeTestDb as initialize } from "./db";
import { ingest, totals } from "../src/core";
import { deliverNotices, enqueueNotice } from "../src/admin";
import { silenceState, setSilence as setOrderedSilence } from "../src/controls";
import { setTestSilence as setSilence } from "./db";
import { runReports, resolveReport } from "../src/reports";
import { testConfig, seedIdentity } from "./db";

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
