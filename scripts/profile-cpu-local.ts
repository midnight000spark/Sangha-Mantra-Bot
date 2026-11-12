import { Miniflare } from "miniflare";
import { resolve } from "node:path";

// Local-only workerd sampling. No real environment, D1, network or credentials.
// Deliberately separate from the deployed Worker: each sample amplifies one hot path.
type Profile = { nodes: { id: number; callFrame: { functionName: string }; }[]; samples: number[]; timeDeltas: number[] };
const label = Bun.argv[2];
if (!label || !/^[a-z0-9-]+$/.test(label)) throw new Error("Usage: bun scripts/profile-cpu-local.ts LABEL");
const out = resolve("test-results/cpu");
const entry = `${out}/entry.ts`;
await Bun.write(entry, `
import { getConfig } from ${JSON.stringify(resolve("src/config.ts"))};
import { dayBounds } from ${JSON.stringify(resolve("src/time.ts"))};
import { parseAmount } from ${JSON.stringify(resolve("src/parser.ts"))};
const env = {DEPLOYMENT_ENV:"test",EXPECTED_D1_ID:"11111111-1111-1111-1111-111111111111",EXPECTED_BOT_ID:"123456",
 BOT_TOKEN:"123456:local-only",WEBHOOK_SECRET:"local-only-secret-123456",ADMIN_IDS:"42",CAMPAIGN_ID:"local",
 TIMEZONE:"Europe/Moscow",CAMPAIGN_START:"2026-11-12",REPORT_TIME:"00:05",GOAL:"1000000",MAX_AMOUNT:"1000000",
 ALLOWED_CHAT_IDS:"-1001",REPORT_CHAT_ID:"-1001"};
export default {fetch(request) {
 const mode = new URL(request.url).pathname.slice(1); let check = 0;
 if(mode==="config") for(let i=0;i<3000;i++) check += getConfig(env).goal;
 else if(mode==="calendar") for(let i=0;i<1000;i++) check += dayBounds("2026-11-12",env.TIMEZONE).end;
 else if(mode==="parser") for(let i=0;i<20000;i++) check += parseAmount(["1000🙏","Сегодня 1000!","Привет","1000 и 2000"][i%4],1e6).amount;
 else throw new Error("Unknown profile");
 return Response.json({mode,check});
}};`);
const build = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
if (!build.success) throw new Error("Local profile bundle failed");
const runtime = new Miniflare({ name: "cpu-profile", modules: true, script: await build.outputs[0]!.text(), inspectorPort: 0,
  compatibilityDate: "2026-07-01" });
let socket: WebSocket | undefined;
try {
  const address = await runtime.getInspectorURL(); address.protocol = "http:"; address.pathname = "/json";
  const allTargets = await (await fetch(address)).json() as {id: string; webSocketDebuggerUrl: string}[];
  const targets = allTargets.filter(target => target.id === "core:user:cpu-profile");
  if (targets.length !== 1) throw new Error("Expected one local inspector target");
  socket = new WebSocket(targets[0]!.webSocketDebuggerUrl);
  await new Promise<void>((yes,no) => { socket!.onopen = () => yes(); socket!.onerror = () => no(new Error("Local inspector unavailable")); });
  let nextId = 0;
  const pending = new Map<number, {yes: (v: any) => void; no: (e: Error) => void}>();
  socket.onmessage = message => {
    const value = JSON.parse(String(message.data)); const waiter = pending.get(value.id);
    if (waiter) { pending.delete(value.id); value.error ? waiter.no(new Error(JSON.stringify(value.error))) : waiter.yes(value.result); }
  };
  const cdp = (method: string, params = {}) => new Promise<any>((yes,no) => {
    const id = ++nextId; pending.set(id,{yes,no}); socket!.send(JSON.stringify({id,method,params}));
  });
  await cdp("Profiler.enable"); await cdp("Profiler.setSamplingInterval", { interval: 100 });
  const results = [];
  for (const mode of ["config", "calendar", "parser"]) {
    // One unmeasured batch warms the code and formatter caches in this isolate.
    await (await runtime.dispatchFetch(`http://local.test/${mode}`)).text();
    await cdp("Profiler.start");
    const started = performance.now();
    const response = await runtime.dispatchFetch(`http://local.test/${mode}`);
    const check = await response.json(); const elapsedMs = performance.now() - started;
    const { profile } = await cdp("Profiler.stop") as {profile: Profile};
    await Bun.write(`${out}/${label}-${mode}.cpuprofile`, JSON.stringify(profile));
    const names = new Map(profile.nodes.map(n => [n.id,n.callFrame.functionName || "(anonymous)"]));
    const weights = new Map<string,number>();
    profile.samples.forEach((id,i) => {
      const name = names.get(id)!;
      weights.set(name,(weights.get(name) ?? 0) + profile.timeDeltas[i]!);
    });
    const topSelfUs = [...weights].sort((a,b)=>b[1]-a[1]).slice(0,8);
    results.push({mode,elapsedMs,check,samples:profile.samples.length,topSelfUs});
  }
  const receipt = {label,engine:"local workerd CDP sampling",samplingIntervalUs:100,results,
    limitation:"Amplified warm-path local profile; elapsedMs is host wall time, not Cloudflare billed CPU or a Free gate result"};
  await Bun.write(`${out}/${label}.json`,JSON.stringify(receipt,null,2));
  console.log(JSON.stringify(receipt,null,2));
} finally { socket?.close(); await runtime.dispose(); }
