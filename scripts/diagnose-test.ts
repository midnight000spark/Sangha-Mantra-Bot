import { testOrigin, verifiedTestBot } from "./test-safety";

async function main() {
  const receipt=await Bun.file(".secrets/test-deployment.json").json();
  const origin=testOrigin(receipt.workerUrl);
  const bot=await verifiedTestBot();
  if(bot.botId!==receipt.botId) throw new Error("TEST identity mismatch");
  try {
    const response=await fetch(new URL("/health",origin),{
      headers:{"X-Telegram-Bot-Api-Secret-Token":process.env.WEBHOOK_SECRET!},signal:AbortSignal.timeout(20_000),
    });
    console.log(JSON.stringify({probe:"test-health",httpStatus:response.status}));
    if(response.ok) {
      const data=await response.json() as {campaign:string;status:string;total:unknown;lastCronAt:number|null};
      console.log(JSON.stringify({campaign:data.campaign,status:data.status,total:data.total,lastCronAt:data.lastCronAt}));
    }
  } catch {console.error("TEST health network/TLS request failed; no URL headers or secret values are logged");process.exitCode=1;}
}
if(import.meta.main) main().catch(error=>{console.error(error instanceof Error ? error.message : "TEST diagnosis failed");process.exitCode=1;});
