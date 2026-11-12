import { getConfig, initialize } from "./config";
import { ingest, totals } from "./core";
import { deliverNotices, enqueueNotice, handleAdmin, notifyOperators } from "./admin";
import { eventKey, parseAmount } from "./parser";
import { runReports } from "./reports";
import { handleAdminDialog } from "./admin-dialog";
import { answerTelegramCallback, parseTelegramUpdate } from "./telegram";
import type { Env } from "./types";

const maxBodyBytes = 65_536;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== "/webhook" && path !== "/health") return new Response("Not found", { status: 404 });
    if (!env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    if ((path === "/webhook" && request.method !== "POST") || (path === "/health" && request.method !== "GET")) {
      return new Response("Method not allowed", { status: 405 });
    }
    try {
      const config = getConfig(env);
      await initialize(env.DB, config);
      if (path === "/health") {
        const [summary, recovery, reports, notices, heartbeat, reviews, membership] = await Promise.all([
          totals(env.DB, config.campaignId),
          env.DB.prepare("SELECT restored_at,backup_at FROM recovery_state WHERE campaign_id=? AND reconciled_at IS NULL").bind(config.campaignId).first(),
          env.DB.prepare("SELECT COUNT(*) AS count FROM daily_reports WHERE campaign_id=? AND status IN ('UNCERTAIN','FAILED_KNOWN')").bind(config.campaignId).first<{ count: number }>(),
          env.DB.prepare("SELECT COUNT(*) AS count FROM notices WHERE campaign_id=? AND state IN ('UNCERTAIN','FAILED_KNOWN')").bind(config.campaignId).first<{ count: number }>(),
          env.DB.prepare("SELECT last_cron_at,last_webhook_at FROM system_heartbeat WHERE campaign_id=?").bind(config.campaignId).first<{ last_cron_at: number | null; last_webhook_at: number | null }>(),
          env.DB.prepare("SELECT COUNT(*) AS count FROM contributions WHERE campaign_id=? AND source_state='REVIEW' AND override_amount IS NULL").bind(config.campaignId).first<{ count: number }>(),
          env.DB.prepare(`SELECT chat_id,status,can_send_messages FROM bot_membership m WHERE campaign_id=?
            AND NOT EXISTS(SELECT 1 FROM operational_events e WHERE e.campaign_id=m.campaign_id
              AND e.kind='CHAT_MIGRATION' AND json_extract(e.detail,'$.oldId')=m.chat_id)`)
            .bind(config.campaignId).all<{chat_id:number;status:string;can_send_messages:number|null}>(),
        ]);
        const missingAccess = membership.results.filter(row => ["left", "kicked"].includes(row.status) || row.can_send_messages === 0);
        return Response.json({
          status: recovery || reports?.count || notices?.count || reviews?.count || missingAccess.length ? "degraded" : "ok",
          campaign: config.campaignId, total: summary, unresolvedReports: reports?.count ?? 0,
          unresolvedNotices: notices?.count ?? 0, reviews: reviews?.count ?? 0,
          recoveryPending: recovery !== null, recovery, missingAccess,
          lastCronAt: heartbeat?.last_cron_at ?? null, lastEventAt: heartbeat?.last_webhook_at ?? null,
        }, { headers: { "Cache-Control": "no-store" } });
      }
      const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
      if (declaredLength > maxBodyBytes) return new Response("Payload too large", { status: 413 });
      const reader = request.body?.getReader();
      if (!reader) return new Response("Missing payload", { status: 400 });
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBodyBytes) {
          await reader.cancel();
          return new Response("Payload too large", { status: 413 });
        }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { return new Response("Invalid JSON", { status: 400 }); }
      const update = parseTelegramUpdate(raw);
      if (!update) return new Response("Invalid Telegram update", { status: 400 });
      const key = await eventKey(update);
      const now = Date.now();
      const message = update.message ?? update.edited_message;
      let noticesQueued = false;
      let handled = false;
      if (update.callback_query) {
        const callback = update.callback_query;
        // Callback id is stable even if a delivery wrapper changes; never key a correction by update_id.
        handled = await handleAdminDialog(env.DB, config, { callback }, `callback:${callback.id}`, now, env.BOT_TOKEN);
        noticesQueued = handled;
        ctx.waitUntil(answerTelegramCallback(env.BOT_TOKEN, callback.id));
      }
      if (message && !update.edited_message) {
        handled = await handleAdminDialog(env.DB, config, { message }, key, now, env.BOT_TOKEN);
        if (!handled) handled = await handleAdmin(env.DB, config, message, key, now);
        noticesQueued = handled;
      }
      if (!handled && message && (message.migrate_to_chat_id !== undefined || message.migrate_from_chat_id !== undefined)) {
        const oldId = message.migrate_from_chat_id ?? message.chat.id;
        const newId = message.migrate_to_chat_id ?? message.chat.id;
        const oldMapping = await env.DB.prepare(`SELECT
          EXISTS(SELECT 1 FROM chat_aliases WHERE chat_id=? AND campaign_id=?) AS is_source,
          EXISTS(SELECT 1 FROM campaigns WHERE id=? AND report_chat_id=?) AS is_report`)
          .bind(oldId, config.campaignId, config.campaignId, oldId).first<{ is_source: number; is_report: number }>();
        if ((oldMapping?.is_source || oldMapping?.is_report) && oldId !== newId && ["group", "supergroup"].includes(message.chat.type)) {
          await env.DB.batch([
            env.DB.prepare(`INSERT INTO chat_aliases(chat_id,campaign_id) SELECT ?,? WHERE ?=1
              ON CONFLICT(chat_id) DO NOTHING`).bind(newId, config.campaignId, oldMapping.is_source),
            env.DB.prepare(`UPDATE campaigns SET report_chat_id=? WHERE id=? AND report_chat_id=?
              AND (?=0 OR EXISTS(SELECT 1 FROM chat_aliases WHERE chat_id=? AND campaign_id=?))`)
              .bind(newId, config.campaignId, oldId, oldMapping.is_source, newId, config.campaignId),
            env.DB.prepare(`INSERT INTO operational_events(event_key,campaign_id,update_id,kind,source_chat_id,message_id,detail,created_at)
              VALUES(?,?,?,'CHAT_MIGRATION',?,?,?,?) ON CONFLICT(event_key) DO NOTHING`)
              .bind(key, config.campaignId, update.update_id, message.chat.id, message.message_id, JSON.stringify({ oldId, newId }), now),
          ]);
          handled = true;
        }
      }
      if (!handled && update.my_chat_member) {
        const member = update.my_chat_member;
        const alias = await env.DB.prepare(`SELECT chat_id FROM chat_aliases WHERE chat_id=? AND campaign_id=?
          UNION SELECT report_chat_id FROM campaigns WHERE id=? AND report_chat_id=?`)
          .bind(member.chat.id, config.campaignId, config.campaignId, member.chat.id).first();
        if (alias) {
          await env.DB.batch([
            env.DB.prepare(`INSERT INTO bot_membership(chat_id,campaign_id,status,can_send_messages,event_date,updated_at) VALUES(?,?,?,?,?,?)
              ON CONFLICT(chat_id) DO UPDATE SET status=excluded.status,can_send_messages=excluded.can_send_messages,event_date=excluded.event_date,updated_at=excluded.updated_at
              WHERE excluded.event_date>=bot_membership.event_date`)
              .bind(member.chat.id, config.campaignId, member.new_chat_member.status, member.new_chat_member.can_send_messages === undefined ? null : Number(member.new_chat_member.can_send_messages), member.date, now),
            env.DB.prepare(`INSERT INTO operational_events(event_key,campaign_id,update_id,kind,source_chat_id,detail,created_at)
              VALUES(?,?,?,'MEMBERSHIP',?,?,?) ON CONFLICT(event_key) DO NOTHING`)
              .bind(key, config.campaignId, update.update_id, member.chat.id, member.new_chat_member.status, now),
          ]);
          await notifyOperators(env.DB, config, now);
          noticesQueued = true;
          handled = true;
        }
      }
      if (!handled && message && ["group", "supergroup"].includes(message.chat.type)) {
        const alias = await env.DB.prepare("SELECT chat_id FROM chat_aliases WHERE chat_id=? AND campaign_id=?").bind(message.chat.id, config.campaignId).first();
        if (alias && !message.service && message.from && !message.from.is_bot && message.sender_chat === undefined
          && message.forward_origin === undefined && message.forward_date === undefined && !message.is_automatic_forward) {
          const parsed = parseAmount(message.text, config.maxAmount, message.entities);
          // New conversation/media has no ledger row. Edits need a zero tombstone even
          // when delivered before the original, or a delayed number could resurrect it.
          if (parsed.kind !== "NO_NUMBER" || update.edited_message) {
            const result = await ingest(env.DB, config, {
              key, updateId: update.update_id, chatId: message.chat.id, messageId: message.message_id,
              userId: message.from.id, originalDate: message.date, versionDate: message.edit_date ?? message.date,
              isEdit: update.edited_message !== undefined, ...parsed, now,
            });
            if (result.outcome === "NEEDS_REVIEW" || result.outcome === "REJECTED"
              || (parsed.kind !== "NO_NUMBER" && parsed.state === "INVALID" && !["IGNORED_STALE", "UNCHANGED"].includes(result.outcome))) {
              const reason = result.outcome === "NEEDS_REVIEW"
                ? "Версии сообщения неоднозначны. Вклад требует проверки ответственным за учёт."
                : parsed.reason ?? result.reason ?? "Вклад не принят. Обратитесь к ответственному за учёт.";
              if (parsed.kind !== "NO_NUMBER") {
                await enqueueNotice(env.DB, config, `rejected:${message.chat.id}:${message.message_id}`, message.chat.id, reason, now, message.message_id);
                noticesQueued = true;
              }
              if (result.outcome === "NEEDS_REVIEW") await notifyOperators(env.DB, config, now);
              if (result.outcome === "NEEDS_REVIEW") noticesQueued = true;
            }
          }
          handled = true;
        }
      }
      if (!handled && (!message || message.service)) {
        await env.DB.prepare(`INSERT INTO operational_events(event_key,campaign_id,update_id,kind,source_chat_id,message_id,detail,created_at)
          VALUES(?,?,?,'IGNORED',?,?,?,?) ON CONFLICT(event_key) DO NOTHING`)
          .bind(key, config.campaignId, update.update_id, message?.chat.id ?? update.my_chat_member?.chat.id ?? null,
            message?.message_id ?? null, "Unsupported context, sender or service update", now).run();
      }
      await env.DB.prepare(`INSERT INTO system_heartbeat(campaign_id,last_webhook_at) VALUES(?,?)
        ON CONFLICT(campaign_id) DO UPDATE SET last_webhook_at=excluded.last_webhook_at`).bind(config.campaignId, now).run();
      // All accepted input and outgoing notices are committed before acknowledging Telegram.
      if (noticesQueued) ctx.waitUntil(deliverNotices(env.DB, config, env.BOT_TOKEN));
      return new Response("OK");
    } catch {
      // Do not leak payloads, secret headers or token-bearing network error URLs.
      console.error("Webhook or health operation failed; inspect D1/configuration and retry");
      return new Response("Temporarily unavailable", { status: 503 });
    }
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const config = getConfig(env);
    await initialize(env.DB, config);
    await runReports(env.DB, config, env.BOT_TOKEN);
    await notifyOperators(env.DB, config);
    await deliverNotices(env.DB, config, env.BOT_TOKEN);
    await env.DB.prepare(`INSERT INTO system_heartbeat(campaign_id,last_cron_at) VALUES(?,?)
      ON CONFLICT(campaign_id) DO UPDATE SET last_cron_at=excluded.last_cron_at`).bind(config.campaignId, Date.now()).run();
  },
} satisfies ExportedHandler<Env>;
