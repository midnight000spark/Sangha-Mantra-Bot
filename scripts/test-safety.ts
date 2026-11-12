/** TEST-only operator helpers. Never print request URLs, payloads or remote descriptions. */
export function testIdentity(env: Record<string,string|undefined> = process.env) {
  const {BOT_TOKEN,EXPECTED_BOT_ID,TEST_BOT_USERNAME,DEPLOYMENT_ENV} = env;
  if (DEPLOYMENT_ENV !== "test" || !BOT_TOKEN || !EXPECTED_BOT_ID || !TEST_BOT_USERNAME
    || BOT_TOKEN.split(":")[0] !== EXPECTED_BOT_ID || !/^[1-9][0-9]*$/.test(EXPECTED_BOT_ID))
    throw new Error("Set the verified TEST bot identity in the private operator environment");
  return {token:BOT_TOKEN,botId:Number(EXPECTED_BOT_ID),username:TEST_BOT_USERNAME.replace(/^@/,"")};
}

export function testOrigin(value: string | undefined) {
  let origin: URL;
  try { origin = new URL(value ?? ""); } catch { throw new Error("Set the verified TEST Worker origin"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash
    || !["", "/"].includes(origin.pathname) || origin.port
    || !/^sangha-mantra-bot-test\.[a-z0-9-]+\.workers\.dev$/i.test(origin.hostname))
    throw new Error("Only the named TEST workers.dev origin is authorized");
  return origin;
}

export async function telegram<T>(token: string, method: string, payload: unknown = {}): Promise<T> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(20_000),
    });
    const data = await response.json() as {ok:boolean;result:T};
    if (!response.ok || !data.ok) throw new Error();
    return data.result;
  } catch { throw new Error(`Telegram ${method} failed; no credentials or remote response are logged`); }
}

export async function verifiedTestBot(env: Record<string,string|undefined> = process.env) {
  const identity = testIdentity(env);
  const me = await telegram<{id:number;username:string;can_read_all_group_messages?:boolean}>(identity.token,"getMe");
  if (me.id !== identity.botId || me.username.toLowerCase() !== identity.username.toLowerCase())
    throw new Error("getMe differs from the explicitly selected TEST bot");
  return {...identity,canReadGroup:me.can_read_all_group_messages === true};
}
