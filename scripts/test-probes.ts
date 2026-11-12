import { resolve } from "node:path";
import { mkdir, chmod } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { describeTestTarget } from "./test-target";
import { telegram, testOrigin, verifiedTestBot } from "./test-safety";
import { readBackup } from "./backup";

async function main() {
  process.umask(0o077);
  const mode=Bun.argv[2];
  if(!["replay","backup","status"].includes(mode ?? "")) throw new Error("Use status, replay or backup");
  const deployment=await Bun.file(".secrets/test-deployment.json").json();
  const config=await Bun.file("wrangler.jsonc").json();
  const target=describeTestTarget(config);const origin=testOrigin(deployment.workerUrl);const bot=await verifiedTestBot();
  if(bot.botId!==target.botId || target.databaseId!==deployment.databaseId || config.env.test.account_id!==deployment.accountId)
    throw new Error("TEST receipt/config/bot mismatch");
  const headers={"X-Telegram-Bot-Api-Secret-Token":process.env.WEBHOOK_SECRET!};
  const cli=[process.execPath,resolve("node_modules/wrangler/bin/wrangler.js")];
  const cliEnv={...process.env,CLOUDFLARE_ACCOUNT_ID:deployment.accountId,WRANGLER_SEND_METRICS:"false"};
  const preflight=Bun.spawn([...cli,"d1","info",target.databaseName,"--env","test","--json"],{stdout:"pipe",stderr:"pipe",env:cliEnv});
  const [code,out]=await Promise.all([preflight.exited,new Response(preflight.stdout).text(),new Response(preflight.stderr).text()]);
  if(code!==0) throw new Error("TEST provider identity unavailable");
  const actual=JSON.parse(out);
  if(actual.uuid!==target.databaseId || actual.name!==target.databaseName) throw new Error("Actual TEST D1 mismatch");
  async function health() {
    const response=await fetch(new URL("/health",origin),{headers,signal:AbortSignal.timeout(20_000)});
    if(!response.ok) throw new Error(`TEST health HTTP ${response.status}`);
    return await response.json() as {campaign:string;total:{total:string;messages:number;review:number};lastCronAt:number|null};
  }
  const before=await health();if(before.campaign!==target.campaignId) throw new Error("Health campaign mismatch");
  await mkdir("test-results/live",{recursive:true});
  if(mode==="status") {
    const info=await telegram<{url:string;pending_update_count:number;last_error_date?:number}>(bot.token,"getWebhookInfo");
    console.log(JSON.stringify({environment:"test",health:before,webhookMatches:info.url===new URL("/webhook",origin).href,
      pendingUpdates:info.pending_update_count,lastErrorDate:info.last_error_date??null}));return;
  }
  if(mode==="replay") {
    const fixtures=await Bun.file("test-results/live/replay-updates.json").json() as {update_id:number;message:{chat:{id:number};date:number;message_id:number}}[];
    if(!fixtures.length || fixtures.some(v=>v.message.chat.id!==Number(target.sourceChatIds))) throw new Error("Replay contains a non-TEST source");
    const statuses:number[]=[];
    for(const fixture of [...fixtures,...fixtures]) {
      const response=await fetch(new URL("/webhook",origin),{method:"POST",headers,body:JSON.stringify(fixture),signal:AbortSignal.timeout(20_000)});
      statuses.push(response.status);
    }
    const invalid=await fetch(new URL("/webhook",origin),{method:"POST",headers:{"X-Telegram-Bot-Api-Secret-Token":"deliberately-wrong-test-secret"},body:JSON.stringify(fixtures[0])});
    // Authenticated synthetic unauthorized contexts: cannot accrue or execute admin commands.
    for(const fixture of [
      {...fixtures[0],update_id:2100000000,message:{...fixtures[0]!.message,message_id:2100000000,chat:{id:-1009999999999999,type:"supergroup"}}},
      {update_id:2100000001,message:{message_id:2100000001,date:Math.floor(Date.now()/1000),chat:{id:123456789,type:"private"},from:{id:123456789,is_bot:false},text:`/override ${target.sourceChatIds} ${fixtures[0]!.message.message_id} 999 unauthorized`}},
    ]) statuses.push((await fetch(new URL("/webhook",origin),{method:"POST",headers,body:JSON.stringify(fixture)})).status);
    const after=await health();
    const receipt={environment:"test",checkedAt:new Date().toISOString(),fixtures:fixtures.length,statuses,
      wrongSecretStatus:invalid.status,before:before.total,after:after.total,
      passed:statuses.every(v=>v===200)&&invalid.status===401&&JSON.stringify(before.total)===JSON.stringify(after.total)};
    await Bun.write("test-results/live/replay-receipt.json",JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
    if(!receipt.passed) process.exitCode=1;return;
  }
  await mkdir("backups",{recursive:true,mode:0o700});await chmod("backups",0o700);
  const stamp=new Date().toISOString().replace(/[:.]/g,"-");const archive=`backups/test-${stamp}.mantra`;const restored=`backups/test-${stamp}.sqlite`;
  for(const args of [["scripts/backup.ts","remote","DB",archive,"--env","test"],["scripts/restore.ts",archive,restored]]) {
    const child=Bun.spawn([process.execPath,...args],{stdout:"pipe",stderr:"pipe",env:cliEnv});
    const [exitCode]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    if(exitCode!==0) throw new Error(`TEST ${args[0]} failed; outputs remain private for operator diagnosis`);
  }
  const manifest=await readBackup(archive);const source=new Database(":memory:");source.exec(manifest.sql);
  const copy=new Database(restored,{readonly:true});
  const tables=["contributions","event_log","admin_adjustments","report_resolutions"];
  const hashes:Record<string,string>={};
  for(const table of tables) {
    const a=JSON.stringify(source.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const b=JSON.stringify(copy.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
    if(a!==b) throw new Error(`TEST restored journal differs: ${table}`);
    hashes[table]=new Bun.CryptoHasher("sha256").update(a).digest("hex");
  }
  const paused=copy.query("SELECT COUNT(*) n FROM recovery_state WHERE reconciled_at IS NULL").get() as {n:number};
  source.close();copy.close();
  const receipt={environment:"test",passed:paused.n>0,archive,restored,exportStartedAt:manifest.exportStartedAt,
    exportCompletedAt:manifest.exportCompletedAt,summary:manifest.summary,sqlSha256:manifest.sqlSha256,journalHashes:hashes,
    recoveryPauseVerified:paused.n>0,remoteD1Export:true,independentOffAccountStorage:false};
  await Bun.write("test-results/live/remote-backup-receipt.json",JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
  if(!receipt.passed) process.exitCode=1;
}
if(import.meta.main) main().catch(()=>{console.error("TEST probe failed; no credentials, request payloads or token-bearing URLs are logged");process.exitCode=1;});
