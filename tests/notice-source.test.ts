import { describe } from "bun:test";
import { createTestDb, initializeTestDb, testConfig } from "./db";
import { noticeSourceCases } from "./notice-source-cases";

describe("notice source fence", () => noticeSourceCases("SQLite", async () => {
  const db = await createTestDb(); await initializeTestDb(db, testConfig); return { db };
}));
