import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Database } from "bun:sqlite";
import { backupKey, packBackup } from "./backup";
import { restoreBackup } from "./restore";

export function productionTarget(config: any) {
  const p = config.env?.production;
  const db = p?.d1_databases?.[0];
  if (p?.name !== "sangha-mantra-bot-production" || p.account_id !== "00000000000000000000000000000000"
    || p.vars?.DEPLOYMENT_ENV !== "production" || p.vars.CAMPAIGN_ID !== "sangha-production"
    || p.vars.EXPECTED_BOT_ID !== "999000111" || p.vars.ALLOWED_CHAT_IDS !== "-1001234567891"
    || p.vars.REPORT_CHAT_ID !== "-1001234567891" || p.d1_databases.length !== 1
    || db.binding !== "DB" || db.database_name !== "sangha-mantra-production"
    || db.database_id !== "66666666-7777-4888-8999-aaaaaaaaaaaa" || p.vars.EXPECTED_D1_ID !== db.database_id)
    throw new Error("Production target mismatch");
  return { accountId: p.account_id as string, databaseId: db.database_id as string,
    workerName: p.name as string, vars: p.vars as Record<string, string>,
    origin: "https://sangha-mantra-bot-production.example-subdomain.workers.dev" };
}

// Owner-terminal only. Never install secrets, change webhook, or import into remote D1.
async function main() {
  process.umask(0o077);
  const [mode, ...extra] = Bun.argv.slice(2);
  if (!mode || !["check", "backup"].includes(mode) || extra.length) throw new Error("Use check or backup");
  const target = productionTarget(await Bun.file("wrangler.jsonc").json());
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: target.accountId, WRANGLER_SEND_METRICS: "false" };
  const cli = [process.execPath, resolve("node_modules/wrangler/bin/wrangler.js")];
  async function wrangler(args: string[]) {
    const child = Bun.spawn([...cli, ...args, "--env", "production"], { env, stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error("Production Cloudflare operation failed");
    return out;
  }
  const info = JSON.parse(await wrangler(["d1", "info", "sangha-mantra-production", "--json"]));
  if (info.uuid !== target.databaseId || info.name !== "sangha-mantra-production") throw new Error("Actual D1 mismatch");
  if (mode === "check") {
    const secret = (await readFile(".secrets/production-webhook-secret", "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(secret) || process.env.BOT_TOKEN?.split(":")[0] !== target.vars.EXPECTED_BOT_ID)
      throw new Error("Load the private bot env; production secret must already exist");
    const child = Bun.spawn([process.execPath, "scripts/monitor.ts"], { env: { ...env,
      BOT_TOKEN: process.env.BOT_TOKEN!, WEBHOOK_SECRET: secret, WORKER_URL: target.origin,
      REPORT_CHAT_ID: target.vars.REPORT_CHAT_ID!, ALLOWED_CHAT_IDS: target.vars.ALLOWED_CHAT_IDS!,
      MAX_EVENT_AGE_HOURS: "0", GITHUB_REPOSITORY: "", GH_TOKEN: "" }, stdout: "inherit", stderr: "inherit" });
    process.exitCode = await child.exited;
    return;
  }
  await backupKey(); // Validate before any export; the existing private key stays in this process.
  await mkdir("backups", { recursive: true, mode: 0o700 });
  const base = join("backups", `production-${new Date().toISOString().replaceAll(":", "-")}`);
  const sqlPath = `${base}.sql`, archive = `${base}.mantra`, restored = `${base}.sqlite`;
  for (const path of [sqlPath, archive, restored, `${restored}.restoration.json`, `${base}.receipt.json`])
    if (await Bun.file(path).exists()) throw new Error("Backup output already exists");
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    await wrangler(["d1", "export", "DB", "--remote", "--skip-confirmation", "--output", sqlPath]);
    const sql = await Bun.file(sqlPath).text();
    const db = new Database(":memory:");
    try {
      db.exec(sql);
      const id = db.query("SELECT * FROM production_deployment_identity WHERE singleton=1").get() as any;
      if (id?.database_id !== target.databaseId || id.environment !== "production"
        || id.campaign_id !== target.vars.CAMPAIGN_ID || id.bot_id !== Number(target.vars.EXPECTED_BOT_ID)
        || id.source_chat_ids !== target.vars.ALLOWED_CHAT_IDS || String(id.report_chat_id) !== target.vars.REPORT_CHAT_ID)
        throw new Error("Exported production identity mismatch");
    } finally { db.close(); }
    const manifest = await packBackup(sql, `d1:${target.databaseId}`, startedAt, archive);
    const receipt = await restoreBackup(archive, restored);
    const output = { environment: "production", passed: true, archive, restoreVerified: true,
      durationMs: Math.round(performance.now() - started), summary: manifest.summary,
      sqlSha256: receipt.sqlSha256, recoveryPauseVerified: receipt.reportsPaused,
      independentStorage: false, restoredIntoRemote: false };
    await Bun.write(`${base}.receipt.json`, JSON.stringify(output, null, 2) + "\n");
    console.log(JSON.stringify(output));
  } finally {
    // Only the raw export created by this run; encrypted archive and restore receipt remain.
    await rm(sqlPath, { force: true });
    await rm(restored, { force: true });
  }
}

if (import.meta.main) main().catch(() => {
  console.error("Production operation failed; credentials and raw remote output withheld. Check private env/authorization and retry.");
  process.exitCode = 1;
});
