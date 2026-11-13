import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { telegram } from "./test-safety";

// Isolated TEST only. No production deploy, database write, webhook or secret rotation.
const workerName="sangha-mantra-bot-maintenance-test";
const databaseName="sangha-mantra-maintenance-test";
const campaignId="sangha-maintenance-test";
const botId=999000222, chatId=-1001234567890, adminId=876543210;
const privateConfig=".secrets/wrangler.maintenance-test.json";
const receiptPath=".secrets/maintenance-test-deployment.json";
async function main() {
  process.umask(0o077);
  const connectOnly=Bun.argv.length===3 && Bun.argv[2]==="--connect-only";
  if(Bun.argv.length!==2 && !connectOnly) throw new Error("Only --connect-only is supported");
  const base=await Bun.file("wrangler.jsonc").json();
  const accountId=base.env.test.account_id;
  if(accountId!=="00000000000000000000000000000000") throw new Error("Approved account mismatch");
  const token=(await Bun.file(".secrets/.maintenance-token.input").text()).trim();
  if(token.split(":")[0]!==String(botId) || String(botId)===base.env.production.vars.EXPECTED_BOT_ID) throw new Error("Separate TEST bot required");
  const me=await telegram<{id:number;username:string;can_read_all_group_messages?:boolean}>(token,"getMe");
  if(me.id!==botId || me.username.toLowerCase()!=="exampletestbot" || !me.can_read_all_group_messages) throw new Error("TEST bot identity or privacy mismatch");
  const member=await telegram<{status:string}>(token,"getChatMember",{chat_id:chatId,user_id:botId});
  if(!["member","administrator","creator"].includes(member.status)) throw new Error("TEST group membership required");
  const info=await telegram<{url:string;pending_update_count:number}>(token,"getWebhookInfo");
  let receipt:any=await Bun.file(receiptPath).exists()?await Bun.file(receiptPath).json():null;
  if(info.url && (!receipt || info.url!==`${receipt.origin}/webhook`)) throw new Error("Unknown TEST webhook; refusing takeover");
  const env={...process.env,CLOUDFLARE_ACCOUNT_ID:accountId,WRANGLER_SEND_METRICS:"false",CI:"true"};
  const cli=[process.execPath,resolve("node_modules/wrangler/bin/wrangler.js")];
  async function wrangler(args:string[],input?:string,configured=true) {
    const child=Bun.spawn([...cli,...args,...(configured?["--config",privateConfig,"--env","test"]:[])],{
      env,stdin:input===undefined?"ignore":new Blob([input+"\n"]),stdout:"pipe",stderr:"pipe"});
    const [code,out]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    if(code!==0) throw new Error(`TEST Wrangler ${args.slice(0,2).join(" ")} failed; raw output withheld`);
    return out;
  }
  async function connect() {
    if(!receipt || receipt.workerName!==workerName || receipt.databaseName!==databaseName || receipt.botId!==botId || receipt.chatId!==chatId
      || !/^https:\/\/sangha-mantra-bot-maintenance-test\.[a-z0-9-]+\.workers\.dev$/.test(receipt.origin ?? "")
      || [base.env.production.d1_databases[0].database_id,base.env.test.d1_databases[0].database_id].includes(receipt.databaseId)) throw new Error("Unsafe TEST connection target");
    const actual=JSON.parse(await wrangler(["d1","info",databaseName,"--json"]));
    if(actual.uuid!==receipt.databaseId || actual.name!==databaseName) throw new Error("TEST D1 mismatch before webhook");
  const secrets=await Bun.file(".secrets/maintenance-test-secrets.json").json();
  const health=await fetch(`${receipt.origin}/health`,{headers:{"X-Telegram-Bot-Api-Secret-Token":secrets.WEBHOOK_SECRET},signal:AbortSignal.timeout(20000)});
  const body=await health.json().catch(()=>null) as {campaign:string;silent:boolean}|null;
  if(!health.ok || body?.campaign!==campaignId || !body?.silent) throw new Error("TEST health/silence not verified; TEST webhook unchanged");
  await telegram(token,"setWebhook",{url:`${receipt.origin}/webhook`,secret_token:secrets.WEBHOOK_SECRET,
    allowed_updates:["message","edited_message","my_chat_member","callback_query"],drop_pending_updates:false,max_connections:5});
  const after=await telegram<{url:string;pending_update_count:number}>(token,"getWebhookInfo");
  if(after.url!==`${receipt.origin}/webhook`) throw new Error("TEST webhook readback mismatch");
  const versions=JSON.parse(await wrangler(["deployments","list","--json"])) as any[];
  const current=versions.at(-1);receipt.versionId=current?.versions?.[0]?.version_id;receipt.deploymentId=current?.id;
  await Bun.write(receiptPath,JSON.stringify(receipt,null,2));
  console.log(JSON.stringify({...receipt,botUsername:me.username,privacyDisabled:true,silent:true,pendingUpdates:after.pending_update_count,productionChanged:false}));
  }
  if(connectOnly) {await connect();return;}
  const list=JSON.parse(await wrangler(["d1","list","--json"],undefined,false)) as {uuid:string;name:string}[];
  const existing=list.find(r=>r.name===databaseName);
  if(existing && (!receipt || receipt.databaseId!==existing.uuid)) throw new Error("Unowned existing TEST D1; refusing adoption");
  await mkdir(".secrets",{recursive:true,mode:0o700});
  if(!receipt) {
    if(existing) throw new Error("TEST identity mismatch");
    const created=await wrangler(["d1","create",databaseName,"--no-update-config"],undefined,false);
    const match=created.match(/"database_id"\s*:\s*"([a-f0-9-]{36})"/i);
    if(!match) throw new Error("TEST D1 created but UUID could not be parsed; inspect before retry");
    const marker=await telegram<{message_id:number;date:number}>(token,"sendMessage",{chat_id:chatId,text:"TEST: начинаем изолированную проверку обновления. Предыдущие сообщения в новую тестовую кампанию не импортируются. Режим тишины включён до проверки."});
    const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit"}).format();
    const yesterday=new Date(Date.parse(today+"T12:00:00Z")-86400000).toISOString().slice(0,10);
    receipt={environment:"test",accountId,workerName,databaseName,databaseId:match[1],campaignId,botId,chatId,adminId,
      firstMessageId:marker.message_id+1,originalNotBefore:marker.date,startDay:yesterday,origin:null};
    const f=await open(receiptPath,"wx",0o600);try{await f.writeFile(JSON.stringify(receipt,null,2));}finally{await f.close();}
  }
  if(receipt.workerName!==workerName || receipt.databaseName!==databaseName || receipt.botId!==botId || receipt.chatId!==chatId
    || [base.env.production.d1_databases[0].database_id,base.env.test.d1_databases[0].database_id].includes(receipt.databaseId)) throw new Error("Isolated TEST receipt mismatch");
  const vars={...base.env.test.vars,DEPLOYMENT_ENV:"test",EXPECTED_BOT_ID:String(botId),EXPECTED_D1_ID:receipt.databaseId,
    CAMPAIGN_ID:campaignId,CAMPAIGN_START:receipt.startDay,ALLOWED_CHAT_IDS:String(chatId),REPORT_CHAT_ID:String(chatId),ADMIN_IDS:String(adminId)};
  await Bun.write(privateConfig,JSON.stringify({main:resolve("src/worker.ts"),compatibility_date:base.compatibility_date,
    workers_dev:true,observability:{enabled:true},env:{test:{name:workerName,account_id:accountId,vars,
      d1_databases:[{binding:"DB",database_name:databaseName,database_id:receipt.databaseId,migrations_dir:resolve("migrations")}],
      triggers:{crons:["*/5 * * * *"]}}}},null,2));
  const actual=JSON.parse(await wrangler(["d1","info",databaseName,"--json"]));
  if(actual.uuid!==receipt.databaseId || actual.name!==databaseName) throw new Error("Actual TEST D1 mismatch");
  await wrangler(["d1","migrations","apply","DB","--remote"]);
  const sql=`INSERT INTO deployment_identity VALUES(1,'test','${receipt.databaseId}','${campaignId}',${botId},'${chatId}',${chatId}) ON CONFLICT(singleton) DO NOTHING;
INSERT INTO campaigns(id,timezone,start_day,goal,report_chat_id) VALUES('${campaignId}','Europe/Moscow','${receipt.startDay}',1000000,${chatId}) ON CONFLICT(id) DO NOTHING;
INSERT INTO chat_aliases VALUES(${chatId},'${campaignId}') ON CONFLICT(chat_id) DO NOTHING;
INSERT INTO automatic_intake_boundaries VALUES('${campaignId}',${chatId},${receipt.firstMessageId},${receipt.originalNotBefore},'Fresh TEST enrollment after bot marker; no production policy change',${adminId},${Date.now()}) ON CONFLICT(campaign_id,chat_id) DO NOTHING;
INSERT INTO campaign_controls(campaign_id,silent,changed_at,changed_by) VALUES('${campaignId}',1,${Date.now()},${adminId}) ON CONFLICT(campaign_id) DO NOTHING;`;
  await wrangler(["d1","execute","DB","--remote","--command",sql]);
  const deployed=await wrangler(["deploy"]);
  const origin=deployed.match(/https:\/\/sangha-mantra-bot-maintenance-test\.[a-z0-9-]+\.workers\.dev/i)?.[0];
  if(!origin) throw new Error("TEST Worker deployed; origin unavailable, webhook not changed");
  receipt.origin=origin;await Bun.write(receiptPath,JSON.stringify(receipt,null,2));
  const secretsPath=".secrets/maintenance-test-secrets.json";
  let secrets:any;
  if(await Bun.file(secretsPath).exists()) secrets=await Bun.file(secretsPath).json();
  else {
    secrets={BOT_TOKEN:token,WEBHOOK_SECRET:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")};
    const f=await open(secretsPath,"wx",0o600);try{await f.writeFile(JSON.stringify(secrets));}finally{await f.close();}
  }
  if(secrets.BOT_TOKEN!==token || !/^[a-f0-9]{64}$/.test(secrets.WEBHOOK_SECRET)) throw new Error("Private TEST secrets mismatch");
  for(const name of ["BOT_TOKEN","WEBHOOK_SECRET"]) await wrangler(["secret","put",name],secrets[name]);
  await connect();
}
if(import.meta.main) main().catch(error=>{console.error(error instanceof Error?error.message:"TEST setup failed; private details withheld");process.exitCode=1;});
