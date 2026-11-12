import { expect, spyOn, test } from "bun:test";
import { getConfig } from "../src/config";
import { localDay } from "../src/time";
import type { Env } from "../src/types";

// Public dummy local identity only; no real TEST secrets/configuration.
const env = {
  DEPLOYMENT_ENV:"test", EXPECTED_D1_ID:"11111111-1111-1111-1111-111111111111", EXPECTED_BOT_ID:"123456",
  BOT_TOKEN:"123456:local-token", WEBHOOK_SECRET:"local-secret-123456", ADMIN_IDS:"42", CAMPAIGN_ID:"local",
  TIMEZONE:"Pacific/Chatham", CAMPAIGN_START:"2026-11-12", REPORT_TIME:"00:05", GOAL:"1000000", MAX_AMOUNT:"1000000",
  ALLOWED_CHAT_IDS:"-1001", REPORT_CHAT_ID:"-1001",
} as Env;

test("repeated config and calendar calls allocate one shared formatter per timezone", () => {
  const formatter = spyOn(Intl,"DateTimeFormat");
  try {
    expect(getConfig(env).timezone).toBe("Pacific/Chatham");
    expect(getConfig({...env,GOAL:"2000"}).goal).toBe(2000);
    expect(localDay(Date.parse("2026-11-11T11:00:00Z")/1000,env.TIMEZONE)).toBe("2026-11-12");
    expect(formatter).toHaveBeenCalledTimes(1);
    expect(getConfig({...env,TIMEZONE:"UTC"}).timezone).toBe("UTC");
    expect(localDay(Date.parse("2026-11-11T11:00:00Z")/1000,"UTC")).toBe("2026-11-11");
    // A warmed valid timezone must never bypass validation of a changed config.
    expect(() => getConfig({...env,TIMEZONE:"Invalid/Timezone"})).toThrow();
    expect(() => getConfig({...env,TIMEZONE:"Invalid/Timezone"})).toThrow();
    expect(() => getConfig({...env,DEPLOYMENT_ENV:"production"})).toThrow("production isolation");
    expect(() => getConfig({...env,BOT_TOKEN:"654321:wrong-bot"})).toThrow("TEST resource identity");
    expect(() => getConfig({...env,WEBHOOK_SECRET:"short"})).toThrow("webhook secret");
  } finally { formatter.mockRestore(); }
});

test("production requires its own explicitly provisioned database marker", async () => {
  const { createTestDb } = await import("./db");
  const { initialize } = await import("../src/config");
  const db = await createTestDb();
  const production = getConfig({ ...env, DEPLOYMENT_ENV: "production", CAMPAIGN_ID: "sangha-production",
    ALLOWED_CHAT_IDS: "-1001234567891", REPORT_CHAT_ID: "-1001234567891" });
  await expect(initialize(db, production)).rejects.toThrow("identity");
  await db.prepare("INSERT INTO production_deployment_identity VALUES(1,'production',?,'sangha-production',123456,'-1001234567891',-1001234567891)")
    .bind("11111111-1111-1111-1111-111111111111").run();
  await initialize(db, production);
  await expect(initialize(db, { ...production, deployment: { ...production.deployment!, databaseId: "22222222-2222-2222-2222-222222222222" } })).rejects.toThrow("identity");
  expect(() => getConfig({ ...env, DEPLOYMENT_ENV:"production", CAMPAIGN_ID:"sangha-production",
    ALLOWED_CHAT_IDS:"-1001234567891", REPORT_CHAT_ID:"-1001234567891", EXPECTED_D1_ID:"11111111-2222-4333-8444-555555555555" })).toThrow("isolation");
});
