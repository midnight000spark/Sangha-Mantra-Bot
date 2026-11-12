import { Database } from "bun:sqlite";
import { inspectDatabase, readBackup } from "./backup";

export async function restoreBackup(archive: string, output: string, sqlOutput?: string) {
  for (const path of [output, `${output}.restoration.json`, sqlOutput].filter(Boolean) as string[]) {
    if (await Bun.file(path).exists()) throw new Error(`Refusing to overwrite an existing restore output: ${path}`);
  }
  const manifest = await readBackup(archive);
  const database = new Database(output, { create: true });
  database.exec(manifest.sql);
  const actual = inspectDatabase(database);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.summary)) {
    database.close();
    throw new Error("Restored row counts/totals do not match the authenticated backup manifest");
  }
  const restoredAt = Date.now();
  // Export start is a conservative lower bound: export may block or take time.
  const backupAt = Date.parse(manifest.exportStartedAt);
  const restoreId = crypto.randomUUID();
  const recoverySql = `
INSERT INTO recovery_state(campaign_id,restored_at,backup_at,reconciled_at,reconciled_by,reason)
SELECT id,${restoredAt},${backupAt},NULL,NULL,'Restore from SQL SHA256 ${manifest.sqlSha256}' FROM campaigns WHERE true
ON CONFLICT(campaign_id) DO UPDATE SET
  restored_at=excluded.restored_at,
  backup_at=CASE WHEN recovery_state.reconciled_at IS NULL THEN MIN(recovery_state.backup_at,excluded.backup_at) ELSE excluded.backup_at END,
  reconciled_at=NULL,reconciled_by=NULL,reason=excluded.reason;
INSERT INTO operational_events(event_key,campaign_id,kind,detail,created_at)
SELECT 'restore:${restoreId}:'||id,id,'RESTORE','Authenticated backup ${manifest.sqlSha256}; report publication paused',${restoredAt} FROM campaigns;
UPDATE daily_reports SET status='UNCERTAIN',updated_at=${restoredAt},last_error='Restored from backup: check Telegram before any publication'
WHERE status IN ('PENDING','SENDING','FAILED_KNOWN');
UPDATE notices SET state='UNCERTAIN',last_error='Restored from backup: check Telegram before any publication'
WHERE state IN ('PENDING','SENDING','FAILED_KNOWN');
`;
  database.exec(recoverySql);
  inspectDatabase(database);
  database.close();
  if (sqlOutput) await Bun.write(sqlOutput, `${manifest.sql}\n${recoverySql}`);
  const evidence = {
    restoreId,
    restoredAt: new Date(restoredAt).toISOString(),
    exportStartedAt: manifest.exportStartedAt,
    exportCompletedAt: manifest.exportCompletedAt,
    possibleLossWindow: { from: new Date(backupAt).toISOString(), to: new Date(restoredAt).toISOString() },
    reportsPaused: true,
    reconciliationRequired: true,
    sqlSha256: manifest.sqlSha256,
    verifiedBeforeRecoveryMarker: actual,
    source: manifest.source,
  };
  await Bun.write(`${output}.restoration.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

if (import.meta.main) {
  const [archive, output, sqlFlag, sqlOutput] = Bun.argv.slice(2);
  if (!archive || !output || (sqlFlag !== undefined && (sqlFlag !== "--sql" || !sqlOutput)) || Bun.argv.length > 6) {
    throw new Error("Usage: bun scripts/restore.ts <backup.mantra> <new.sqlite> [--sql <new-recovered.sql>]");
  }
  console.log(JSON.stringify(await restoreBackup(archive, output, sqlOutput), null, 2));
}
