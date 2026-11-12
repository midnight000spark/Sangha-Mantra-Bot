import { resolve } from "node:path";
import { productionTarget } from "./production-ops";

// No raw logs, request URLs, headers, bodies or exception messages are emitted.
const target = productionTarget(await Bun.file("wrangler.jsonc").json());
const versionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const child = Bun.spawn([process.execPath, resolve("node_modules/wrangler/bin/wrangler.js"),
  "tail", "--env", "production", "--version-id", versionId, "--format", "json"],
  { stdout: "pipe", stderr: "ignore", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
const timer = setTimeout(() => child.kill(), 6 * 60_000);
let buffer = "", object = "", depth = 0, quoted = false, escaped = false;
const rows: unknown[] = [];
try {
  for await (const chunk of child.stdout) {
    buffer += new TextDecoder().decode(chunk);
    for (const char of buffer) {
      if (!depth && char !== "{") continue;
      object += char;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}") depth--;
      if (!depth) {
        try {
          const event = JSON.parse(object);
          const row = { worker: event.scriptName, versionId: event.scriptVersion?.id ?? null,
            timestamp: event.eventTimestamp, outcome: event.outcome,
            cron: event.event?.cron ?? null, exceptionCount: event.exceptions?.length ?? 0,
            cpuTimeMs: typeof event.cpuTimeMs === "number" ? event.cpuTimeMs : null };
          if (row.worker === target.workerName) { rows.push(row); console.log(JSON.stringify(row)); }
        } catch { /* Ignore CLI setup messages; never echo them. */ }
        object = "";
      }
    }
    buffer = "";
  }
} finally {
  clearTimeout(timer); child.kill();
  await Bun.write("test-results/production/tail.json", JSON.stringify({ versionId, rows }, null, 2));
}
