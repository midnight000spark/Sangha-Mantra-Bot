import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { productionTarget } from "./production-ops";

// Run in the owner's terminal after the first successful manual maintenance.
export function maintenanceUnits(root: string, executable: string) {
  if ([root, executable].some(value => /[\n\r"%\\]/.test(value)) || !root.startsWith("/") || !executable.startsWith("/"))
    throw new Error("Unsupported service path");
  return { service: `[Unit]
Description=Sangha Mantra production health and verified encrypted backup

[Service]
Type=oneshot
WorkingDirectory=${root}
ExecStart="${executable}" --env-file=.secrets/.env.ops.test scripts/production-maintenance.ts
UMask=0077
TimeoutStartSec=600
`, timer: `[Unit]
Description=Hourly Sangha Mantra production maintenance while this PC is available

[Timer]
OnCalendar=*-*-* *:17:00
Persistent=true
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
` };
}
async function main() {
  if (Bun.argv.length !== 2) throw new Error("No arguments supported");
  productionTarget(await Bun.file("wrangler.jsonc").json());
  const root = process.cwd();
  if ([root, process.execPath].some(value => /[\n\r"%\\]/.test(value))) throw new Error("Unsupported service path");
  const directory = join(homedir(), ".config/systemd/user");
  await mkdir(directory, { recursive: true });
  const name = "sangha-mantra-production-maintenance";
  const units = maintenanceUnits(root, process.execPath);
  // Idempotent repair of this exact installer output only; preserve unknown units.
  for (const [extension, content] of Object.entries(units)) {
    const path = join(directory, `${name}.${extension}`);
    if (await Bun.file(path).exists()) {
      const existing = await readFile(path, "utf8");
      const legacy = extension === "service" ? content.replace(`WorkingDirectory=${root}`, `WorkingDirectory="${root}"`) : content;
      if (existing !== content && existing !== legacy) throw new Error("Existing unit differs; refusing to overwrite " + path);
    }
  }
  for (const [extension, content] of Object.entries(units))
    await writeFile(join(directory, `${name}.${extension}`), content, { mode: 0o600 });
  const verify = Bun.spawn(["systemd-analyze", "--user", "verify", join(directory, `${name}.service`), join(directory, `${name}.timer`)], { stdout: "inherit", stderr: "inherit" });
  if (await verify.exited !== 0) throw new Error("Unit verification failed; timer was not enabled");
  for (const args of [["daemon-reload"], ["enable", "--now", `${name}.timer`], ["start", `${name}.service`],
    ["status", `${name}.timer`, "--no-pager"]]) {
    const child = Bun.spawn(["systemctl", "--user", ...args], { stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0) throw new Error("User maintenance unit did not complete successfully; inspect journalctl --user -u " + name);
  }
  console.log(JSON.stringify({ installed: true, scope: "user", hourly: true, independentStorage: false,
    requiresAvailablePC: true, externalAlertDelivery: false, automaticDeletion: false }));
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : "Maintenance installation failed"); process.exitCode = 1; });
