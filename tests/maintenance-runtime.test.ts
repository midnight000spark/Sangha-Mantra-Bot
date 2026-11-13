import { expect, test, spyOn } from "bun:test";
import { Glob } from "bun";
import { Miniflare, Response as RuntimeResponse } from "miniflare";
import { initializeTestDb as initialize } from "./db";
import { ingest, totals } from "../src/core";
import { deliverNotices, enqueueNotice } from "../src/admin";
import { setSilence, silenceState } from "../src/controls";
import { runReports, resolveReport } from "../src/reports";
import { testConfig, seedIdentity } from "./db";

const config={...testConfig,startDay:"2026-11-10"};
const now=Date.parse("2026-11-10T21:05:00Z");
async function runtimeDb(compiled=false) {
  const sent:{chat_id:number;text:string}[]=[];
  const build=compiled ? await Bun.build({entrypoints:["src/worker.ts"],target:"browser",format:"esm"}) : null;
  if(build && !build.success) throw new Error("bundle failed");
  const runtime=new Miniflare({modules:true,script:build ? await build.outputs[0]!.text():"export default {fetch(){return new Response('ok')}}",
    d1Databases:{DB:"maintenance-runtime"},outboundService:async (_request:unknown) => {
      const request=_request as Request;
      sent.push(await request.json() as {chat_id:number;text:string});
      return new RuntimeResponse(JSON.stringify({ok:true,result:{message_id:sent.length+100}}),{headers:{"Content-Type":"application/json"}});
    },bindings:{DEPLOYMENT_ENV:"test",EXPECTED_D1_ID:"11111111-1111-1111-1111-111111111111",EXPECTED_BOT_ID:"123456",
      BOT_TOKEN:"123456:local-token",WEBHOOK_SECRET:"runtime-secret-1234567890",ADMIN_IDS:"42",CAMPAIGN_ID:config.campaignId,
      TIMEZONE:config.timezone,CAMPAIGN_START:config.startDay,REPORT_TIME:config.reportTime,GOAL:"1000000",MAX_AMOUNT:"1000000",ALLOWED_CHAT_IDS:"-1001,-1002",REPORT_CHAT_ID:"-1001"}});
  const db=await runtime.getD1Database("DB") as unknown as D1Database;
  for(const file of Array.from(new Glob("*.sql").scanSync("migrations")).sort()) {
    let sql="";
    for(const line of (await Bun.file(`migrations/${file}`).text()).split(/\r?\n/)) {
      sql+=line+"\n";
      // The first migration comment must not hide CREATE TRIGGER classification.
      const trigger=/^\s*CREATE TRIGGER/i.test(sql.trim());
      if((trigger && /^END;\s*$/.test(line)) || (!trigger && /;\s*$/.test(line))) {await db.prepare(sql.trim()).run();sql="";}
    }
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
