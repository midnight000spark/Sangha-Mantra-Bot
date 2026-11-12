import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare, Response as RuntimeResponse } from "miniflare";
import { Glob } from "bun";
import { initialize } from "../src/config";
import { ingest, totals } from "../src/core";
import { seedIdentity, testConfig as config } from "./db";
import type { ContributionEvent } from "../src/types";

let runtime: Miniflare;
let db: D1Database;
let transportMessageId = 50;
beforeAll(async () => {
  const build = await Bun.build({entrypoints:["src/worker.ts"],target:"browser",format:"esm"});
  if (!build.success) throw new Error(`Worker bundle failed: ${build.logs}`);
  runtime = new Miniflare({modules:true,script:await build.outputs[0]!.text(),d1Databases:{DB:"runtime-test"},
    outboundService: async () => new RuntimeResponse(JSON.stringify({ok:true,result:{message_id:++transportMessageId}}),{headers:{"Content-Type":"application/json"}}),
    bindings:{DEPLOYMENT_ENV:"test",EXPECTED_D1_ID:"11111111-1111-1111-1111-111111111111",EXPECTED_BOT_ID:"123456",BOT_TOKEN:"123456:local-token",WEBHOOK_SECRET:"runtime-secret-1234567890",ADMIN_IDS:"42",
      CAMPAIGN_ID:config.campaignId,TIMEZONE:config.timezone,CAMPAIGN_START:config.startDay,REPORT_TIME:config.reportTime,
      GOAL:String(config.goal),MAX_AMOUNT:String(config.maxAmount),ALLOWED_CHAT_IDS:"-1001,-1002",REPORT_CHAT_ID:"-1001"}});
  db = await runtime.getD1Database("DB") as unknown as D1Database;
  // D1 exec() splits on lines; migration files contain multiline triggers. The
  // sqlite-backed storage SQL API accepts each complete script through this route.
  const files = Array.from(new Glob("*.sql").scanSync("migrations")).sort();
  for (const file of files) {
    const sql = await Bun.file(`migrations/${file}`).text();
    const statements: string[] = [];
    let pending = "";
    for (const line of sql.split(/\r?\n/)) {
      pending += `${line}\n`;
      const trigger = /^\s*CREATE TRIGGER/i.test(pending.trim());
      if ((trigger && /^END;\s*$/.test(line)) || (!trigger && /;\s*$/.test(line))) {
        statements.push(pending.trim()); pending = "";
      }
    }
    for (const statement of statements) await db.prepare(statement).run();
  }
  await seedIdentity(db);
  await initialize(db,config);
}, 30_000);
afterAll(async () => { await runtime?.dispose(); });

test("real workerd D1 concurrent batches preserve source and immutable audit", async () => {
  const date = Date.parse("2026-11-10T10:00:00Z") / 1000;
  const base: ContributionEvent = {key:"original",updateId:1,chatId:-1001,messageId:1,userId:7,
    originalDate:date,versionDate:date,isEdit:false,amount:108,state:"VALID",reason:null,now:date*1000};
  await ingest(db,config,base);
  const changes = [5,2,8,1,10,3].map(n => ({...base,key:`edit-${n}`,updateId:n+1,isEdit:true,versionDate:date+n,amount:n*108}));
  await Promise.all([...changes,...changes,base].map(value => ingest(db,config,value)));
  expect((await totals(db,config.campaignId)).total).toBe("1080");
  expect((await db.prepare("SELECT COUNT(*) n FROM event_log").first<{n:number}>())!.n).toBe(7);
}, 20_000);

test("real D1 rejects an atomic batch without leaving a partial event", async () => {
  await db.prepare("CREATE TRIGGER runtime_failure BEFORE INSERT ON contributions WHEN NEW.message_id=900 BEGIN SELECT RAISE(ABORT,'injected'); END").run();
  const date = Date.parse("2026-11-10T10:00:00Z") / 1000;
  await expect(ingest(db,config,{key:"rollback",updateId:900,chatId:-1001,messageId:900,userId:7,
    originalDate:date,versionDate:date,isEdit:false,amount:108,state:"VALID",reason:null,now:date*1000})).rejects.toThrow();
  expect(await db.prepare("SELECT 1 FROM event_log WHERE event_key='rollback'").first()).toBeNull();
}, 20_000);

test("compiled Worker HTTP authenticates, commits before 200, and reports DB failure as 503", async () => {
  const update = {update_id:4000,message:{message_id:4000,date:Date.parse("2026-11-10T10:00:00Z")/1000,
    chat:{id:-1001,type:"supergroup"},from:{id:7,is_bot:false},text:"100"}};
  const submit = (body:unknown,secret="runtime-secret-1234567890") => runtime.dispatchFetch("https://worker.test/webhook",{
    method:"POST",headers:{"Content-Type":"application/json","X-Telegram-Bot-Api-Secret-Token":secret},body:JSON.stringify(body)});
  expect((await submit(update,"wrong")).status).toBe(401);
  expect((await submit(update)).status).toBe(200);
  expect((await totals(db,config.campaignId)).total).toBe("1180");
  expect((await submit(update)).status).toBe(200);
  expect((await totals(db,config.campaignId)).total).toBe("1180");
  expect((await submit({...update,update_id:4001,message:{...update.message,message_id:900}})).status).toBe(503);
  expect((await totals(db,config.campaignId)).total).toBe("1180");
  const health = await runtime.dispatchFetch("https://worker.test/health",{headers:{"X-Telegram-Bot-Api-Secret-Token":"runtime-secret-1234567890"}});
  expect(health.status).toBe(200);
  const data = await health.json() as {total:{total:string}};
  expect(data.total.total).toBe("1180");
},20_000);

test("compiled Worker/D1 handles free text, media, zero edits, late originals and concurrent versions", async () => {
  const date = Date.parse("2026-11-10T10:00:00Z")/1000;
  const submit = (body:unknown) => runtime.dispatchFetch("https://worker.test/webhook",{
    method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":"runtime-secret-1234567890"},body:JSON.stringify(body)});
  const source = {message_id:6000,date,chat:{id:-1001,type:"supergroup"},from:{id:7,is_bot:false}};
  const original = {update_id:6000,message:{...source,text:"1000🙏"}};
  const edit = (text:string,n:number) => ({update_id:6000+n,edited_message:{...source,text,edit_date:date+n}});
  const before = BigInt((await totals(db,config.campaignId)).total);
  await submit({update_id:6100,message:{...source,message_id:6100,text:"Привет"}});
  await submit({update_id:6101,message:{...source,message_id:6101,photo:[{file_id:"local"}],caption:"1000"}});
  expect(await db.prepare("SELECT COUNT(*) n FROM contributions WHERE message_id IN (6100,6101)").first("n")).toBe(0);
  expect((await submit(edit("Привет",10))).status).toBe(200);
  await submit(original); await submit(original);
  expect((await totals(db,config.campaignId)).total).toBe(String(before));
  await submit(edit("Сегодня 2000🙏",11));
  expect((await totals(db,config.campaignId)).total).toBe(String(before+2000n));
  await Promise.all([submit(edit("1000",12)),submit(edit("1000 и 2000",14)),submit(edit("108",13))]);
  expect((await totals(db,config.campaignId)).total).toBe(String(before));
  expect(await db.prepare("SELECT version_date,source_state,source_amount FROM contributions WHERE message_id=6000").first())
    .toEqual({version_date:date+14,source_state:"INVALID",source_amount:0});
  // A retry after commit must not replay an old APPLIED decision.
  await submit(original); await submit(edit("Сегодня 2000🙏",11));
  expect((await totals(db,config.campaignId)).total).toBe(String(before));
},20_000);


test("compiled Worker/D1 admin dialog commits one correction under concurrent callback/reason retries", async () => {
  const date = Math.floor(Date.now()/1000);
  let id = 8000;
  const submit = async (body:unknown) => {
    const response = await runtime.dispatchFetch("https://worker.test/webhook",{
      method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":"runtime-secret-1234567890"},body:JSON.stringify(body)});
    expect(response.status).toBe(200);
  };
  const message = (text:string,reply?:number) => ({update_id:++id,message:{message_id:id,date,
    chat:{id:42,type:"private"},from:{id:42,is_bot:false},text,
    ...(reply ? {reply_to_message:{message_id:reply}}:{})}});
  await submit(message("https://t.me/c/1/4000"));
  const session = (await db.prepare("SELECT id FROM admin_sessions ORDER BY created_at DESC LIMIT 1").first<{id:string}>())!;
  const callback = {update_id:++id,callback_query:{id:"runtime-edit",from:{id:42,is_bot:false},data:`au:e:${session.id}`,
    message:{message_id:80,date,chat:{id:42,type:"private"}}}};
  await Promise.all([submit(callback),submit({...callback,update_id:++id})]);
  async function prompt() {
    for(let n=0;n<100;n++) {
      const row=await db.prepare(`SELECT n.sent_message_id,n.state FROM notices n JOIN admin_sessions s ON s.prompt_key=n.notice_key WHERE s.id=?`)
        .bind(session.id).first<{sent_message_id:number|null;state:string}>();
      if(row?.state==="SENT" && row.sent_message_id) return row.sent_message_id;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error("Local dialog prompt was not delivered");
  }
  const number = message("700",await prompt());
  await Promise.all([submit(number),submit(number)]);
  const reason = message("Сверено с участником",await prompt());
  // Two different final deliveries race; the transaction's session-state guard allows only one.
  await Promise.all([submit(reason),submit(reason),submit(message("Повторная сверка",reason.message.reply_to_message!.message_id))]);
  expect(await db.prepare("SELECT effective_amount FROM contributions WHERE message_id=4000").first("effective_amount")).toBe(700);
  expect(await db.prepare("SELECT COUNT(*) n FROM admin_adjustments WHERE adjustment_key=?").bind(`ui-session:${session.id}`).first("n")).toBe(1);
  expect(await db.prepare("SELECT state FROM admin_sessions WHERE id=?").bind(session.id).first("state")).toBe("DONE");
  expect(await db.prepare("SELECT COUNT(*) n FROM admin_ui_events WHERE action='CORRECT' AND outcome='APPLIED'").first("n")).toBe(1);
  const denied = message("/recent"); denied.message.from.id=7;
  await submit(denied);
  expect(await db.prepare("SELECT COUNT(*) n FROM admin_ui_events WHERE actor_id=7").first("n")).toBe(0);
},20_000);
