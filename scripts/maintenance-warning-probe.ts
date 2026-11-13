import { resolve } from "node:path";
import { eventKey } from "../src/parser";
import { parseTelegramUpdate } from "../src/telegram";

/** One isolated synthetic TEST warning, with conditional restoration of the operator's mode. */
async function main() {
  process.umask(0o077);
  const r=await Bun.file(".secrets/maintenance-test-deployment.json").json();
  const s=await Bun.file(".secrets/maintenance-test-secrets.json").json();
  if(r.workerName!=="sangha-mantra-bot-maintenance-test" || r.databaseId!=="cccccccc-dddd-4eee-8fff-000000000001"
    || r.botId!==999000222 || s.BOT_TOKEN.split(":")[0]!=="999000222" || r.chatId!==-1001234567890
    || !/^https:\/\/sangha-mantra-bot-maintenance-test\.[a-z0-9-]+\.workers\.dev$/.test(r.origin)) throw new Error("Unsafe TEST target");
  if(await Bun.file("test-results/maintenance/warning-probe.json").exists()) throw new Error("Accepted warning receipt exists; do not repeat");
  async function sql(command:string) {
    if(!command.startsWith("SELECT")) throw new Error("Only read-only probe SQL is supported");
    const p=Bun.spawn([process.execPath,resolve("node_modules/wrangler/bin/wrangler.js"),"d1","execute","DB","--remote","--json","--command",command,"--config",".secrets/wrangler.maintenance-test.json","--env","test"],{stdout:"pipe",stderr:"pipe"});
    const [code,out]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
    if(code) throw new Error("TEST D1 inspection failed");return JSON.parse(out);
  }
  const initial=(await sql("SELECT silent,changed_at FROM campaign_controls"))[0].results[0];
  let offKey:string|null=null, restore:string="not-needed";
  const base=1900000800;
  const admin=(text:string,id:number)=>({update_id:id,message:{message_id:id,date:Math.floor(Date.now()/1000),chat:{id:r.adminId,type:"private"},from:{id:r.adminId,is_bot:false},text}});
  async function post(value:unknown) {
    const response=await fetch(`${r.origin}/webhook`,{method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":s.WEBHOOK_SECRET},body:JSON.stringify(value),signal:AbortSignal.timeout(20000)});
    await response.text();if(response.status!==200) throw new Error(`TEST probe HTTP ${response.status}`);
  }
  let warning:any;
  try {
    if(initial.silent===1) {
      const off=admin("/silent off",base);
      offKey=await eventKey(parseTelegramUpdate(off));await post(off);
    }
    // Host and Cloudflare clocks differ. Anchor the synthetic event to provider time and OFF.
    const clock=(await sql("SELECT unixepoch() server_seconds,notices_not_before FROM campaign_controls"))[0].results[0];
    const date=Math.max(clock.server_seconds,Math.ceil((clock.notices_not_before ?? 0)/1000))+1;
    await new Promise(resolve=>setTimeout(resolve,2100));
    const invalid={update_id:base+1,message:{message_id:base+1,date,chat:{id:r.chatId,type:"supergroup"},from:{id:r.adminId,is_bot:false},text:"1.5"}};
    await post(invalid);await post(invalid);
    warning=(await sql(`SELECT state,publication_hold,sent_message_id,last_error FROM notices WHERE notice_key='rejected:${r.chatId}:${base+1}'`))[0].results[0];
    if(warning?.state!=="SENT" || !warning.sent_message_id || warning.publication_hold!==0) throw new Error("TEST warning delivery was not confirmed; inspect current operator mode and outbox");
  } finally {
    if(offKey) {
      const last=(await sql("SELECT event_key FROM operational_events WHERE kind='SILENT_CHANGE' ORDER BY created_at DESC LIMIT 1"))[0].results[0];
      if(last?.event_key===offKey) {await post(admin("/silent on",base+2));restore="restored-on";}
      else restore="newer-operator-decision-preserved";
    }
  }
  const after=await sql(`SELECT silent FROM campaign_controls; SELECT COUNT(*) count FROM notices WHERE notice_key='rejected:${r.chatId}:${base+1}' AND state='SENT'; SELECT source_amount,effective_amount FROM contributions WHERE message_id=${base+1}; SELECT day,status,publication_hold FROM daily_reports;`);
  const receipt={environment:"test",syntheticFixture:true,checkedAt:new Date().toISOString(),passed:true,warning,duplicatesSent:after[1].results[0].count,
    invalidContribution:after[2].results[0],initialSilent:initial.silent,finalSilent:after[0].results[0].silent,restore,reports:after[3].results,productionChanged:false};
  if(receipt.duplicatesSent!==1 || receipt.invalidContribution.effective_amount!==0) throw new Error("TEST warning dedup or counting invariant failed");
  await Bun.write("test-results/maintenance/warning-probe.json",JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}
if(import.meta.main) main().catch(error=>{console.error(error instanceof Error?error.message:"TEST warning probe failed; credentials withheld");process.exitCode=1;});
