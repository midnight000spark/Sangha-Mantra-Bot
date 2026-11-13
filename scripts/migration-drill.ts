import { Database } from "bun:sqlite";
import { open } from "node:fs/promises";
import { inspectDatabase, readBackup } from "./backup";

/** Local only. Authenticates an encrypted archive, applies 0007 to a NEW copy, compares every old column. */
export async function migrationDrill(archive: string, output: string) {
  process.umask(0o077);
  const backup = await readBackup(archive);
  const handle = await open(output, "wx", 0o600); await handle.close();
  const db = new Database(output);
  try {
    db.exec(backup.sql);
    const before = inspectDatabase(db);
    if (JSON.stringify(before) !== JSON.stringify(backup.summary)) throw new Error("Archive summary mismatch");
    const names = Object.keys(before.counts);
    if (names.includes("campaign_controls")) throw new Error("Archive already contains migration 0007; choose the pre-migration archive");
    const quote = (s:string) => '"' + s.replaceAll('"','""') + '"';
    const columns = new Map(names.map(name => [name, (db.query(`PRAGMA table_xinfo(${quote(name)})`).all() as {name:string}[]).map(r=>r.name)]));
    const hash = (table:string) => new Bun.CryptoHasher("sha256").update(JSON.stringify(
      db.query(`SELECT ${columns.get(table)!.map(quote).join(",")} FROM ${quote(table)} ORDER BY rowid`).all())).digest("hex");
    const hashes = new Map(names.map(name=>[name,hash(name)]));
    db.exec("PRAGMA foreign_keys=ON");
    const sql = await Bun.file("migrations/0007_campaign_controls.sql").text();
    db.transaction(() => db.exec(sql))();
    const after = inspectDatabase(db);
    for (const name of names) if (hashes.get(name) !== hash(name)) throw new Error("Existing data changed during migration");
    for(const table of ["campaign_controls","automatic_intake_boundaries"]) {
      if ((db.query(`SELECT COUNT(*) n FROM ${table}`).get() as {n:number}).n !== 0) throw new Error("Migration must not configure live policy implicitly");
    }
    return {passed:true,localOnly:true,sourceExportStartedAt:backup.exportStartedAt,sourceSqlSha256:backup.sqlSha256,
      existingTablesVerified:names.length,existingRowsAndOverridesUnchanged:true,before,after,
      automaticBoundaryProvisioned:false,silenceEnabled:false};
  } finally { db.close(); }
}
if (import.meta.main) {
  const [archive,output,...extra]=Bun.argv.slice(2);
  if (!archive || !output || extra.length) throw new Error("Use: migration-drill.ts PRIVATE_ARCHIVE NEW_LOCAL_SQLITE");
  migrationDrill(archive,output).then(result=>console.log(JSON.stringify(result))).catch(()=>{
    console.error("Local migration drill failed; private archive/database contents withheld");process.exitCode=1;
  });
}
