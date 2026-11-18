import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { Miniflare, Response as RuntimeResponse } from "miniflare";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize } from "../src/config";
import { adjust, importContribution, ingest, inspect, totals } from "../src/core";
import { packBackup } from "../scripts/backup";
import { restoreBackup } from "../scripts/restore";
import { runReports } from "../src/reports";
import { seedIdentity } from "./db";
import { boundaryConfig as config, boundaryEvent, incidentNow, intakeBoundaryCases, installBoundary, openingImport } from "./intake-boundary-cases";

async function executeSql(db: D1Database, source: string) {
  let sql = "";
  for (const line of source.split(/\r?\n/)) {
    sql += line + "\n";
    const trigger = /^\s*CREATE TRIGGER/i.test(sql.trim());
    if ((trigger && /^END;\s*$/.test(line)) || (!trigger && /;\s*$/.test(line))) {
      await db.prepare(sql.trim()).run(); sql = "";
    }
  }
  if (sql.trim()) throw Error("Unconsumed test SQL");
}
async function openRuntime(compiled = false, migrate = true) {
  const sends: unknown[] = [];
  const build = compiled ? await Bun.build({ entrypoints: ["tests/notice-source-worker.ts"], target: "browser", format: "esm" }) : null;
  if (build && !build.success) throw Error(`Worker build failed: ${build.logs}`);
  const runtime = new Miniflare({ modules: true, script: build ? await build.outputs[0]!.text() : "export default {fetch(){return new Response('ok')}}",
    d1Databases: { DB: "a04-boundary" },
    bindings: { DEPLOYMENT_ENV: "test", EXPECTED_D1_ID: "11111111-1111-1111-1111-111111111111", EXPECTED_BOT_ID: "123456",
      BOT_TOKEN: "123456:local-token", WEBHOOK_SECRET: "runtime-secret-1234567890", ADMIN_IDS: "42", CAMPAIGN_ID: config.campaignId,
      TIMEZONE: config.timezone, CAMPAIGN_START: config.startDay, REPORT_TIME: config.reportTime,
      GOAL: "1000000", MAX_AMOUNT: "1000000", ALLOWED_CHAT_IDS: "-1001,-1002", REPORT_CHAT_ID: "-1001" },
    outboundService: async (request: unknown) => {
      sends.push(await (request as Request).json());
      return new RuntimeResponse(JSON.stringify({ ok: true, result: { message_id: sends.length + 100 } }), { headers: { "Content-Type": "application/json" } });
    } });
  try {
    const db = await runtime.getD1Database("DB") as unknown as D1Database;
    if (migrate) for (const name of Array.from(new Glob("*.sql").scanSync("migrations")).sort()) await executeSql(db, await Bun.file(`migrations/${name}`).text());
    return { db, runtime, sends, close: () => runtime.dispose() };
  } catch (error) { await runtime.dispose(); throw error; }
}

describe("automatic intake boundaries", () => intakeBoundaryCases("D1/workerd", () => openRuntime()));

test("compiled Worker: old32/35/38 x3 + delayed originals stay absent; migrated source requires its own boundary", async () => {
  const { db, runtime, sends, close } = await openRuntime(true);
  try {
    await seedIdentity(db); await initialize(db, config); await installBoundary(db);
    await importContribution(db, config, openingImport);
    const post = async (value: unknown) => {
      const response = await runtime.dispatchFetch("https://local.invalid/webhook", { method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "runtime-secret-1234567890" }, body: JSON.stringify(value) });
      expect(response.status).toBe(200);
    };
    for (const [id, amount] of [[32, 500], [35, 5000], [38, 2700]] as const) {
      const source = { message_id: id, date: openingImport.originalDate, from: { id: 7, is_bot: false }, chat: { id: -1001, type: "supergroup" }, text: String(amount) };
      for (const revision of [1, 2, 3]) await post({ update_id: id * 100 + revision, edited_message: { ...source, edit_date: source.date + 86400 + revision } });
      await post({ update_id: id * 100, message: source });
      expect(await inspect(db, -1001, id)).toBeNull();
    }
    expect((await totals(db, config.campaignId)).total).toBe("14950");
    expect(sends).toEqual([]);
    await post({ update_id: 9000, message: { message_id: 1000, date: openingImport.originalDate,
      chat: { id: -1001, type: "group" }, migrate_to_chat_id: -2001 } });
    expect(await db.prepare("SELECT campaign_id FROM chat_aliases WHERE chat_id=-2001").first("campaign_id")).toBe(config.campaignId);
    expect(await db.prepare("SELECT COUNT(*) n FROM automatic_intake_boundaries WHERE chat_id=-2001").first("n")).toBe(0);
    const health = await runtime.dispatchFetch("https://local.invalid/health", { headers: { "X-Telegram-Bot-Api-Secret-Token": "runtime-secret-1234567890" } });
    expect(health.status).toBe(200);
    // Repeated health/webhook initialization cannot turn a migration or configured alias into eligibility.
    expect(await db.prepare("SELECT COUNT(*) n FROM automatic_intake_boundaries").first("n")).toBe(1);
    expect((await runReports(db, config, "unused", incidentNow, async () => { throw Error("unexpected send"); })).paused).toBe(true);
    expect(sends).toEqual([]);
  } finally { await close(); }
}, 30_000);

// Test-only SQL snapshot: real D1 tables, omit generated columns, install triggers after rows.
// The independent backup:drill additionally exercises the actual Wrangler local export command.
async function exportFixture(db: D1Database) {
  const schemas = (await db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name")
    .all<{ type: string; name: string; sql: string }>()).results;
  const quote = (v: unknown): string => v === null ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replaceAll("'", "''") + "'";
  const ident = (v: string) => '"' + v.replaceAll('"', '""') + '"';
  const tables = schemas.filter(s => s.type === "table");
  const parents = ["campaigns", "chat_aliases", "contributions", "daily_reports"];
  const rank = (name: string) => parents.includes(name) ? parents.indexOf(name) : parents.length;
  // D1 enforces foreign keys even across individually executed restore statements.
  const parts = tables.map(s => s.sql + ";");
  for (const s of tables.sort((a, b) => rank(a.name) - rank(b.name))) {
    const columns = (await db.prepare(`PRAGMA table_xinfo(${ident(s.name)})`).all<{ name: string; hidden: number }>()).results.filter(c => !c.hidden).map(c => c.name);
    const rows = (await db.prepare(`SELECT ${columns.map(ident).join(",")} FROM ${ident(s.name)} ORDER BY rowid`).all<Record<string, unknown>>()).results;
    for (const row of rows) parts.push(`INSERT INTO ${ident(s.name)}(${columns.map(ident).join(",")}) VALUES(${columns.map(c => quote(row[c])).join(",")});`);
  }
  for (const s of schemas.filter(s => s.type !== "table")) parts.push(s.sql + ";");
  return parts.join("\n") + "\n";
}

test("A04 authenticated backup restore: boundary, import14950, zero32/38, uncorrected35 and audit survive D1 reimport/replay", async () => {
  const source = await openRuntime(); const recovered = await openRuntime(false, false);
  const directory = await mkdtemp(join(tmpdir(), "a04-boundary-restore-"));
  const previousKey = process.env.BACKUP_KEY_BASE64;
  process.env.BACKUP_KEY_BASE64 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  try {
    const db = source.db;
    await initialize(db, config); await installBoundary(db, 1); await importContribution(db, config, openingImport);
    for (const [id, amount] of [[32, 500], [35, 5000], [38, 2700]] as const) {
      await ingest(db, config, boundaryEvent(id, amount));
      if (id !== 35) await adjust(db, config, { ...openingImport, key: `prior-zero:${id}`, messageId: id, amount: 0 });
    }
    await installBoundary(db, 41, openingImport.originalDate + 1);
    const before = async (d: D1Database, table: string) => (await d.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
    const saved = Object.fromEntries(await Promise.all(["contributions", "event_log", "admin_adjustments", "automatic_intake_boundaries"].map(async t => [t, await before(db, t)])));
    const archive = join(directory, "fixture.mantra"), output = join(directory, "restored.sqlite"), sqlOutput = join(directory, "recovered.sql");
    await packBackup(await exportFixture(db), "A04 synthetic D1 snapshot", new Date().toISOString(), archive);
    const receipt = await restoreBackup(archive, output, sqlOutput);
    expect(receipt.reportsPaused).toBe(true);
    const sqlite = new Database(output, { readonly: true });
    try {
      expect(sqlite.query("SELECT SUM(effective_amount) total FROM contributions").get()).toEqual({ total: 19950 });
      expect(sqlite.query("SELECT message_id,override_amount FROM contributions WHERE message_id IN (32,38) ORDER BY message_id").all())
        .toEqual([{ message_id: 32, override_amount: 0 }, { message_id: 38, override_amount: 0 }]);
    } finally { sqlite.close(); }
    await executeSql(recovered.db, await Bun.file(sqlOutput).text());
    for (const table of Object.keys(saved)) expect(await before(recovered.db, table)).toEqual(saved[table]!);
    await initialize(recovered.db, config);
    await importContribution(recovered.db, config, openingImport);
    for (const id of [32, 35, 38]) for (const revision of [3, 2, 3, 0, 4]) await ingest(recovered.db, config, boundaryEvent(id, id === 35 ? 5000 : 999, revision));
    expect((await totals(recovered.db, config.campaignId)).total).toBe("19950");
    for (const id of [24, 30]) expect((await ingest(recovered.db, config, boundaryEvent(id, 108, 86400))).outcome).toBe("REJECTED");
    expect(await recovered.db.prepare("SELECT COUNT(*) n FROM admin_adjustments WHERE action='IMPORT'").first("n")).toBe(1);
    expect((await runReports(recovered.db, config, "unused", incidentNow, async () => { throw Error("unexpected send"); })).paused).toBe(true);
    await recovered.db.prepare("DELETE FROM automatic_intake_boundaries").run();
    await initialize(recovered.db, config);
    expect(await recovered.db.prepare("SELECT COUNT(*) n FROM automatic_intake_boundaries").first("n")).toBe(0);
    await expect(ingest(recovered.db, config, boundaryEvent(1001, 108))).rejects.toThrow("not provisioned");
  } finally {
    if (previousKey === undefined) delete process.env.BACKUP_KEY_BASE64; else process.env.BACKUP_KEY_BASE64 = previousKey;
    await Promise.all([source.close(), recovered.close()]); await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
