import { createTestDb, initializeTestDb, testConfig } from "./db";
import { noticeAuthorizationCases } from "./notice-auth-cases";

describe("notice authorization", () => noticeAuthorizationCases("SQLite", async () => {
  const db = await createTestDb();
  await initializeTestDb(db, testConfig);
  return { db };
}));
import { describe } from "bun:test";
