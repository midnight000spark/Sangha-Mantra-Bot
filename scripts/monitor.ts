export {};

const { BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL, REPORT_CHAT_ID, ALLOWED_CHAT_IDS } = process.env;
if (!BOT_TOKEN || !WEBHOOK_SECRET || !WORKER_URL || !REPORT_CHAT_ID || !ALLOWED_CHAT_IDS) {
  throw new Error("Set BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL, REPORT_CHAT_ID and ALLOWED_CHAT_IDS");
}
const sourceChatIds = ALLOWED_CHAT_IDS.split(",").map((id) => id.trim());
const chatIds = [...new Set([...sourceChatIds, REPORT_CHAT_ID])];
if (chatIds.some((id) => !/^-[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))) throw new Error("Invalid configured group IDs");
const origin = new URL(WORKER_URL);
if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash
  || !["", "/"].includes(origin.pathname)) {
  throw new Error("WORKER_URL must be an HTTPS origin without credentials");
}
const requiredUpdates = ["message", "edited_message", "my_chat_member", "callback_query"];
const problems: string[] = [];
const now = Date.now();
const maxIdleHours = Number(process.env.MAX_EVENT_AGE_HOURS ?? "0");
if (!Number.isFinite(maxIdleHours) || maxIdleHours < 0) throw new Error("Invalid MAX_EVENT_AGE_HOURS");

async function telegram<T>(method: string, payload = {}): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => { throw new Error(`Telegram ${method} network request failed`); });
  const data = await response.json() as { ok: boolean; result: T };
  if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
  return data.result;
}

const [webhook, me, healthResponse] = await Promise.all([
  telegram<{ url: string; allowed_updates?: string[]; pending_update_count: number; last_error_date?: number }>("getWebhookInfo"),
  telegram<{ id: number; can_read_all_group_messages?: boolean }>("getMe"),
  fetch(new URL("/health", origin), {
    headers: { "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET }, signal: AbortSignal.timeout(20_000),
  }),
]);
if (webhook.url !== new URL("/webhook", origin).href) problems.push("Webhook URL differs from the configured Worker");
if (requiredUpdates.some((name) => !webhook.allowed_updates?.includes(name))) problems.push("Webhook update allowlist is incomplete");
if (webhook.pending_update_count > 100) problems.push(`Telegram has ${webhook.pending_update_count} pending updates`);
if (webhook.last_error_date && now - webhook.last_error_date * 1000 < 60 * 60_000) problems.push("Telegram reported a webhook delivery error within the last hour");

const memberships = [];
for (const chatId of chatIds) {
  const membership = await telegram<{ status: string; can_send_messages?: boolean; is_member?: boolean }>("getChatMember", {
    chat_id: chatId, user_id: me.id,
  });
  memberships.push({ chatId, status: membership.status });
  if (["left", "kicked"].includes(membership.status)
    || (membership.status === "restricted" && (!membership.is_member || !membership.can_send_messages))) {
    problems.push(`Bot is absent or cannot send messages in group ${chatId}`);
  }
  if (sourceChatIds.includes(chatId) && !me.can_read_all_group_messages && membership.status !== "administrator") {
    problems.push(`Privacy Mode is enabled and bot is not an administrator in source group ${chatId}`);
  }
}
if (!healthResponse.ok) {
  problems.push(`Worker health failed with HTTP ${healthResponse.status}`);
} else {
  const health = await healthResponse.json() as {
    status: string; unresolvedReports: number; unresolvedNotices: number;
    recoveryPending: boolean; lastEventAt: number | null; lastCronAt: number | null;
  };
  if (health.status !== "ok") problems.push(`Worker reports status ${health.status}`);
  if (health.unresolvedReports > 0) problems.push(`${health.unresolvedReports} report(s) require attention`);
  if (health.unresolvedNotices > 0) problems.push(`${health.unresolvedNotices} notice(s) require attention`);
  if (health.recoveryPending) problems.push("Restored data is awaiting reconciliation");
  if (!health.lastCronAt || now - health.lastCronAt > 15 * 60_000) problems.push("No successful scheduled run in the last 15 minutes");
  if (maxIdleHours > 0 && (!health.lastEventAt || now - health.lastEventAt > maxIdleHours * 3_600_000)) {
    problems.push(`No contribution event within the configured ${maxIdleHours}-hour activity window`);
  }
}

// This optional read checks actual off-account artifact age, not the intended schedule.
if (process.env.GITHUB_REPOSITORY && process.env.GH_TOKEN) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts?per_page=100`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    problems.push(`Cannot inspect independent backup artifacts: HTTP ${response.status}`);
  } else {
    const data = await response.json() as { artifacts: { name: string; expired: boolean; created_at: string }[] };
    const latest = data.artifacts.filter((artifact) => artifact.name.startsWith("mantra-backup-") && !artifact.expired)
      .map((artifact) => Date.parse(artifact.created_at)).sort((a, b) => b - a)[0];
    if (!latest || now - latest > 2 * 3_600_000) problems.push("No independent backup artifact younger than two hours");
  }
}
for (const problem of problems) console.error(problem);
console.log(JSON.stringify({ checkedAt: new Date(now).toISOString(), healthy: problems.length === 0,
  pendingUpdates: webhook.pending_update_count, memberships, issues: problems.length }));
if (problems.length) process.exitCode = 1;
