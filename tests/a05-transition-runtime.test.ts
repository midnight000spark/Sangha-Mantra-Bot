import { afterAll, beforeAll, expect, test } from "bun:test";
import { Glob } from "bun";
import { Miniflare, Response as RuntimeResponse } from "miniflare";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { initializeTestDb, seedIdentity, testConfig as config } from "./db";
import { ingest, adjust } from "../src/core";
import { enqueueNotice } from "../src/admin";
import { setSilence } from "../src/controls";

const legacySha = "b7cc125a47c4b791cdafefcd22dbc1859a8f126f";
let candidate: string, legacy: string, directory: string;
const date = Math.floor(Date.now() / 1000) - 120;
const now = date * 1000;
async function git(args: string[]) {
  const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (code) throw Error(err); return out;
}
async function bundle(entry: string) {
  const build = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
  if (!build.success) throw Error(String(build.logs));
  return build.outputs[0]!.text();
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "a05-runtime-"));
  candidate = await bundle("tests/notice-source-worker.ts");
  for (const file of (await git(["ls-tree", "-r", "--name-only", legacySha, "src"])).trim().split("\n")) {
    const dest = join(directory, file); await mkdir(dirname(dest), { recursive: true });
    await Bun.write(dest, await git(["show", `${legacySha}:${file}`]));
  }
  await Bun.write(join(directory, "wrapper.ts"), (await Bun.file("tests/notice-source-worker.ts").text())
    .replaceAll('"../src/', '"./src/'));
  legacy = await bundle(join(directory, "wrapper.ts"));
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const bindings = { DEPLOYMENT_ENV: "test", EXPECTED_D1_ID: "11111111-1111-1111-1111-111111111111",
  EXPECTED_BOT_ID: "123456", BOT_TOKEN: "123456:local-token", WEBHOOK_SECRET: "runtime-secret-1234567890",
  CAMPAIGN_ID: config.campaignId, TIMEZONE: config.timezone, CAMPAIGN_START: config.startDay,
  REPORT_TIME: config.reportTime, GOAL: "1000000", MAX_AMOUNT: "1000000",
  ALLOWED_CHAT_IDS: "-1001,-1002", REPORT_CHAT_ID: "-1001" };
async function open(persist?: string) {
  const sends: { worker: string; chat_id: number; text: string }[] = [];
  const runtime = new Miniflare({ d1Persist: persist, workers: ["legacy", "candidate", "fallback", "drain"].map(name => ({
    name, modules: true, script: name === "legacy" ? legacy : name === "drain"
      ? "export default {async fetch(request){await request.arrayBuffer();return new Response('Maintenance',{status:503})},async scheduled(event,env,ctx){await env.DB.prepare('SELECT 1').first();}}" : candidate,
    d1Databases: { DB: "a05-shared-transition" },
    bindings: { ...bindings, ADMIN_IDS: name === "legacy" ? "42" : "43" },
    outboundService: async (request: unknown) => {
      const body = await (request as Request).json() as { chat_id: number; text: string };
      sends.push({ worker: name, ...body });
      return new RuntimeResponse(JSON.stringify({ ok: true, result: { message_id: sends.length + 100 } }),
        { headers: { "Content-Type": "application/json" } });
    },
  })) });
  const db = await runtime.getD1Database("DB", "candidate") as unknown as D1Database;
  const webhook = async (worker: string, value: unknown) => {
    const response = await (await runtime.getWorker(worker)).fetch("https://local.invalid/webhook", {
      method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": bindings.WEBHOOK_SECRET }, body: JSON.stringify(value) });
    await response.text(); // Release the workerd response before a scheduled service call.
    return response;
  };
  const cron = async (worker: string) => expect((await (await runtime.getWorker(worker)).scheduled()).outcome).toBe("ok");
  return { db, runtime, sends, webhook, cron };
}
async function statements(sql: string) {
  const out: string[] = []; let pending = "";
  for (const line of sql.split(/\r?\n/)) {
    pending += line + "\n";
    const trigger = /^\s*CREATE TRIGGER/i.test(pending.trim());
    if ((trigger && /^END;\s*$/.test(line)) || (!trigger && /;\s*$/.test(line))) { out.push(pending.trim()); pending = ""; }
  }
  if (pending.trim()) throw Error("Unconsumed SQL"); return out;
}
async function migrate(db: D1Database, through = "9999") {
  for (const file of Array.from(new Glob("*.sql").scanSync("migrations")).sort().filter(f => f <= through)) {
    await db.batch((await statements(await Bun.file(`migrations/${file}`).text())).map(sql => db.prepare(sql)));
  }
}
async function seed(db: D1Database) {
  await seedIdentity(db); await initializeTestDb(db, config);
  await db.prepare("INSERT INTO recovery_state(campaign_id,restored_at,backup_at,reason) VALUES('test',1,1,'Synthetic publication pause')").run();
}
const message = (id: number, text: string, version = date) => ({ update_id: id, message: {
  message_id: id, date: version, from: { id: 77, is_bot: false }, chat: { id: -1001, type: "supergroup" }, text,
} });
const admin = (id: number, text: string, actor = 43, sent = date) => ({ update_id: 10000 + id, message: {
  message_id: id, date: sent, from: { id: actor, is_bot: false }, chat: { id: actor, type: "private" }, text,
} });
const row = (db: D1Database, key: string) => db.prepare("SELECT state,publication_hold,source_event_key,claim_token,sent_message_id FROM notices WHERE notice_key=?").bind(key).first<any>();

test("A05 actual pre-F03/F04/F05 Worker bypasses new invariants: mixed writers are forbidden", async () => {
  const r = await open(); const { db } = r;
  try {
    await migrate(db); await seed(db);
    expect((await r.webhook("candidate", admin(1, "/silent on", 43, date + 10))).status).toBe(200);
    expect((await r.webhook("legacy", admin(2, "/silent off", 42, date))).status).toBe(200);
    expect(await db.prepare("SELECT silent FROM campaign_controls").first("silent")).toBe(0);
    expect(await db.prepare("SELECT silent FROM campaign_silent_watermarks WHERE actor_id=43").first("silent")).toBe(1);
    await enqueueNotice(db, config, "admin:revoked-legacy", 42, "Synthetic revoked target", now);
    await enqueueNotice(db, config, "rejected:unbound-legacy", -1001, "Synthetic unbound warning", now, 90, Date.now() + 1000);
    await r.cron("legacy"); await r.cron("legacy");
    expect(r.sends.some(s => s.text === "Synthetic revoked target" && s.worker === "legacy")).toBe(true);
    expect(r.sends.some(s => s.text === "Synthetic unbound warning" && s.worker === "legacy")).toBe(true);
    // Re-upgrade alone cannot repair controls/watermark divergence. A fresh ON is mandatory.
    expect((await r.webhook("candidate", admin(3, "/silent on", 43, date + 11))).status).toBe(200);
    expect(await db.prepare("SELECT silent FROM campaign_controls").first("silent")).toBe(1);
    expect(await db.prepare("SELECT command_at FROM campaign_silent_watermarks WHERE actor_id=43").first("command_at")).toBe((date + 11) * 1000);
  } finally { await r.runtime.dispose(); }
}, 30_000);

test("A05 combined F03/F04/F05: silent holds, stale edit/zero/legacy triage and concurrent Cron", async () => {
  const r = await open(); const { db } = r;
  try {
    await migrate(db); await seed(db);
    const cfg = { ...config, adminIds: [43] };
    await setSilence(db, cfg, true, 43, "a05:on", now, { sentAt: now, chatId: 43, messageId: 1 });
    for (const id of [10, 11, 12]) {
      await ingest(db, config, { key: `invalid:${id}`, updateId: id, chatId: -1001, messageId: id, userId: 77,
        originalDate: date, versionDate: date, isEdit: false, state: "INVALID", amount: 0, reason: "Synthetic", now });
      await enqueueNotice(db, config, `rejected:${id}`, -1001, `Synthetic warning ${id}`, now, id, now, `invalid:${id}`);
    }
    await ingest(db, config, { key: "valid:10", updateId: 100, chatId: -1001, messageId: 10, userId: 77,
      originalDate: date, versionDate: date + 1, isEdit: true, state: "VALID", amount: 108, reason: null, now });
    await adjust(db, config, { key: "zero:11", actorId: 42, chatId: -1001, messageId: 11, amount: 0, reason: "Synthetic zero", now });
    for (const state of ["PENDING", "SENDING", "UNCERTAIN", "FAILED_KNOWN", "SENT"]) {
      await db.prepare("INSERT INTO notices(notice_key,campaign_id,chat_id,reply_message_id,body,state,created_at,claimed_at,publication_hold) VALUES(?,'test',-1001,99,'Synthetic legacy',?,?,?,?)")
        .bind(`rejected:legacy-${state}`, state, now, state === "SENDING" ? now - 600000 : null, state === "PENDING" ? 1 : 0).run();
    }
    for (const prefix of ["admin", "ui", "alert"]) await enqueueNotice(db, config, `${prefix}:revoked`, 42, "Synthetic denied", now);
    await Promise.all([r.cron("candidate"), r.cron("fallback")]); await r.cron("candidate");
    expect(r.sends.filter(s => s.chat_id < 0)).toEqual([]);
    for (const prefix of ["admin", "ui", "alert"]) expect((await row(db, `${prefix}:revoked`)).state).toBe("FAILED_KNOWN");
    expect((await row(db, "rejected:legacy-SENDING")).state).toBe("UNCERTAIN");
    expect((await row(db, "rejected:legacy-PENDING")).state).toBe("PENDING");
    await setSilence(db, cfg, false, 43, "a05:off", now + 2000, { sentAt: now + 2000, chatId: 43, messageId: 2 });
    // A delayed OFF from before ON cannot release anything.
    await setSilence(db, cfg, false, 43, "a05:stale-off", now + 3000, { sentAt: now - 1000, chatId: 43, messageId: 3 });
    await r.cron("candidate"); expect(r.sends.filter(s => s.chat_id < 0)).toEqual([]);
    for (const [i, key] of ["rejected:10", "rejected:11", "rejected:12", "rejected:legacy-PENDING"].entries()) {
      // Exercise the actual operator release command; it cannot waive F05.
      expect((await r.webhook("candidate", admin(50 + i, `/notice_retry ${key} Synthetic triage`, 43, date + 5))).status).toBe(200);
    }
    await Promise.all([r.cron("candidate"), r.cron("fallback")]); await r.cron("candidate");
    for (const key of ["rejected:10", "rejected:11", "rejected:legacy-PENDING"]) {
      expect((await row(db, key)).state).toBe("FAILED_KNOWN");
      expect((await row(db, key)).claim_token).toBeNull();
      expect((await row(db, key)).sent_message_id).toBeNull();
    }
    expect((await row(db, "rejected:12")).state).toBe("SENT");
    expect(r.sends.filter(s => s.chat_id < 0).map(s => s.text)).toEqual(["Synthetic warning 12"]);
    for (let n = 0; n < 4; n++) await r.cron("fallback");
    expect(r.sends.filter(s => s.chat_id < 0)).toHaveLength(1);
    for (const state of ["SENDING", "UNCERTAIN"]) expect((await row(db, `rejected:legacy-${state}`)).state).toBe("UNCERTAIN");
    expect((await row(db, "rejected:legacy-FAILED_KNOWN")).state).toBe("FAILED_KNOWN");
    expect((await row(db, "rejected:legacy-SENT")).state).toBe("SENT");
    expect(await db.prepare("SELECT COUNT(*) n FROM operational_events WHERE kind='NOTICE_SOURCE_STALE'").first("n")).toBe(3);
  } finally { await r.runtime.dispose(); }
}, 30_000);

test("A05 migration0009 precedes activation: missing column gives503, retry after migration counts once", async () => {
  const r = await open(); const { db } = r;
  try {
    await migrate(db, "0008_silent_command_order.sql"); await seed(db);
    const update = message(80, "-5");
    expect((await r.webhook("candidate", update)).status).toBe(503);
    expect(await db.prepare("SELECT COUNT(*) n FROM contributions").first("n")).toBe(1);
    await db.prepare(await Bun.file("migrations/0009_notice_source_revision.sql").text()).run();
    expect((await r.webhook("candidate", update)).status).toBe(200);
    expect((await r.webhook("candidate", update)).status).toBe(200);
    expect(await db.prepare("SELECT COUNT(*) n FROM contributions").first("n")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) n FROM event_log").first("n")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) n FROM notices WHERE state='SENT' AND source_event_key IS NOT NULL").first("n")).toBe(1);
    expect(r.sends.filter(s => s.chat_id < 0)).toHaveLength(1);
  } finally { await r.runtime.dispose(); }
}, 30_000);

test("A05 coordinated drain, SQL fault, webhook retry, restart and compatible frozen fallback preserve D1", async () => {
  const persist = join(directory, "persistent-d1");
  let r = await open(persist);
  let phase = "migrate/seed";
  try {
    await migrate(r.db); await seed(r.db);
    // Upstream retains an update because the drain worker returns503 and writes nothing.
    const update = message(101, "108");
    phase = "drain";
    await r.cron("drain"); expect((await r.webhook("drain", update)).status).toBe(503);
    expect(await r.db.prepare("SELECT COUNT(*) n FROM contributions").first("n")).toBe(0);
    // Failure inside production ingestion batch must not leave event/contribution partials.
    phase = "fault/retry";
    await r.db.prepare("CREATE TRIGGER fault BEFORE INSERT ON contributions BEGIN SELECT RAISE(ABORT,'A05 injected ingestion fault'); END").run();
    expect((await r.webhook("candidate", update)).status).toBe(503);
    expect(await r.db.prepare("SELECT COUNT(*) n FROM event_log").first("n")).toBe(0);
    await r.db.prepare("DROP TRIGGER fault").run();
    await r.db.prepare("CREATE TRIGGER ack_fault BEFORE INSERT ON system_heartbeat BEGIN SELECT RAISE(ABORT,'A05 post-commit pre-ack fault'); END").run();
    expect((await r.webhook("candidate", update)).status).toBe(503);
    expect(await r.db.prepare("SELECT COUNT(*) n FROM event_log").first("n")).toBe(1);
    expect(await r.db.prepare("SELECT SUM(effective_amount) n FROM contributions").first("n")).toBe(108);
    await r.db.prepare("DROP TRIGGER ack_fault").run();
    expect((await r.webhook("candidate", update)).status).toBe(200);
    await r.webhook("candidate", admin(10, "/silent on", 43, date + 10));
    await enqueueNotice(r.db, config, "rejected:restart-held", -1001, "Synthetic held", now, 102);
    await r.db.prepare("INSERT INTO notices(notice_key,campaign_id,chat_id,body,state,created_at,claimed_at,claim_token) VALUES('admin:crashed','test',43,'Synthetic crashed','SENDING',1,1,'lost-claim')").run();
    const saved = (await r.db.prepare("SELECT * FROM contributions").all()).results;
    const held = await row(r.db, "rejected:restart-held");
    phase = "restart";
    await r.runtime.dispose(); r = await open(persist);
    expect((await r.db.prepare("SELECT * FROM contributions").all()).results).toEqual(saved);
    expect(await row(r.db, "rejected:restart-held")).toEqual(held);
    phase = "fallback";
    expect((await r.webhook("fallback", update)).status).toBe(200);
    await Promise.all([r.cron("fallback"), r.cron("candidate")]);
    expect((await row(r.db, "admin:crashed")).state).toBe("UNCERTAIN");
    expect((await row(r.db, "rejected:restart-held")).publication_hold).toBe(1);
    expect(r.sends.some(s => s.chat_id < 0)).toBe(false);
    expect(await r.db.prepare("SELECT SUM(effective_amount) n FROM contributions").first("n")).toBe(108);
    expect(await r.db.prepare("SELECT COUNT(*) n FROM event_log").first("n")).toBe(1);
    expect(await r.db.prepare("SELECT silent FROM campaign_controls").first("silent")).toBe(1);
  } catch (error) { throw new Error(`A05 transition phase ${phase}`, { cause: error }); }
  finally { await r.runtime.dispose(); }
}, 30_000);
