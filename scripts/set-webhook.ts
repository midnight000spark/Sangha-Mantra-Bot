import { telegram, testOrigin, verifiedTestBot } from "./test-safety";

export async function configureTestWebhook(env: Record<string,string|undefined> = process.env) {
  const origin = testOrigin(env.WORKER_URL);
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(env.WEBHOOK_SECRET ?? "")) throw new Error("Set a valid TEST webhook secret");
  const bot = await verifiedTestBot(env);
  // Check that this Worker is already running against the selected campaign before connecting Telegram.
  let health: {campaign:string};
  try {
    const response = await fetch(new URL("/health",origin),{
      headers:{"X-Telegram-Bot-Api-Secret-Token":env.WEBHOOK_SECRET!},signal:AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    health = await response.json() as {campaign:string};
  } catch(error) {
    const status = error instanceof Error && /^HTTP [0-9]{3}$/.test(error.message) ? ` (${error.message})` : " (network/TLS/JSON error)";
    throw new Error(`TEST health could not be verified${status}; webhook was not changed`);
  }
  if (!env.CAMPAIGN_ID || health.campaign !== env.CAMPAIGN_ID) throw new Error("TEST health campaign mismatch");
  const old = await telegram<{url:string}>(bot.token,"getWebhookInfo");
  const url = new URL("/webhook",origin).href;
  if (old.url && old.url !== url) throw new Error("Existing webhook points elsewhere; refusing to overwrite it");
  await telegram(bot.token,"setWebhook",{url,secret_token:env.WEBHOOK_SECRET,
    allowed_updates:["message","edited_message","my_chat_member","callback_query"],drop_pending_updates:false,max_connections:10});
  const current = await telegram<{url:string;allowed_updates?:string[];pending_update_count:number}>(bot.token,"getWebhookInfo");
  if (current.url !== url || ["message","edited_message","my_chat_member","callback_query"].some(v => !current.allowed_updates?.includes(v)))
    throw new Error("Webhook setup response requires operator verification; do not reset pending updates");
  return {environment:"test",botUsername:bot.username,workerOrigin:origin.origin,pendingUpdates:current.pending_update_count};
}
if (import.meta.main) configureTestWebhook().then(result => console.log(JSON.stringify(result)))
  .catch(error => {console.error(error instanceof Error ? error.message : "TEST webhook setup failed");process.exitCode=1;});
