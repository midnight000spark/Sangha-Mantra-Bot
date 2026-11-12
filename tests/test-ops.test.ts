import { afterEach, expect, spyOn, test } from "bun:test";
import { testIdentity, testOrigin, telegram } from "../scripts/test-safety";
import { configureTestWebhook } from "../scripts/set-webhook";

const env = {DEPLOYMENT_ENV:"test",BOT_TOKEN:"123456:synthetic-test-token",EXPECTED_BOT_ID:"123456",
  TEST_BOT_USERNAME:"synthetic_test_bot",WORKER_URL:"https://sangha-mantra-bot-test.synthetic.workers.dev",
  WEBHOOK_SECRET:"synthetic-test-webhook-secret",CAMPAIGN_ID:"sangha-test"};
let network: ReturnType<typeof spyOn<typeof globalThis,"fetch">> | undefined;
afterEach(()=>network?.mockRestore());

test("operator guard rejects production origins and mismatched bot IDs before network access", async () => {
  for (const url of ["https://sangha-mantra-bot-production.synthetic.workers.dev","https://example.org",
    `${env.WORKER_URL}/webhook`,`${env.WORKER_URL}?token=hidden`,`https://user:pass@sangha-mantra-bot-test.synthetic.workers.dev`])
    expect(()=>testOrigin(url)).toThrow();
  expect(()=>testIdentity({...env,DEPLOYMENT_ENV:"production"})).toThrow();
  expect(()=>testIdentity({...env,EXPECTED_BOT_ID:"999"})).toThrow();
  network=spyOn(globalThis,"fetch");
  await expect(configureTestWebhook({...env,WORKER_URL:"https://production.example"})).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
});

test("Telegram failures never propagate token-bearing URLs or remote descriptions", async () => {
  network=spyOn(globalThis,"fetch").mockRejectedValue(new Error(`fetch failed at https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`));
  let message="";
  try { await telegram(env.BOT_TOKEN,"getMe"); } catch(error) {message=(error as Error).message;}
  expect(message).toContain("Telegram getMe failed"); expect(message).not.toContain(env.BOT_TOKEN);
});

test("webhook setup verifies bot, campaign and old destination, keeps queue and checks readback", async () => {
  const calls: {url:string;body:Record<string,unknown>}[]=[];
  let set=false;
  network=spyOn(globalThis,"fetch").mockImplementation((async (input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);const body=init?.body ? JSON.parse(String(init.body)):{};calls.push({url,body});
    if(url.endsWith("/getMe")) return Response.json({ok:true,result:{id:123456,username:env.TEST_BOT_USERNAME}});
    if(url.endsWith("/health")) return Response.json({campaign:env.CAMPAIGN_ID});
    if(url.endsWith("/setWebhook")) {set=true;return Response.json({ok:true,result:true});}
    return Response.json({ok:true,result:{url:set ? `${env.WORKER_URL}/webhook`:"",
      allowed_updates:["message","edited_message","my_chat_member","callback_query"],pending_update_count:3}});
  }) as typeof fetch);
  expect(await configureTestWebhook(env)).toMatchObject({environment:"test",pendingUpdates:3});
  expect(calls.find(c=>c.url.endsWith("/setWebhook"))?.body).toEqual({url:`${env.WORKER_URL}/webhook`,
    secret_token:env.WEBHOOK_SECRET,allowed_updates:["message","edited_message","my_chat_member","callback_query"],drop_pending_updates:false,max_connections:10});
});

test("existing unknown webhook cannot be overwritten", async () => {
  const methods:string[]=[];
  network=spyOn(globalThis,"fetch").mockImplementation((async (input:RequestInfo|URL)=>{
    const method=String(input).split("/").at(-1)!;methods.push(method);
    return method==="getMe" ? Response.json({ok:true,result:{id:123456,username:env.TEST_BOT_USERNAME}})
      : method==="health" ? Response.json({campaign:env.CAMPAIGN_ID})
      : Response.json({ok:true,result:{url:"https://unknown.example/webhook"}});
  }) as typeof fetch);
  await expect(configureTestWebhook(env)).rejects.toThrow("refusing to overwrite");
  expect(methods).not.toContain("setWebhook");
});

test("target manifest accepts exactly the named TEST D1 and cannot generate SQL for production", async () => {
  const {describeTestTarget}=await import("../scripts/test-target");
  const config=await Bun.file("wrangler.jsonc").json();
  // Use synthetic reviewed IDs; the checked-in remote template is deliberately unprovisioned.
  const target=structuredClone(config);
  target.env.test.vars.EXPECTED_BOT_ID="123456";
  target.env.test.vars.EXPECTED_D1_ID="11111111-1111-1111-1111-111111111111";
  target.env.test.d1_databases[0].database_id=target.env.test.vars.EXPECTED_D1_ID;
  expect(describeTestTarget(target).enrollmentSql).toContain("'test'");
  target.env.test.d1_databases[0].database_name="sangha-mantra-production";
  expect(()=>describeTestTarget(target)).toThrow();
  target.env.test.d1_databases[0].database_name="sangha-mantra-test";
  target.env.test.vars.ALLOWED_CHAT_IDS="-1001,-1002";
  expect(()=>describeTestTarget(target)).toThrow();
});

test("health setup failure reports only HTTP status and never changes webhook", async () => {
  const methods:string[]=[];
  network=spyOn(globalThis,"fetch").mockImplementation((async (input:RequestInfo|URL)=>{
    const method=String(input).split("/").at(-1)!;methods.push(method);
    return method==="getMe" ? Response.json({ok:true,result:{id:123456,username:env.TEST_BOT_USERNAME}})
      : new Response(`private diagnostic ${env.WEBHOOK_SECRET}`,{status:503});
  }) as typeof fetch);
  let message="";
  try {await configureTestWebhook(env);} catch(error) {message=(error as Error).message;}
  expect(message).toContain("HTTP 503");expect(message).not.toContain(env.WEBHOOK_SECRET);
  expect(methods).not.toContain("setWebhook");
});

test("local enrollment explicitly seeds a synthetic intake boundary; remote enrollment never guesses one", async()=>{
  const {describeTestTarget}=await import("../scripts/test-target");
  const config=await Bun.file("wrangler.jsonc").json();
  const local=describeTestTarget(config,true);
  expect(local.enrollmentSql).toContain("INSERT INTO automatic_intake_boundaries");
  expect(local.enrollmentSql).toContain("Synthetic local messages only");
  expect(describeTestTarget(config).enrollmentSql).not.toContain("INSERT INTO automatic_intake_boundaries");
});
