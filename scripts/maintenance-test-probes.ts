import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { telegram } from "./test-safety";

/** Authenticated synthetic fixtures against the isolated TEST Worker; never the production bot or DB. */
async function main() {
  process.umask(0o077);
  const r=await Bun.file(".secrets/maintenance-test-deployment.json").json();
  const s=await Bun.file(".secrets/maintenance-test-secrets.json").json();
  if(r.workerName!=="sangha-mantra-bot-maintenance-test" || r.databaseName!=="sangha-mantra-maintenance-test"
    || r.botId!==999000222 || s.BOT_TOKEN.split(":")[0]!==String(r.botId) || r.chatId!==-1001234567890
    || !/^https:\/\/sangha-mantra-bot-maintenance-test\.[a-z0-9-]+\.workers\.dev$/.test(r.origin)) throw new Error("Unsafe TEST probe target");
  const me=await telegram<{id:number}>(s.BOT_TOKEN,"getMe");
  const wh=await telegram<{url:string}>(s.BOT_TOKEN,"getWebhookInfo");
  if(me.id!==r.botId || wh.url!==`${r.origin}/webhook`) throw new Error("Actual TEST bot/webhook mismatch");
  async function sql(command:string) {
    if(!command.trim().startsWith("SELECT")) throw new Error("Probe SQL is read-only");
    const child=Bun.spawn([process.execPath,resolve("node_modules/wrangler/bin/wrangler.js"),"d1","execute","DB","--remote","--json","--command",command,
      "--config",".secrets/wrangler.maintenance-test.json","--env","test"],{stdout:"pipe",stderr:"pipe",env:{...process.env,CLOUDFLARE_ACCOUNT_ID:r.accountId,WRANGLER_SEND_METRICS:"false"}});
    const [code,out]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    if(code!==0) throw new Error("Read-only TEST D1 probe failed");return JSON.parse(out);
  }
  const identity=(await sql("SELECT database_id,bot_id,campaign_id FROM deployment_identity WHERE singleton=1"))[0]?.results?.[0];
  if(identity?.database_id!==r.databaseId || identity.bot_id!==r.botId || identity.campaign_id!==r.campaignId) throw new Error("TEST D1 marker mismatch");
  await mkdir("test-results/maintenance",{recursive:true});
  if(await Bun.file("test-results/maintenance/cloud-probes.json").exists()) throw new Error("Accepted probe receipt exists; inspect it instead of repeating live fixtures");
  const date=Math.max(r.originalNotBefore,Math.floor(Date.now()/1000)-3), id=1900000100;
  let updateId=1900000100;
  const statuses:number[]=[];
  const fixtures:unknown[]=[];
  const source=(text:string,messageId=id,edit=0,originalDate=date)=>({update_id:++updateId,[edit?"edited_message":"message"]:{
    message_id:messageId,date:originalDate,...(edit?{edit_date:date+edit}:{}),chat:{id:r.chatId,type:"supergroup"},from:{id:r.adminId,is_bot:false},text}});
  const admin=(text:string)=>({update_id:++updateId,message:{message_id:++updateId,date:Math.floor(Date.now()/1000),chat:{id:r.adminId,type:"private"},from:{id:r.adminId,is_bot:false},text}});
  async function post(value:unknown) {
    fixtures.push(value);
    const response=await fetch(`${r.origin}/webhook`,{method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":s.WEBHOOK_SECRET},body:JSON.stringify(value),signal:AbortSignal.timeout(20000)});
    statuses.push(response.status);await response.text();
    if(response.status!==200) throw new Error(`TEST webhook HTTP ${response.status}; no payload/credentials logged`);
  }
  await post(admin("/silent on"));
  const old=[source("500",32,1,r.originalNotBefore-60),source("2700",38,2,r.originalNotBefore-60)];
  for(const value of [...old,...old].reverse()) await post(value);
  const original=source("Сегодня 1000🙏");await post(original);await post(original);
  const edited=source("2000",id,1);await post(edited);await post(edited);
  await post(source("100 и 200",id,2));await post(source("Привет",id,3));await post(source("3000",id,4));
  await post(admin(`/override ${r.chatId} ${id} 108 Synthetic TEST correction; verified fixture`));
  await post(source("4000",id,5));
  const historical=new Date((r.originalNotBefore-60)*1000).toISOString();
  await post(admin(`/import ${r.chatId} ${id+1} 777 ${historical} Synthetic TEST historical fixture`));
  await post(source("-100",id+2));
  await post(admin("/help"));await post(admin("/status"));await post(admin("/silent off"));
  // A delayed invalid event from before OFF must not suddenly publish when processed now.
  await post(source("-200",id+3));
  const afterOff=await sql(`SELECT CAST(SUM(effective_amount) AS TEXT) total FROM contributions WHERE campaign_id='${r.campaignId}';
SELECT message_id,effective_amount,override_amount FROM contributions WHERE message_id IN (32,38,${id},${id+1});
SELECT state,publication_hold,COUNT(*) count FROM notices WHERE chat_id=${r.chatId} GROUP BY state,publication_hold;
SELECT silent FROM campaign_controls WHERE campaign_id='${r.campaignId}';
SELECT day,status,publication_hold FROM daily_reports WHERE campaign_id='${r.campaignId}';`);
  const rows=afterOff[1]?.results ?? [], group=afterOff[2]?.results ?? [];
  if(afterOff[0]?.results?.[0]?.total!=="885" || rows.length!==2
    || rows.find((v:any)=>v.message_id===id)?.effective_amount!==108
    || rows.find((v:any)=>v.message_id===id+1)?.effective_amount!==777
    || afterOff[3]?.results?.[0]?.silent!==0 || group.some((v:any)=>v.state!=="PENDING" || v.publication_hold!==1)) throw new Error("TEST count, boundary, override or silence invariant failed");
  // Leave the isolated bot silent for the upcoming real-user acceptance sequence.
  await post(admin("/silent on"));
  const receipt={environment:"test",syntheticFixtures:true,checkedAt:new Date().toISOString(),worker:r.workerName,databaseId:r.databaseId,
    versionId:r.versionId,statuses,passed:true,total:"885",old32And38Absent:true,overrideSurvivedEdit:true,historicalImportVerified:true,
    heldGroupNotices:group,silentOffDidNotPublishBacklog:true,delayedOldNoticeHeld:true,reports:afterOff[4]?.results ?? [],
    finalSilent:true,productionChanged:false};
  await Bun.write("test-results/maintenance/cloud-fixtures.json",JSON.stringify(fixtures,null,2));
  await Bun.write("test-results/maintenance/cloud-probes.json",JSON.stringify(receipt,null,2));
  console.log(JSON.stringify(receipt));
}
if(import.meta.main) main().catch(error=>{console.error(error instanceof Error?error.message:"TEST probes failed; private data withheld");process.exitCode=1;});
