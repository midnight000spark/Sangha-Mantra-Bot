import { resolve } from "node:path";
import { describeTestTarget } from "./test-target";
import { configureTestWebhook } from "./set-webhook";
import { testOrigin, verifiedTestBot } from "./test-safety";

async function main() {
  const args=Bun.argv.slice(2);
  if(args.some(arg=>arg!=="--webhook-only")) throw new Error("Only --webhook-only is supported");
  const webhookOnly=args.includes("--webhook-only");
  const deployment = await Bun.file(".secrets/test-deployment.json").json() as {
    accountId:string;workerUrl:string;databaseId:string;botId:number;campaignId:string;sourceChatId:number;
  };
  const config = await Bun.file("wrangler.jsonc").json();
  const target = describeTestTarget(config);
  const origin = testOrigin(deployment.workerUrl);
  const bot = await verifiedTestBot();
  if (config.env.test.account_id !== deployment.accountId || !/^[0-9a-f]{32}$/i.test(deployment.accountId)
    || target.databaseId !== deployment.databaseId || target.botId !== deployment.botId || bot.botId !== deployment.botId
    || target.campaignId !== deployment.campaignId || target.sourceChatIds !== String(deployment.sourceChatId)
    || process.env.ALLOWED_CHAT_IDS !== target.sourceChatIds || process.env.REPORT_CHAT_ID !== target.reportChatId)
    throw new Error("Private deployment receipt differs from current TEST configuration or bot/group identity");
  const cliEnv = {...process.env,CLOUDFLARE_ACCOUNT_ID:deployment.accountId,WRANGLER_SEND_METRICS:"false"};
  const cli = [process.execPath,resolve("node_modules/wrangler/bin/wrangler.js")];
  async function verifyDatabase() {
    const child=Bun.spawn([...cli,"d1","info","sangha-mantra-test","--env","test","--json"],{
      stdout:"pipe",stderr:"pipe",env:cliEnv,
    });
    const [code,out] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    if(code!==0) throw new Error("Cannot read back actual TEST D1 identity; secrets were not uploaded");
    let actual: Record<string,unknown>;
    try {actual=JSON.parse(out);} catch {throw new Error("Unrecognized D1 identity response");}
    if(actual.uuid!==target.databaseId || actual.name!==target.databaseName)
      throw new Error("Actual D1 UUID/name differs from the selected TEST target");
  }
  if(webhookOnly) await verifyDatabase();
  for (const name of (webhookOnly ? [] : ["BOT_TOKEN","WEBHOOK_SECRET"]) as ("BOT_TOKEN"|"WEBHOOK_SECRET")[]) {
    if(!process.env[name]) throw new Error("Missing private TEST secret");
    await verifyDatabase();
    await verifiedTestBot();
    const child=Bun.spawn([...cli,"secret","put",name,"--env","test"],{
      stdin:new Blob([process.env[name]!+"\n"]),stdout:"pipe",stderr:"pipe",env:cliEnv,
    });
    const [code] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    if(code!==0) throw new Error(`Cloudflare secret installation failed for ${name}; no values are logged`);
    console.log(`${name}: installed into named TEST Worker`);
  }
  const opsEnv={...process.env,WORKER_URL:origin.origin,CAMPAIGN_ID:target.campaignId};
  console.log(JSON.stringify(await configureTestWebhook(opsEnv)));
  // Only public deployment settings are persisted here; the private env file is unchanged.
  process.env.WORKER_URL=origin.origin; process.env.CAMPAIGN_ID=target.campaignId;
  await import("./monitor");
}
if(import.meta.main) main().catch(error=>{console.error(error instanceof Error ? error.message : "TEST connection failed");process.exitCode=1;});
