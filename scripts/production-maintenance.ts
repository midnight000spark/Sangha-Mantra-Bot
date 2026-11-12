export {};
// Owner-terminal entry point; each independent check runs even if another fails.
const args = Bun.argv.slice(2);
if (args.some(arg => arg !== "--metrics") || args.length > 1) throw new Error("Use --metrics or no arguments");
const jobs = [
  ["scripts/production-ops.ts", "check"],
  ["scripts/production-ops.ts", "backup"],
  ...(args.includes("--metrics") ? [
    ["scripts/test-metrics.ts", "--production", "--since-deploy"],
    ["scripts/test-metrics.ts", "--production", "--since-deploy", "--cron"],
  ] : []),
];
const results = [];
for (const job of jobs) {
  const child = Bun.spawn([process.execPath, ...job], { env: process.env, stdout: "inherit", stderr: "inherit" });
  results.push({ job: job.join(" "), exitCode: await child.exited });
}
console.log(JSON.stringify({ environment: "production", checkedAt: new Date().toISOString(), results }));
if (results.some(result => result.exitCode !== 0)) process.exitCode = 1;
