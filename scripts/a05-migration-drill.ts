import assert from "node:assert/strict";
import { mkdtemp, readdir, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packBackup } from "./backup";
import { restoreBackup } from "./restore";

// Disposable synthetic databases only. Every Wrangler database command is --local.
// Logs and semantic hashes persist; plaintext databases and random keys do not.
const evidence = resolve("test-results/a05/migrations");
await mkdir(evidence, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "a05-migrations-"));
const previousKey = process.env.BACKUP_KEY_BASE64;
process.env.BACKUP_KEY_BASE64 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const files = (await readdir("migrations")).filter(n => n.endsWith(".sql")).sort();
let sequence = 0;
async function target(name: string) {
  const dir = join(root, name);
  await mkdir(join(dir, "migrations"), { recursive: true });
  const config = join(dir, "wrangler.json");
  await Bun.write(config, JSON.stringify({ name: `a05-${name}`, compatibility_date: "2026-07-01",
    d1_databases: [{ binding: "DB", database_name: `a05-${name}`,
      database_id: "00000000-0000-4000-8000-000000000005", migrations_dir: "migrations" }] }));
  return { dir, config };
}
type Target = Awaited<ReturnType<typeof target>>;
async function cli(t: Target, args: string[], failure = false) {
  const argv = [process.execPath, resolve("node_modules/wrangler/bin/wrangler.js"), "d1", ...args,
    "--local", "--config", t.config];
  const processChild = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe",
    cwd: t.dir, env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" } });
  const [code, stdout, stderr] = await Promise.all([processChild.exited,
    new Response(processChild.stdout).text(), new Response(processChild.stderr).text()]);
  await Bun.write(join(evidence, `${String(++sequence).padStart(3, "0")}-${args[0]}.log`),
    JSON.stringify({ argv, exitCode: code }) + "\n" + stdout + "\n" + stderr);
  assert.equal(code === 0, !failure, `Unexpected Wrangler exit ${code}: ${stderr.slice(-700)}`);
  return stdout;
}
async function queries(t: Target, sql: string): Promise<Record<string, unknown>[][]> {
  const out = JSON.parse(await cli(t, ["execute", "DB", "--command", sql, "--json"]));
  return out.map((r: { results: Record<string, unknown>[] }) => r.results);
}
async function query(t: Target, sql: string) { return (await queries(t, sql)).flat(); }
async function apply(t: Target) { await cli(t, ["migrations", "apply", "DB"]); }
async function install(t: Target, n: number, fault = false) {
  const file = files[n - 1]!;
  await Bun.write(join(t.dir, "migrations", file), await Bun.file(`migrations/${file}`).text()
    + (fault ? "\nSELECT * FROM a05_injected_failure;\n" : ""));
}
const sha = (x: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(x)).digest("hex");
const quote = (x: string) => '"' + x.replaceAll('"', '""') + '"';
async function capture(t: Target) {
  const tables = (await query(t, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name<>'d1_migrations' ORDER BY name"))
    .map(r => String(r.name));
  const result: Record<string, { columns: string[]; rows: Record<string, unknown>[] }> = {};
  const schemas = await queries(t, tables.map(name => `PRAGMA table_xinfo(${quote(name)});`).join("\n"));
  const rows = await queries(t, tables.map(name => `SELECT * FROM ${quote(name)} ORDER BY rowid;`).join("\n"));
  for (const [i, name] of tables.entries()) result[name] = { columns: schemas[i]!.map(r => String(r.name)), rows: rows[i]! };
  return result;
}
function preserve(before: Awaited<ReturnType<typeof capture>>, after: Awaited<ReturnType<typeof capture>>) {
  for (const [name, saved] of Object.entries(before)) {
    assert.deepEqual(after[name]!.rows.map(row => Object.fromEntries(saved.columns.map(c => [c, row[c]]))), saved.rows,
      `Old columns changed in ${name}`);
  }
}

const fixture = `
INSERT INTO campaigns VALUES('test','Europe/Moscow','2026-11-01',1000000,-1001,NULL);
INSERT INTO chat_aliases VALUES(-1001,'test');
INSERT INTO deployment_identity VALUES(1,'test','11111111-1111-1111-1111-111111111111','test',123456,'-1001',-1001);
INSERT INTO contributions(source_chat_id,message_id,campaign_id,original_date,local_day,user_id,source_amount,source_state,version_date,is_edit,override_amount,last_event_key,updated_at)
VALUES(-1001,32,'test',1794300000,'2026-11-10',77,500,'VALID',1794300000,0,0,'fixture32',1794300000000),
(-1001,35,'test',1794300000,'2026-11-10',77,5000,'VALID',1794300000,0,NULL,'fixture35',1794300000000),
(-1001,38,'test',1794300000,'2026-11-10',77,2700,'VALID',1794300000,0,0,'fixture38',1794300000000);
INSERT INTO event_log(event_key,nonce,update_id,source_chat_id,message_id,campaign_id,original_date,local_day,user_id,version_date,is_edit,source_amount,source_state,outcome,old_amount,new_amount,received_at)
SELECT last_event_key,last_event_key,message_id,source_chat_id,message_id,campaign_id,original_date,local_day,user_id,version_date,is_edit,source_amount,source_state,'APPLIED',0,source_amount,updated_at FROM contributions;
INSERT INTO admin_adjustments SELECT 'zero:'||message_id,'fixture',42,source_chat_id,message_id,'OVERRIDE',0,source_amount,0,'Synthetic prior zero',updated_at FROM contributions WHERE message_id IN (32,38);
INSERT INTO daily_reports(campaign_id,day,timezone,period_start,period_end,snapshot_at,day_total,total,correction,goal,target_chat_id,status,telegram_message_id,body,updated_at)
VALUES('test','2026-11-10','Europe/Moscow',1794258000,1794344400,1794344700000,26500,63550,5000,1000000,-1001,'SENT',999,'Synthetic immutable report35',1794344700000),
('test','2026-11-09','Europe/Moscow',1794171600,1794258000,1794258300000,0,32050,0,1000000,-1001,'PENDING',NULL,'Synthetic queued report',1794258300000);
INSERT INTO notices(notice_key,campaign_id,chat_id,body,state,created_at,claim_token,claimed_at,sent_message_id)
VALUES('rejected:legacy-pending','test',-1001,'Synthetic warning','PENDING',1,NULL,NULL,NULL),
('rejected:legacy-sending','test',-1001,'Synthetic claimed','SENDING',2,'legacy-claim',3,NULL),
('rejected:legacy-uncertain','test',-1001,'Synthetic uncertain','UNCERTAIN',4,NULL,NULL,NULL),
('rejected:legacy-failed','test',-1001,'Synthetic failed','FAILED_KNOWN',5,NULL,NULL,NULL),
('rejected:legacy-sent','test',-1001,'Synthetic sent','SENT',6,NULL,NULL,998);
`;

try {
  const fresh = await target("fresh");
  for (let n = 1; n <= 9; n++) await install(fresh, n);
  await apply(fresh);
  assert.equal((await query(fresh, "SELECT * FROM d1_migrations")).length, 9);
  assert.deepEqual(await query(fresh, "SELECT * FROM automatic_intake_boundaries"), []);

  const old = await target("old6");
  for (let n = 1; n <= 6; n++) await install(old, n);
  await apply(old);
  const fixturePath = join(root, "fixture.sql"); await Bun.write(fixturePath, fixture);
  await cli(old, ["execute", "DB", "--file", fixturePath]);
  const original = await capture(old);
  const exported = join(root, "old6.sql");
  await cli(old, ["export", "DB", "--output", exported]);
  const archive = join(root, "old6.mantra"), recoveredSql = join(root, "recovered.sql");
  const backup = await packBackup(await Bun.file(exported).text(), "A05 synthetic schema0006 D1", new Date().toISOString(), archive);
  const restored = await restoreBackup(archive, join(root, "restored.sqlite"), recoveredSql);
  assert.equal(restored.reportsPaused, true);
  const copy = await target("restored6");
  await cli(copy, ["execute", "DB", "--file", recoveredSql]);
  const before = await capture(copy);
  for (const name of ["contributions", "event_log", "admin_adjustments"]) assert.deepEqual(before[name], original[name]);
  assert.deepEqual(before.notices!.rows.map(r => r.state), ["UNCERTAIN", "UNCERTAIN", "UNCERTAIN", "UNCERTAIN", "SENT"]);
  assert.equal(before.daily_reports!.rows[0]!.total, 63550);
  assert.equal(before.daily_reports!.rows[0]!.status, "SENT");
  assert.equal(before.daily_reports!.rows[1]!.status, "UNCERTAIN");
  assert.equal(before.report_audit!.rows.length, original.report_audit!.rows.length + 1);
  const receipts: unknown[] = [];
  for (let n = 7; n <= 9; n++) {
    const pre = await capture(copy);
    const schema = await query(copy, "SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name");
    await install(copy, n, true);
    await cli(copy, ["migrations", "apply", "DB"], true);
    assert.deepEqual(await query(copy, "SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name"), schema,
      `Failed migration ${n} must roll back its DDL`);
    assert.deepEqual(await capture(copy), pre, `Failed migration ${n} must roll back data`);
    assert.equal((await query(copy, "SELECT * FROM d1_migrations")).length, n - 1);
    await install(copy, n); await apply(copy);
    const after = await capture(copy); preserve(pre, after);
    assert.equal((await query(copy, "SELECT * FROM d1_migrations")).length, n);
    receipts.push({ migration: files[n - 1], allOldColumnsPreserved: true, faultRolledBack: true,
      beforeSha256: sha(pre), afterSha256: sha(after) });
  }
  assert.deepEqual(await query(copy, "SELECT override_amount,effective_amount FROM contributions WHERE message_id IN (32,38)"),
    [{ override_amount: 0, effective_amount: 0 }, { override_amount: 0, effective_amount: 0 }]);
  assert.deepEqual(await query(copy, "SELECT SUM(effective_amount) total FROM contributions"), [{ total: 5000 }]);
  assert.deepEqual(await query(copy, "SELECT * FROM automatic_intake_boundaries"), []);
  assert.deepEqual(await query(copy, "SELECT source_event_key FROM notices"), Array(5).fill({ source_event_key: null }));
  const fk = await query(copy, "PRAGMA foreign_key_check"); assert.deepEqual(fk, []);
  // 0008 reads 0007's table. A failed out-of-order batch is atomic too.
  await install(old, 8);
  await cli(old, ["migrations", "apply", "DB"], true);
  assert.deepEqual(await capture(old), original);
  assert.equal((await query(old, "SELECT * FROM d1_migrations")).length, 6);
  const result = { result: "PASS", scope: "LOCAL_SYNTHETIC_WRANGLER_D1_WORKERD", freshMigrations: files,
    restoredFromSchema: "0006", authenticatedArchiveVerified: true, backupSqlSha256: backup.sqlSha256,
    originalLedgerSha256: sha(Object.fromEntries(["contributions", "event_log", "admin_adjustments"].map(k => [k, original[k]]))),
    restoredLedgerSha256: sha(Object.fromEntries(["contributions", "event_log", "admin_adjustments"].map(k => [k, before[k]]))),
    transitions: receipts, zero32and38: true, uncorrected35: 5000, syntheticCurrentTotal: 5000,
    immutableSyntheticReport35: 63550, queuesPreservedWithRecoveryQuarantine: true,
    noBoundaryInvented: true, outOfOrder0008Rejected: true, foreignKeyCheck: fk,
    providerPITR: "NOT_RUN", productionAccess: false };
  await Bun.write(join(evidence, "receipt.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (previousKey === undefined) delete process.env.BACKUP_KEY_BASE64; else process.env.BACKUP_KEY_BASE64 = previousKey;
  await rm(root, { recursive: true, force: true });
}
