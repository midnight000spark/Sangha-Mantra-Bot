import { expect, test } from "bun:test";
import { productionTarget } from "../scripts/production-ops";
import { maintenanceUnits } from "../scripts/install-production-maintenance";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("production operations reject swapped D1, chat, account and TEST targets", async () => {
  const config = await Bun.file("wrangler.jsonc").json();
  expect(productionTarget(config).databaseId).toBe("66666666-7777-4888-8999-aaaaaaaaaaaa");
  for (const mutate of [
    (c: any) => { c.env.production = c.env.test; },
    (c: any) => { c.env.production.d1_databases[0].database_id = c.env.test.d1_databases[0].database_id; },
    (c: any) => { c.env.production.vars.REPORT_CHAT_ID = "-1001234567890"; },
    (c: any) => { c.env.production.account_id = "other"; },
  ]) {
    const changed = structuredClone(config); mutate(changed);
    expect(() => productionTarget(changed)).toThrow();
  }
});

test.skipIf(!Bun.which("systemd-analyze") || !process.env.XDG_RUNTIME_DIR)("generated maintenance units are accepted by the actual user systemd parser without starting a service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mantra-unit-test-"));
  try {
    const units = maintenanceUnits(process.cwd(), process.execPath);
    const paths = [];
    for (const [extension, content] of Object.entries(units)) {
      const path = join(directory, `sangha-mantra-production-maintenance.${extension}`);
      await writeFile(path, content); paths.push(path);
    }
    const child = Bun.spawn(["systemd-analyze", "--user", "verify", ...paths], { stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).not.toContain("bad unit file"); expect(code).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
