import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packBackup, readBackup } from "./backup";
import { restoreBackup } from "./restore";

const directory = await mkdtemp(join(tmpdir(), "mantra-backup-drill-"));
const config = join(directory, "wrangler.json");
const sourceSql = join(directory, "source.sql");
const dump = join(directory, "export.sql");
const archive = join(directory, "backup.mantra");
const restored = join(directory, "restored.sqlite");
const previousKey = process.env.BACKUP_KEY_BASE64;
process.env.BACKUP_KEY_BASE64 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

async function wrangler(args: string[]) {
  const child = Bun.spawn([process.execPath, resolve("node_modules/wrangler/bin/wrangler.js"), ...args, "--config", config], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`Local Wrangler failed (${args[1]}): ${stdout}\n${stderr}`);
}

try {
  await Bun.write(config, JSON.stringify({ name: "mantra-backup-drill", compatibility_date: "2026-11-11",
    d1_databases: [{ binding: "DB", database_name: "mantra-backup-drill", database_id: "00000000-0000-0000-0000-000000000001" }] }));
  const migrationNames = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
  const migrations = await Promise.all(migrationNames.map((name) => Bun.file(join("migrations", name)).text()));
  await Bun.write(sourceSql, migrations.join("\n") + `
INSERT INTO campaigns(id,timezone,start_day,goal,report_chat_id) VALUES('drill','Europe/Moscow','2026-11-01',1000000,-100123);
INSERT INTO chat_aliases(chat_id,campaign_id) VALUES(-100123,'drill');
INSERT INTO contributions(source_chat_id,message_id,campaign_id,original_date,local_day,user_id,source_amount,source_state,version_date,is_edit,last_event_key,updated_at)
VALUES(-100123,1,'drill',1794300000,'2026-11-10',42,1000,'VALID',1794300000,0,'drill-1',1794300000000),
      (-100123,2,'drill',1794300001,'2026-11-10',42,2000,'VALID',1794300001,0,'drill-2',1794300001000),
      (-100123,3,'drill',1794300002,'2026-11-10',43,108,'VALID',1794300002,0,'drill-3',1794300002000);
INSERT INTO event_log(event_key,nonce,update_id,source_chat_id,message_id,campaign_id,original_date,local_day,user_id,version_date,is_edit,source_amount,source_state,outcome,old_amount,new_amount,received_at)
SELECT last_event_key,last_event_key,message_id,source_chat_id,message_id,campaign_id,original_date,local_day,user_id,version_date,is_edit,source_amount,source_state,'APPLIED',0,effective_amount,updated_at FROM contributions;
INSERT INTO daily_reports(campaign_id,day,timezone,period_start,period_end,snapshot_at,day_total,total,correction,goal,target_chat_id,status,updated_at)
VALUES('drill','2026-11-10','Europe/Moscow',1794258000,1794344400,1794344700000,3108,3108,0,1000000,-100123,'PENDING',1794344700000);
INSERT INTO daily_reports(campaign_id,day,timezone,period_start,period_end,snapshot_at,day_total,total,correction,goal,target_chat_id,status,retry_after,updated_at)
VALUES('drill','2026-11-09','Europe/Moscow',1794171600,1794258000,1794258300000,0,0,0,1000000,-100123,'FAILED_KNOWN',1794258360000,1794258300000);
INSERT INTO notices(notice_key,campaign_id,chat_id,body,state,created_at) VALUES('drill-notice','drill',42,'Test notice','FAILED_KNOWN',1794258300000);
`);
  await wrangler(["d1", "execute", "DB", "--local", "--file", sourceSql]);
  await wrangler(["d1", "export", "DB", "--local", "--output", dump]);
  const startedAt = new Date(Date.now() - 3_600_000).toISOString();
  const summary = await packBackup(await Bun.file(dump).text(), "local-wrangler-d1", startedAt, archive);
  assert.deepEqual(summary.summary.totals, [{ campaign_id: "drill", total: "3108" }]);
  assert.equal(summary.summary.counts.contributions, 3);
  assert.equal(summary.summary.counts.event_log, 3);
  assert.equal(summary.summary.counts.report_audit, 2);
  const evidence = await restoreBackup(archive, restored, join(directory, "recovered.sql"));
  assert.equal(evidence.reportsPaused, true);
  assert.equal(evidence.possibleLossWindow.from, startedAt);
  const database = new Database(restored, { readonly: true });
  assert.deepEqual(database.query("SELECT SUM(effective_amount) AS total FROM contributions").get(), { total: 3108 });
  assert.deepEqual(database.query("SELECT reconciled_at FROM recovery_state").get(), { reconciled_at: null });
  assert.deepEqual(database.query("SELECT DISTINCT status FROM daily_reports").all(), [{ status: "UNCERTAIN" }]);
  assert.deepEqual(database.query("SELECT state FROM notices").get(), { state: "UNCERTAIN" });
  assert.deepEqual(database.query("SELECT COUNT(*) AS count FROM report_audit").get(), { count: 4 });
  database.close();
  // Verify that the production SQL recovery output includes the persisted pause too.
  const reimported = new Database(":memory:");
  reimported.exec(await Bun.file(join(directory, "recovered.sql")).text());
  assert.deepEqual(reimported.query("SELECT SUM(effective_amount) AS total FROM contributions").get(), { total: 3108 });
  assert.deepEqual(reimported.query("SELECT reconciled_at FROM recovery_state").get(), { reconciled_at: null });
  reimported.close();
  const envelope = await Bun.file(archive).json();
  const bytes = Buffer.from(envelope.ciphertext, "base64");
  bytes[0] = bytes[0]! ^ 1;
  await Bun.write(join(directory, "tampered.mantra"), JSON.stringify({ ...envelope, ciphertext: bytes.toString("base64") }));
  await assert.rejects(readBackup(join(directory, "tampered.mantra")));
  process.env.BACKUP_KEY_BASE64 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  await assert.rejects(readBackup(archive));
  console.log(JSON.stringify({ result: "PASS", scope: "Local Wrangler D1 export, AES-GCM archive, separate SQLite restore",
    contributions: 3, eventLogEntries: 3, total: "3108", generatedColumnVerified: true,
    reportTriggersVerified: true, recoveryPauseVerified: true, lossWindowVerified: true,
    sqlReimportVerified: true, tamperingRejected: true, wrongKeyRejected: true,
    remoteCloudflareTested: false, offAccountStorageTested: false }, null, 2));
} finally {
  if (previousKey === undefined) delete process.env.BACKUP_KEY_BASE64;
  else process.env.BACKUP_KEY_BASE64 = previousKey;
  // The path came directly from mkdtemp and contains only this drill's data.
  await rm(directory, { recursive: true, force: true });
}
