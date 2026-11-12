import { Database } from "bun:sqlite";
import { Glob } from "bun";
import type { Config } from "../src/types";

export const testConfig: Config = {
  campaignId: "test", timezone: "Europe/Moscow", startDay: "2026-11-01", reportTime: "00:05",
  goal: 1_000_000, maxAmount: 1_000_000, allowedChatIds: [-1001,-1002], adminIds: [42], reportChatId: -1001,
};

/** Small SQLite adapter for fast SQL invariants. Actual Worker/D1 is checked with Miniflare separately. */
export async function createTestDb(): Promise<D1Database> {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const files = Array.from(new Glob("*.sql").scanSync("migrations")).sort();
  for (const file of files) sqlite.exec(await Bun.file(`migrations/${file}`).text());
  const executions = new WeakMap<D1PreparedStatement, () => unknown>();
  const prepare = (sql: string, values: unknown[] = []): D1PreparedStatement => {
    const execute = () => ({success:true,results:sqlite.query(sql).all(...values as never[]),meta:{changes:(sqlite.query("SELECT changes() n").get() as {n:number}).n}});
    const statement = {
    bind: (...args: unknown[]) => prepare(sql,args),
    first: async (column?: string) => {
      const row = sqlite.query(sql).get(...values as never[]) as Record<string,unknown> | null;
      return column ? row?.[column] ?? null : row;
    },
    all: async () => execute(),
    run: async () => {
      const result = sqlite.query(sql).run(...values as never[]);
      return {success:true,results:[],meta:{changes:result.changes,last_row_id:Number(result.lastInsertRowid)}};
    },
    raw: async () => sqlite.query(sql).values(...values as never[]),
    } as unknown as D1PreparedStatement;
    executions.set(statement, execute);
    return statement;
  };
  return {
    prepare,
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(executions.get(statement)!());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql: string) => { sqlite.exec(sql); return {count:1,duration:0}; },
  } as unknown as D1Database;
}

/** Synthetic identities only; remote enrollment is a separate operator-reviewed operation. */
export async function seedIdentity(db: D1Database) {
  await db.prepare(`INSERT INTO deployment_identity VALUES(1,'test',?,'test',123456,'-1002,-1001',-1001)`)
    .bind("11111111-1111-1111-1111-111111111111").run();
}
