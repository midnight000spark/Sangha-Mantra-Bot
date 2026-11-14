import { describe } from "bun:test";
import { createTestDb } from "./db";
import { intakeBoundaryCases } from "./intake-boundary-cases";

describe("automatic intake boundaries", () => intakeBoundaryCases("SQLite", async () => ({ db: await createTestDb() })));
