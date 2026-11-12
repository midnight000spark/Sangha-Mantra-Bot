import type { Config, Env } from "./types";
import { validateTimezone } from "./time";

export function getConfig(env: Env): Config {
  if (env.DEPLOYMENT_ENV !== "test" && env.DEPLOYMENT_ENV !== "production") throw new Error("Invalid deployment environment");
  if (env.DEPLOYMENT_ENV === "production" && (env.CAMPAIGN_ID !== "sangha-production"
    || env.ALLOWED_CHAT_IDS !== "-1001234567891" || env.REPORT_CHAT_ID !== "-1001234567891"
    || env.EXPECTED_D1_ID === "11111111-2222-4333-8444-555555555555"
    || env.EXPECTED_D1_ID === "00000000-0000-0000-0000-000000000002")) throw new Error("Invalid production isolation");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.EXPECTED_D1_ID ?? "")
    || !/^[1-9][0-9]*$/.test(env.EXPECTED_BOT_ID ?? "")
    || !Number.isSafeInteger(Number(env.EXPECTED_BOT_ID))
    || env.BOT_TOKEN?.split(":")[0] !== env.EXPECTED_BOT_ID) throw new Error("Invalid TEST resource identity");
  const ids = (value: string, positive: boolean) => {
    const parts = value.split(",").map(part => part.trim());
    if (parts.some(part => !/^-?[1-9][0-9]*$/.test(part))) throw new Error("Invalid configured Telegram IDs");
    const values = parts.map(Number);
    if (values.some(id => !Number.isSafeInteger(id) || (positive ? id < 1 : id > -1))) throw new Error("Invalid configured Telegram IDs");
    return values;
  };
  const goal = Number(env.GOAL);
  const maxAmount = Number(env.MAX_AMOUNT);
  if (![goal, maxAmount].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1_000_000_000)) throw new Error("Invalid numeric limits");
  if (!/^[\w-]{1,64}$/.test(env.CAMPAIGN_ID)) throw new Error("Invalid campaign ID");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(env.CAMPAIGN_START) || new Date(`${env.CAMPAIGN_START}T00:00:00Z`).toISOString().slice(0, 10) !== env.CAMPAIGN_START) throw new Error("Invalid campaign start date");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(env.REPORT_TIME)) throw new Error("Invalid report time");
  validateTimezone(env.TIMEZONE);
  if (!env.BOT_TOKEN || !/^[A-Za-z0-9_-]{16,256}$/.test(env.WEBHOOK_SECRET)) throw new Error("Missing token or invalid webhook secret");
  const reportChatIds = ids(env.REPORT_CHAT_ID, false);
  if (reportChatIds.length !== 1) throw new Error("Configure exactly one report chat");
  return {
    deployment: { environment: env.DEPLOYMENT_ENV, databaseId: env.EXPECTED_D1_ID, botId: Number(env.EXPECTED_BOT_ID),
      sourceChatIds: ids(env.ALLOWED_CHAT_IDS, false).sort((a,b) => a-b).join(","), reportChatId: reportChatIds[0]! },
    campaignId: env.CAMPAIGN_ID, timezone: env.TIMEZONE, startDay: env.CAMPAIGN_START,
    reportTime: env.REPORT_TIME, goal, maxAmount,
    allowedChatIds: ids(env.ALLOWED_CHAT_IDS, false), adminIds: ids(env.ADMIN_IDS, true),
    reportChatId: reportChatIds[0]!,
  };
}

export async function initialize(db: D1Database, config: Config) {
  if (config.deployment) {
    const environment = config.deployment.environment ?? "test";
    const table = environment === "production" ? "production_deployment_identity" : "deployment_identity";
    const identity = await db.prepare(`SELECT environment,database_id,campaign_id,bot_id,source_chat_ids,report_chat_id
      FROM ${table} WHERE singleton=1`).first<{
        environment:string;database_id:string;campaign_id:string;bot_id:number;source_chat_ids:string;report_chat_id:number;
      }>();
    if (!identity || identity.environment !== environment || identity.database_id !== config.deployment.databaseId
      || identity.campaign_id !== config.campaignId || identity.bot_id !== config.deployment.botId
      || identity.source_chat_ids !== config.deployment.sourceChatIds || identity.report_chat_id !== config.deployment.reportChatId) {
      throw new Error("D1 identity differs from the provisioned TEST resources");
    }
  }
  await db.batch([
    db.prepare("INSERT INTO campaigns(id,timezone,start_day,goal,report_chat_id) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
      .bind(config.campaignId, config.timezone, config.startDay, config.goal, config.reportChatId),
    ...config.allowedChatIds.map(id => db.prepare("INSERT INTO chat_aliases(chat_id,campaign_id) VALUES(?,?) ON CONFLICT(chat_id) DO NOTHING").bind(id, config.campaignId)),
  ]);
  const stored = await db.prepare("SELECT timezone,start_day,goal FROM campaigns WHERE id=?").bind(config.campaignId).first<{timezone:string;start_day:string;goal:number}>();
  if (!stored || stored.timezone !== config.timezone || stored.start_day !== config.startDay || stored.goal !== config.goal) {
    throw new Error("Campaign timezone, start day and goal are immutable; use a reviewed migration");
  }
}
