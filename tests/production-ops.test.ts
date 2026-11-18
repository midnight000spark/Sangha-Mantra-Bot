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

test.skipIf(!Bun.which("systemd-analyze"))("generated maintenance units pass an isolated user systemd parser that rejects invalid units", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mantra-unit-test-"));
  try {
    const units = maintenanceUnits(process.cwd(), process.execPath);
    const paths: string[] = [];
    for (const [extension, content] of Object.entries(units)) {
      const path = join(directory, `sangha-mantra-production-maintenance.${extension}`);
      await writeFile(path, content); paths.push(path);
    }
    const verify = async () => {
      // Do not load the operator's user units, drop-ins, runtime state or generators.
      // Keep the real vendor dependencies and executable checks; no stub targets.
      const child = Bun.spawn(["systemd-analyze", "--user", "--generators=no", "--man=no", "--recursive-errors=yes", "verify", ...paths], {
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          XDG_RUNTIME_DIR: directory,
          SYSTEMD_UNIT_PATH: `${directory}:/usr/local/lib/systemd/user:/usr/lib/systemd/user:/lib/systemd/user`,
        },
        stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    const valid = await verify();
    expect(valid).toEqual({ code: 0, stdout: "", stderr: "" });

    const service = join(directory, "sangha-mantra-production-maintenance.service");
    await writeFile(service, units.service + "A06UnknownDirective=yes\n");
    const unknownDirective = await verify();
    expect(unknownDirective.code).not.toBe(0);
    expect(unknownDirective.stderr).toContain("A06UnknownDirective");

    await writeFile(service, units.service.replace(process.execPath, join(directory, "missing-executable")));
    const missingExecutable = await verify();
    expect(missingExecutable.code).not.toBe(0);
    expect(missingExecutable.stderr).toContain("missing-executable");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
