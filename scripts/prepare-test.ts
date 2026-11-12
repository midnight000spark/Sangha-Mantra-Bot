import { mkdir, open, chmod } from "node:fs/promises";
import { telegram } from "./test-safety";

async function main() {
  const token = process.env.BOT_TOKEN;
  const username = process.env.TEST_BOT_USERNAME?.replace(/^@/,"");
  if (!token || !/^[1-9][0-9]*:[A-Za-z0-9_-]{20,}$/.test(token) || !username || !/^[a-z0-9_]+bot$/i.test(username))
    throw new Error("Enter the separate TEST bot username and token in the user terminal");
  const me = await telegram<{id:number;username:string;can_read_all_group_messages?:boolean}>(token,"getMe");
  if (me.username.toLowerCase() !== username.toLowerCase() || String(me.id) !== token.split(":")[0])
    throw new Error("Token does not belong to the selected TEST bot");
  const webhook = await telegram<{url:string}>(token,"getWebhookInfo");
  if (webhook.url) throw new Error("This bot already has a webhook; refusing to take over an existing bot");
  if (!me.can_read_all_group_messages) throw new Error("Disable TEST bot Privacy Mode in BotFather, re-add it, then retry");
  // Without offset: inspect pending updates without acknowledging or resetting them.
  const updates = await telegram<{message?:{chat:{id:number;type:string};from?:{id:number;is_bot:boolean}}}[]>(token,"getUpdates",{
    timeout:0,limit:100,allowed_updates:["message","edited_message","my_chat_member","callback_query"],
  });
  const groupIds = [...new Set(updates.flatMap(u => u.message && ["group","supergroup"].includes(u.message.chat.type) ? [u.message.chat.id] : []))];
  const senderIds = [...new Set(updates.flatMap(u => u.message?.from && !u.message.from.is_bot ? [u.message.from.id] : []))];
  if (groupIds.length !== 1 || !senderIds.length)
    throw new Error("Send 'проверка' in exactly one new TEST group and /start in private, then retry; no updates were acknowledged");
  await mkdir(".secrets",{recursive:true,mode:0o700}); await chmod(".secrets",0o700);
  const values = {
    DEPLOYMENT_ENV:"test", EXPECTED_BOT_ID:String(me.id), TEST_BOT_USERNAME:me.username,
    BOT_TOKEN:token, WEBHOOK_SECRET:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
    BACKUP_KEY_BASE64:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    ALLOWED_CHAT_IDS:String(groupIds[0]), REPORT_CHAT_ID:String(groupIds[0]),
    MAX_EVENT_AGE_HOURS:"0",
  };
  const file = await open(".secrets/.env.ops.test","wx",0o600);
  try { await file.writeFile(Object.entries(values).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join("\n")+"\n"); }
  finally { await file.close(); }
  // Metadata only: safe for the agent to inspect; never includes a token, key, or secret.
  const metadata = await open(".secrets/test-resources.json","wx",0o600);
  try { await metadata.writeFile(JSON.stringify({environment:"test",botId:me.id,botUsername:me.username,
    groupIds,candidateAdminIds:senderIds,workerName:"sangha-mantra-bot-test",databaseName:"sangha-mantra-test"},null,2)+"\n"); }
  finally { await metadata.close(); }
  console.log(JSON.stringify({prepared:true,botUsername:me.username,botId:me.id,groupIds,candidateAdminIds:senderIds,
    privateFile:".secrets/.env.ops.test",pendingUpdatesRetained:true}));
  console.log("Keep the backup key separately with the responsible operators. Do not paste the private file into chat.");
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : "TEST preparation failed"); process.exitCode=1; });
