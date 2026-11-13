import { stateText } from "./admin-text";
import { isTestSender } from "./test-sender";
import { adjustmentStatements, inspect } from "./core";
import { resolveTelegramGroup, type ReplyMarkup, type TelegramCallback, type TelegramMessage } from "./telegram";
import type { Config, Contribution } from "./types";

const lifetime = 30 * 60_000;
const expired = "Действие устарело или запись изменилась. Пришлите ссылку заново либо выберите запись через /recent.";
const forceReply: ReplyMarkup = { force_reply: true, selective: true };
type Values = (string | number | null)[];
type Guard = { sql: string; values: Values };
interface Session {
  id: string; campaign_id: string; actor_id: number; private_chat_id: number;
  source_chat_id: number; message_id: number; target_revision: string;
  state: string; amount: number | null; prompt_key: string | null; created_at: number; expires_at: number;
}
interface Context { db: D1Database; config: Config; actor: number; chat: number; key: string; now: number; replyId?: number }

/** Only exact message links. A comment link points into a different chat and is rejected. */
export function parseMessageLink(text: string): { chatId?: number; username?: string; messageId: number } | null {
  if (!/^(?:https:\/\/)?(?:t\.me|telegram\.me)\//i.test(text)) return null;
  try {
    const url = new URL(/^https:\/\//i.test(text) ? text : `https://${text}`);
    if (!["t.me", "telegram.me"].includes(url.hostname) || url.username || url.password || url.port
      || Array.from(url.searchParams.keys()).some(key => !["single", "thread", "t"].includes(key))) return null;
    const path = url.pathname.split("/").slice(1);
    const privateLink = path[0] === "c";
    const parts = privateLink ? path.slice(1) : path;
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (parts.length === 3 && !/^[1-9][0-9]*$/.test(parts[1]!)) return null;
    const last = parts.at(-1)!;
    if (!/^[1-9][0-9]*$/.test(last) || !Number.isSafeInteger(Number(last))) return null;
    if (privateLink) {
      if (!/^[1-9][0-9]*$/.test(parts[0]!)) return null;
      const chatId = Number(`-100${parts[0]}`);
      return Number.isSafeInteger(chatId) ? { chatId, messageId: Number(last) } : null;
    }
    return /^[a-z][a-z0-9_]{0,31}$/i.test(parts[0]!) ? { username: parts[0], messageId: Number(last) } : null;
  } catch { return null; }
}

function revision(row: Contribution): string {
  return JSON.stringify([row.last_event_key, row.updated_at, row.override_amount, row.effective_amount]);
}
function revisionGuard(row: Contribution): Guard {
  return { sql: `EXISTS(SELECT 1 FROM contributions WHERE campaign_id=? AND source_chat_id=? AND message_id=?
    AND last_event_key=? AND updated_at=? AND override_amount IS ? AND effective_amount=?)`,
    values: [row.campaign_id, row.source_chat_id, row.message_id, row.last_event_key, row.updated_at, row.override_amount, row.effective_amount] };
}
function sessionGuard(ctx: Context, session: Session): Guard {
  return { sql: `EXISTS(SELECT 1 FROM admin_sessions s WHERE id=? AND campaign_id=? AND actor_id=? AND private_chat_id=?
    AND state=? AND expires_at>? AND NOT EXISTS(SELECT 1 FROM recovery_state r
      WHERE r.campaign_id=s.campaign_id AND r.restored_at>=s.created_at))`,
    values: [session.id, ctx.config.campaignId, ctx.actor, ctx.chat, session.state, ctx.now] };
}
const combine = (a: Guard, b: Guard): Guard => ({ sql: `(${a.sql}) AND (${b.sql})`, values: [...a.values, ...b.values] });

/** A fresh per-attempt nonce gates every mutation, including when Telegram retries after commit. */
async function commit(ctx: Context, action: string, body: string, options: {
  session?: string; guard?: Guard; markup?: ReplyMarkup; detail?: unknown;
  mutations?: (gate: Guard) => D1PreparedStatement[];
} = {}): Promise<void> {
  const nonce = crypto.randomUUID();
  const guard = options.guard ?? { sql: "1", values: [] };
  const gate: Guard = { sql: "EXISTS(SELECT 1 FROM admin_ui_events WHERE event_key=? AND nonce=? AND outcome='APPLIED')", values: [ctx.key, nonce] };
  await ctx.db.batch([
    ctx.db.prepare(`INSERT INTO admin_ui_events(event_key,nonce,campaign_id,actor_id,private_chat_id,session_id,action,outcome,detail,created_at)
      SELECT ?,?,?,?,?,?,?,CASE WHEN ${guard.sql} THEN 'APPLIED' ELSE 'REJECTED' END,?,?
      ON CONFLICT(event_key) DO NOTHING`)
      .bind(ctx.key, nonce, ctx.config.campaignId, ctx.actor, ctx.chat, options.session ?? null, action,
        ...guard.values, JSON.stringify(options.detail ?? {}), ctx.now),
    ...(options.mutations?.(gate) ?? []),
    ctx.db.prepare(`INSERT INTO notices(notice_key,campaign_id,chat_id,reply_message_id,body,reply_markup,created_at)
      SELECT ?,?,?,?,CASE WHEN outcome='APPLIED' THEN ? ELSE ? END,
        CASE WHEN outcome='APPLIED' THEN ? ELSE NULL END,? FROM admin_ui_events
      WHERE event_key=? AND nonce=? ON CONFLICT(notice_key) DO NOTHING`)
      .bind(`ui:${ctx.key}`, ctx.config.campaignId, ctx.chat, ctx.replyId ?? null, body.slice(0, 4000), expired,
        options.markup ? JSON.stringify(options.markup) : null, ctx.now, ctx.key, nonce),
  ]);
}

async function openRecord(ctx: Context, chatId: number, messageId: number): Promise<void> {
  const row = await inspect(ctx.db, chatId, messageId);
  if (!row || row.campaign_id !== ctx.config.campaignId) {
    await commit(ctx, "NOT_FOUND", "Накопление не найдено в этой кампании. Проверьте ссылку или выберите запись через /recent."); return;
  }
  const id = crypto.randomUUID().replaceAll("-", "");
  await commit(ctx, "OPEN", `Накопление за ${row.local_day}\nСообщение: ${chatId}/${messageId}\nТекущее значение: ${row.effective_amount}\nЗначение участника: ${row.source_amount} (${stateText(row.source_state)})\nАдминистративное значение: ${row.override_amount ?? "не задано"}\nДиалог действует 30 минут.`, {
    session: id, guard: revisionGuard(row), detail: { chatId, messageId, current: row.effective_amount },
    markup: { inline_keyboard: [[{ text: "Исправить", callback_data: `au:e:${id}` }, { text: "Отменить", callback_data: `au:c:${id}` }]] },
    mutations: gate => [
      ctx.db.prepare(`UPDATE admin_sessions SET state='CANCELLED' WHERE campaign_id=? AND actor_id=?
        AND state IN ('VIEW','AMOUNT','REASON') AND (${gate.sql})`).bind(ctx.config.campaignId, ctx.actor, ...gate.values),
      ctx.db.prepare(`INSERT INTO admin_sessions(id,campaign_id,actor_id,private_chat_id,source_chat_id,message_id,target_revision,state,created_at,expires_at)
        SELECT ?,?,?,?,?,?,?,'VIEW',?,? WHERE ${gate.sql}`)
        .bind(id, ctx.config.campaignId, ctx.actor, ctx.chat, chatId, messageId, revision(row), ctx.now, ctx.now + lifetime, ...gate.values),
    ],
  });
}

async function cancel(ctx: Context, session?: Session): Promise<void> {
  await commit(ctx, "CANCEL", "Исправление отменено. Значение не изменено.", {
    session: session?.id, guard: session ? sessionGuard(ctx, session) : undefined,
    mutations: gate => [ctx.db.prepare(`UPDATE admin_sessions SET state='CANCELLED' WHERE campaign_id=? AND actor_id=?
      AND state IN ('VIEW','AMOUNT','REASON') AND (? IS NULL OR id=?) AND (${gate.sql})`)
      .bind(ctx.config.campaignId, ctx.actor, session?.id ?? null, session?.id ?? null, ...gate.values)],
  });
}

async function receiveValue(ctx: Context, message: TelegramMessage, session: Session): Promise<void> {
  const promptGuard: Guard = { sql: `EXISTS(SELECT 1 FROM notices WHERE notice_key=? AND campaign_id=? AND chat_id=? AND state='SENT' AND sent_message_id=?)`,
    values: [session.prompt_key, ctx.config.campaignId, ctx.chat, message.reply_to_message_id ?? null] };
  const guard = combine(sessionGuard(ctx, session), promptGuard);
  const prompt = await ctx.db.prepare("SELECT sent_message_id FROM notices WHERE notice_key=? AND state='SENT'")
    .bind(session.prompt_key).first<{ sent_message_id: number }>();
  if (!prompt || message.reply_to_message_id !== prompt.sent_message_id) {
    await commit(ctx, "WRONG_REPLY", "Ответьте через «Ответить» именно на текущий запрос числа или причины от бота. Для выхода — /cancel."); return;
  }
  const text = (message.text ?? "").trim();
  if (session.state === "AMOUNT") {
    const amount = Number(text);
    const valid = /^(0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(amount) && amount <= ctx.config.maxAmount;
    await commit(ctx, valid ? "AMOUNT" : "INVALID_AMOUNT", valid
      ? `Новое значение: ${amount}. Ответьте на это сообщение и укажите причину (1–1000 символов). Для отмены — /cancel.`
      : `Нужно целое число от 0 до ${ctx.config.maxAmount}, без пробелов и знаков. Ответьте на это сообщение.`, {
      session: session.id, guard, markup: forceReply, detail: valid ? { amount } : {},
      mutations: gate => [ctx.db.prepare(`UPDATE admin_sessions SET state=?,amount=?,prompt_key=? WHERE id=? AND (${gate.sql})`)
        .bind(valid ? "REASON" : "AMOUNT", valid ? amount : null, `ui:${ctx.key}`, session.id, ...gate.values)],
    });
    return;
  }
  if (!text || text.length > 1000 || text.startsWith("/")) {
    await commit(ctx, "INVALID_REASON", "Укажите причину обычным текстом от 1 до 1000 символов, ответив на это сообщение. Для отмены — /cancel.", {
      session: session.id, guard, markup: forceReply,
      mutations: gate => [ctx.db.prepare(`UPDATE admin_sessions SET prompt_key=? WHERE id=? AND (${gate.sql})`)
        .bind(`ui:${ctx.key}`, session.id, ...gate.values)],
    }); return;
  }
  const row = await inspect(ctx.db, session.source_chat_id, session.message_id);
  if (!row || row.campaign_id !== ctx.config.campaignId || revision(row) !== session.target_revision) {
    await commit(ctx, "STALE_TARGET", expired); return;
  }
  await commit(ctx, "CORRECT", `Исправление сохранено: ${row.effective_amount} → ${session.amount}.\nПричина: ${text}`, {
    session: session.id, guard: combine(guard, revisionGuard(row)),
    detail: { chatId: row.source_chat_id, messageId: row.message_id, amount: session.amount, reason: text },
    mutations: gate => [
      ...adjustmentStatements(ctx.db, ctx.config, { key: `ui-session:${session.id}`, actorId: ctx.actor,
        chatId: row.source_chat_id, messageId: row.message_id, amount: session.amount!, reason: text, now: ctx.now }, gate),
      ctx.db.prepare(`UPDATE admin_sessions SET state='DONE' WHERE id=? AND (${gate.sql})`).bind(session.id, ...gate.values),
    ],
  });
}

export async function handleAdminDialog(db: D1Database, config: Config, input: { message?: TelegramMessage; callback?: TelegramCallback },
  key: string, now: number, token: string): Promise<boolean> {
  const { message, callback } = input;
  const from = message?.from ?? callback?.from;
  const chat = message?.chat ?? callback?.message?.chat;
  if ((!chat || chat.type !== "private") && !callback) return false;
  const authorized = chat?.type === "private" && from && (!from.is_bot || (message && isTestSender(config, message, true))) && config.adminIds.includes(from.id) && chat.id === from.id
    && !message?.service && message?.sender_chat === undefined && message?.forward_origin === undefined
    && message?.forward_date === undefined && !message?.is_automatic_forward;
  if (!authorized) {
    await db.prepare(`INSERT INTO operational_events(event_key,campaign_id,kind,actor_id,source_chat_id,detail,created_at)
      VALUES(?,?,'ADMIN_UI_DENIED',?,?,'Private admin context required',?) ON CONFLICT(event_key) DO NOTHING`)
      .bind(`ui-denied:${key}`, config.campaignId, from?.id ?? null, chat?.id ?? null, now).run();
    return true;
  }
  const ctx: Context = { db, config, actor: from.id, chat: chat.id, key, now, replyId: message?.message_id };
  // A committed action is never interpreted again in a later dialog state.
  if (await db.prepare("SELECT 1 FROM admin_ui_events WHERE event_key=?").bind(key).first()) return true;
  if (callback) {
    const recent = /^au:r:(-[1-9][0-9]*):([1-9][0-9]*)$/.exec(callback.data ?? "");
    if (recent && Number.isSafeInteger(Number(recent[1])) && Number.isSafeInteger(Number(recent[2]))) {
      const notice = await db.prepare(`SELECT reply_markup FROM notices WHERE campaign_id=? AND chat_id=? AND sent_message_id=?
        AND state='SENT' AND created_at>? AND reply_markup IS NOT NULL ORDER BY created_at DESC LIMIT 1`)
        .bind(config.campaignId, ctx.chat, callback.message!.message_id, now - lifetime).first<{ reply_markup: string }>();
      const markup = notice ? JSON.parse(notice.reply_markup) as ReplyMarkup : undefined;
      if (markup && "inline_keyboard" in markup && markup.inline_keyboard.flat().some(b => b.callback_data === callback.data))
        await openRecord(ctx, Number(recent[1]), Number(recent[2]));
      else await commit(ctx, "STALE_RECENT", expired);
      return true;
    }
    const match = /^au:([ec]):([a-f0-9]{32})$/.exec(callback.data ?? "");
    const session = match ? await db.prepare(`SELECT * FROM admin_sessions WHERE id=? AND campaign_id=? AND actor_id=? AND private_chat_id=?`)
      .bind(match[2], config.campaignId, ctx.actor, ctx.chat).first<Session>() : null;
    if (!session || !["VIEW", "AMOUNT", "REASON"].includes(session.state)) {
      await commit(ctx, "STALE_CALLBACK", expired); return true;
    }
    if (match![1] === "c") await cancel(ctx, session);
    else await commit(ctx, "EDIT", `Ответьте на это сообщение новым числом от 0 до ${config.maxAmount}. Для отмены — /cancel.`, {
      session: session.id, guard: combine(sessionGuard(ctx, session), { sql: "?='VIEW'", values: [session.state] }), markup: forceReply,
      mutations: gate => [db.prepare(`UPDATE admin_sessions SET state='AMOUNT',prompt_key=? WHERE id=? AND (${gate.sql})`)
        .bind(`ui:${key}`, session.id, ...gate.values)],
    });
    return true;
  }
  const text = (message!.text ?? "").trim();
  const command = text.split(/\s+/)[0]?.split("@")[0];
  if (command === "/cancel") { await cancel(ctx); return true; }
  if (command === "/recent") {
    const rows = await db.prepare(`SELECT source_chat_id,message_id,local_day,effective_amount,source_state FROM contributions
      WHERE campaign_id=? ORDER BY original_date DESC,source_chat_id,message_id DESC LIMIT 20`).bind(config.campaignId)
      .all<Pick<Contribution, "source_chat_id" | "message_id" | "local_day" | "effective_amount" | "source_state">>();
    await commit(ctx, "RECENT", rows.results.length ? "Последние накопления (по дате исходного сообщения):\n" + rows.results.map((r, i) =>
      `${i + 1}. ${r.local_day}: ${r.effective_amount} (${stateText(r.source_state)}) · ${r.source_chat_id}/${r.message_id}`).join("\n") : "Накоплений пока нет.", {
      markup: rows.results.length ? { inline_keyboard: rows.results.map((r, i) => [{ text: `${i + 1}. ${r.effective_amount} · ${r.local_day}`,
        callback_data: `au:r:${r.source_chat_id}:${r.message_id}` }]) } : undefined,
    }); return true;
  }
  if (text.startsWith("/")) return false;
  const link = parseMessageLink(text);
  if (link) {
    const chatId = link.chatId ?? await resolveTelegramGroup(token, link.username!);
    const alias = chatId === null ? null : await db.prepare("SELECT 1 FROM chat_aliases WHERE chat_id=? AND campaign_id=?")
      .bind(chatId, config.campaignId).first();
    if (!alias) await commit(ctx, "INVALID_CHAT", "Ссылка не подтверждена как сообщение разрешённой группы. Проверьте ссылку или используйте /recent.");
    else await openRecord(ctx, chatId!, link.messageId);
    return true;
  }
  const session = await db.prepare(`SELECT * FROM admin_sessions WHERE campaign_id=? AND actor_id=? AND private_chat_id=?
    AND state IN ('AMOUNT','REASON') ORDER BY created_at DESC LIMIT 1`)
    .bind(config.campaignId, ctx.actor, ctx.chat).first<Session>();
  if (session) { await receiveValue(ctx, message!, session); return true; }
  if (text && !text.startsWith("/")) {
    await commit(ctx, "LINK_REQUIRED", "Пришлите ссылку на сообщение группы (https://t.me/имя/номер или https://t.me/c/номер/номер), либо выберите накопление через /recent. Пересылка не заменяет ссылку."); return true;
  }
  return false;
}
