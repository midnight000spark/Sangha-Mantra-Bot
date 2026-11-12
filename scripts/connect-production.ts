import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { telegram } from "./test-safety";

// Run only in the owner's terminal with the existing private TEST env loaded.
const token = process.env.BOT_TOKEN;
const testSecret = process.env.WEBHOOK_SECRET;
const worker = "https://sangha-mantra-bot-production.example-subdomain.workers.dev";
const testWebhook = "https://sangha-mantra-bot-test.example-subdomain.workers.dev/webhook";
const databaseId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
async function main() {
  if (!token || token.split(":")[0] !== "999000111" || !testSecret) throw new Error("Load the existing private bot token and TEST secret");
  const me = await telegram<{id:number;username:string;can_read_all_group_messages?:boolean}>(token,"getMe");
  if (me.id !== 999000111 || me.username.toLowerCase() !== "examplemantrabot" || !me.can_read_all_group_messages) throw new Error("Bot identity or privacy mode mismatch");
  const chat = await telegram<{id:number;type:string;permissions?:{can_send_messages?:boolean}}>(token,"getChat",{chat_id:-1001234567891});
  const member = await telegram<{status:string;can_send_messages?:boolean}>(token,"getChatMember",{chat_id:-1001234567891,user_id:me.id});
  if (chat.id !== -1001234567891 || chat.type !== "supergroup" || !["creator","administrator","member"].includes(member.status)
    || (member.status === "member" && chat.permissions?.can_send_messages !== true)) throw new Error("Working group membership or permission to send is not verified");
  const info = await telegram<{url:string;pending_update_count:number}>(token,"getWebhookInfo");
  if (![testWebhook, `${worker}/webhook`].includes(info.url) || info.pending_update_count !== 0) throw new Error("Unexpected current webhook or pending updates; no webhook change");
  await mkdir(".secrets",{recursive:true,mode:0o700});
  const path = ".secrets/production-webhook-secret";
  let secret: string;
  try { secret = (await readFile(path,"utf8")).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    await writeFile(path,secret+"\n",{mode:0o600,flag:"wx"});
  }
  if (!/^[a-f0-9]{64}$/.test(secret) || secret === testSecret) throw new Error("Invalid or reused production webhook secret");
  const cli = [process.execPath,resolve("node_modules/wrangler/bin/wrangler.js")];
  const env = {...process.env,CLOUDFLARE_ACCOUNT_ID:"00000000000000000000000000000000",WRANGLER_SEND_METRICS:"false"};
  async function cliCall(args:string[],input?:string) {
    const p=Bun.spawn([...cli,...args],{env,stdin:input === undefined ? "ignore" : new Blob([input+"\n"]),stdout:"pipe",stderr:"pipe"});
    const [code,out] = await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
    if (code!==0) throw new Error("Cloudflare operation failed; no credentials or raw output printed");
    return out;
  }
  const db=JSON.parse(await cliCall(["d1","info","sangha-mantra-production","--env","production","--json"])) as {uuid:string;name:string};
  if(db.uuid!==databaseId || db.name!=="sangha-mantra-production") throw new Error("Production D1 mismatch");
  for(const [name,value] of [["BOT_TOKEN",token],["WEBHOOK_SECRET",secret]] as const)
    await cliCall(["secret","put",name,"--env","production"],value);
  let health: {campaign?:string;status?:string};
  try {
    const response=await fetch(`${worker}/health`,{headers:{"X-Telegram-Bot-Api-Secret-Token":secret},signal:AbortSignal.timeout(20000)});
    if(!response.ok) throw new Error();
    health=await response.json() as typeof health;
  } catch { throw new Error("Production health not verified; webhook unchanged"); }
  if(health.campaign!=="sangha-production" || health.status!=="ok") throw new Error("Production health mismatch; webhook unchanged");
  const latest=await telegram<{url:string;pending_update_count:number}>(token,"getWebhookInfo");
  if(latest.url!==info.url || latest.pending_update_count!==0) throw new Error("Webhook or queue changed; no cutover");
  await telegram(token,"setWebhook",{url:`${worker}/webhook`,secret_token:secret,allowed_updates:["message","edited_message","my_chat_member","callback_query"],drop_pending_updates:false,max_connections:10});
  const after=await telegram<{url:string;allowed_updates?:string[];pending_update_count:number}>(token,"getWebhookInfo");
  if(after.url!==`${worker}/webhook` || ["message","edited_message","my_chat_member","callback_query"].some(x=>!after.allowed_updates?.includes(x))) throw new Error("Webhook readback failed; inspect manually before retry");
  console.log(JSON.stringify({environment:"production",bot:me.username,chatId:chat.id,membership:member.status,webhook:after.url,pendingUpdates:after.pending_update_count,health:health.status}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Production connection failed");process.exitCode=1;});
