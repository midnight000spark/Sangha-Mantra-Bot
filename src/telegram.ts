export type ReplyMarkup =
  | { inline_keyboard: { text: string; callback_data: string }[][] }
  | { force_reply: true; selective?: boolean };

export type SendResult =
  | { state: "SENT"; messageId: number }
  | { state: "FAILED_KNOWN"; error: string; retryAfterSeconds?: number }
  | { state: "UNCERTAIN"; error: string };

/** Each call is a single attempt. A lost response is never safe to retry blindly. */
export async function sendTelegramMessage(
  token: string,
  chatId: string | number,
  text: string,
  replyToMessageId?: number,
  replyMarkup?: ReplyMarkup,
): Promise<SendResult> {
  if (!token) return { state: "FAILED_KNOWN", error: "BOT_TOKEN is not configured" };
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        link_preview_options: { is_disabled: true },
        ...(replyToMessageId === undefined ? {} : {
          reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true },
        }),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload: unknown = await response.json();
    if (typeof payload === "object" && payload !== null && "ok" in payload) {
      if (payload.ok === true && "result" in payload && typeof payload.result === "object"
        && payload.result !== null && "message_id" in payload.result
        && typeof payload.result.message_id === "number" && Number.isSafeInteger(payload.result.message_id) && payload.result.message_id > 0) {
        return { state: "SENT", messageId: payload.result.message_id };
      }
      if (payload.ok === false && "error_code" in payload && typeof payload.error_code === "number"
        && payload.error_code >= 400 && payload.error_code < 500 && response.status < 500) {
        // Deliberately do not persist remote descriptions, which may contain sensitive input.
        const parameters = "parameters" in payload && typeof payload.parameters === "object" && payload.parameters !== null
          ? payload.parameters as Record<string, unknown> : {};
        return {
          state: "FAILED_KNOWN",
          error: `Telegram rejected the request (${payload.error_code})`,
          ...(payload.error_code === 429 && Number.isSafeInteger(parameters.retry_after) && (parameters.retry_after as number) > 0
            ? { retryAfterSeconds: parameters.retry_after as number } : {}),
        };
      }
    }
    return { state: "UNCERTAIN", error: `Unrecognized Telegram response (HTTP ${response.status})` };
  } catch {
    // Timeout, disconnect, malformed JSON: Telegram may already have published it.
    return { state: "UNCERTAIN", error: "Telegram response was not received or could not be verified" };
  }
}

import type { TextEntity } from "./parser";

export interface TelegramMessage {
  message_id: number;
  date: number;
  edit_date?: number;
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
  from?: { id: number; is_bot: boolean };
  text?: string;
  entities?: TextEntity[];
  reply_to_message_id?: number;
  sender_chat?: unknown;
  forward_origin?: unknown;
  forward_date?: unknown;
  is_automatic_forward?: boolean;
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
  service: boolean;
}

export interface TelegramCallback {
  id: string;
  from: { id: number; is_bot: boolean };
  data?: string;
  message?: { message_id: number; chat: TelegramMessage["chat"] };
}

export interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallback;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  my_chat_member?: {
    chat: { id: number; type: string };
    date: number;
    new_chat_member: { status: string; can_send_messages?: boolean };
  };
}

/** Validate the untrusted Telegram boundary once; everything inward is typed. */
export function parseTelegramUpdate(value: unknown): TelegramUpdate | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.update_id) || (raw.update_id as number) < 0) return null;
  const update: TelegramUpdate = { update_id: raw.update_id as number };
  if ([raw.message, raw.edited_message, raw.my_chat_member, raw.callback_query].filter(v => v !== undefined).length > 1) return null;
  for (const key of ["message", "edited_message"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "object" || raw[key] === null) return null;
    const msg = raw[key] as Record<string, unknown>;
    if (!Number.isSafeInteger(msg.message_id) || (msg.message_id as number) <= 0
      || !Number.isSafeInteger(msg.date) || (msg.date as number) <= 0
      || (msg.edit_date !== undefined && (!Number.isSafeInteger(msg.edit_date) || (msg.edit_date as number) < (msg.date as number)))
      || (key === "edited_message" && msg.edit_date === undefined)
      || typeof msg.chat !== "object" || msg.chat === null) return null;
    const chat = msg.chat as Record<string, unknown>;
    if (!Number.isSafeInteger(chat.id) || chat.id === 0 || !["private", "group", "supergroup", "channel"].includes(String(chat.type))) return null;
    if (msg.text !== undefined && (typeof msg.text !== "string" || msg.text.length > 16_384)) return null;
    let entities: TextEntity[] | undefined;
    if (msg.entities !== undefined) {
      if (!Array.isArray(msg.entities) || msg.entities.length > 1000 || typeof msg.text !== "string") return null;
      entities = [];
      for (const entity of msg.entities) {
        if (typeof entity !== "object" || entity === null || typeof entity.type !== "string"
          || !Number.isSafeInteger(entity.offset) || entity.offset < 0
          || !Number.isSafeInteger(entity.length) || entity.length <= 0
          || entity.offset + entity.length > msg.text.length) return null;
        entities.push({ type: entity.type, offset: entity.offset, length: entity.length });
      }
    }
    let from: TelegramMessage["from"];
    if (msg.from !== undefined) {
      if (typeof msg.from !== "object" || msg.from === null) return null;
      const sender = msg.from as Record<string, unknown>;
      if (!Number.isSafeInteger(sender.id) || (sender.id as number) <= 0 || typeof sender.is_bot !== "boolean") return null;
      from = { id: sender.id as number, is_bot: sender.is_bot };
    }
    for (const migration of ["migrate_to_chat_id", "migrate_from_chat_id"] as const) {
      if (msg[migration] !== undefined && (!Number.isSafeInteger(msg[migration]) || (msg[migration] as number) >= 0)) return null;
    }
    let replyId: number | undefined;
    if (msg.reply_to_message !== undefined) {
      if (typeof msg.reply_to_message !== "object" || msg.reply_to_message === null) return null;
      const reply = msg.reply_to_message as Record<string, unknown>;
      if (!Number.isSafeInteger(reply.message_id) || (reply.message_id as number) <= 0) return null;
      replyId = reply.message_id as number;
    }
    const service = ["new_chat_members", "left_chat_member", "new_chat_title", "new_chat_photo", "delete_chat_photo",
      "group_chat_created", "supergroup_chat_created", "channel_chat_created", "message_auto_delete_timer_changed",
      "pinned_message", "forum_topic_created", "forum_topic_edited", "forum_topic_closed", "forum_topic_reopened",
      "video_chat_scheduled", "video_chat_started", "video_chat_ended", "video_chat_participants_invited",
      "migrate_to_chat_id", "migrate_from_chat_id"].some(field => msg[field] !== undefined);
    update[key] = {
      message_id: msg.message_id as number,
      date: msg.date as number,
      ...(msg.edit_date === undefined ? {} : { edit_date: msg.edit_date as number }),
      chat: { id: chat.id as number, type: chat.type as TelegramMessage["chat"]["type"] },
      from,
      ...(msg.text === undefined ? {} : { text: msg.text as string }),
      ...(entities === undefined ? {} : { entities }),
      sender_chat: msg.sender_chat,
      forward_origin: msg.forward_origin,
      forward_date: msg.forward_date,
      is_automatic_forward: msg.is_automatic_forward === true,
      migrate_to_chat_id: msg.migrate_to_chat_id as number | undefined,
      migrate_from_chat_id: msg.migrate_from_chat_id as number | undefined,
      ...(replyId === undefined ? {} : { reply_to_message_id: replyId }),
      service,
    };
  }
  if (raw.callback_query !== undefined) {
    if (typeof raw.callback_query !== "object" || raw.callback_query === null) return null;
    const query = raw.callback_query as Record<string, unknown>;
    if (typeof query.id !== "string" || !query.id || query.id.length > 256
      || typeof query.from !== "object" || query.from === null
      || (query.data !== undefined && (typeof query.data !== "string" || new TextEncoder().encode(query.data).length > 64))) return null;
    const from = query.from as Record<string, unknown>;
    if (!Number.isSafeInteger(from.id) || (from.id as number) <= 0 || typeof from.is_bot !== "boolean") return null;
    const callback: TelegramCallback = { id: query.id, from: { id: from.id as number, is_bot: from.is_bot },
      ...(query.data === undefined ? {} : { data: query.data as string }) };
    if (query.message !== undefined) {
      if (typeof query.message !== "object" || query.message === null) return null;
      const msg = query.message as Record<string, unknown>;
      if (!Number.isSafeInteger(msg.message_id) || (msg.message_id as number) <= 0
        || typeof msg.chat !== "object" || msg.chat === null) return null;
      const chat = msg.chat as Record<string, unknown>;
      if (!Number.isSafeInteger(chat.id) || chat.id === 0
        || !["private", "group", "supergroup", "channel"].includes(String(chat.type))) return null;
      callback.message = { message_id: msg.message_id as number,
        chat: { id: chat.id as number, type: chat.type as TelegramMessage["chat"]["type"] } };
    }
    update.callback_query = callback;
  }
  if (raw.my_chat_member !== undefined) {
    if (typeof raw.my_chat_member !== "object" || raw.my_chat_member === null) return null;
    const member = raw.my_chat_member as Record<string, unknown>;
    if (!Number.isSafeInteger(member.date) || (member.date as number) <= 0
      || typeof member.chat !== "object" || member.chat === null
      || typeof member.new_chat_member !== "object" || member.new_chat_member === null) return null;
    const chat = member.chat as Record<string, unknown>;
    const status = member.new_chat_member as Record<string, unknown>;
    if (!Number.isSafeInteger(chat.id) || chat.id === 0 || typeof chat.type !== "string"
      || (status.can_send_messages !== undefined && typeof status.can_send_messages !== "boolean")
      || !["creator", "administrator", "member", "restricted", "left", "kicked"].includes(String(status.status))) return null;
    update.my_chat_member = {
      chat: { id: chat.id as number, type: chat.type },
      date: member.date as number,
      new_chat_member: { status: status.status as string, can_send_messages: status.can_send_messages as boolean | undefined },
    };
  }
  return update;
}

/** Read-only resolution of a public message link; never fetch the user-supplied URL. */
export async function resolveTelegramGroup(token: string, username: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: `@${username}` }), signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json() as { ok?: boolean; result?: { id?: number; type?: string; username?: string } };
    const chat = payload.result;
    return response.ok && payload.ok === true && chat && Number.isSafeInteger(chat.id) && chat.id! < 0
      && ["group", "supergroup"].includes(chat.type ?? "") && chat.username?.toLowerCase() === username.toLowerCase()
      ? chat.id! : null;
  } catch { return null; }
}

/** Best effort acknowledgement only; no ledger effects and no raw remote errors. */
export async function answerTelegramCallback(token: string, id: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: id }), signal: AbortSignal.timeout(5_000),
    });
  } catch { /* The committed dialog/outbox remains available even after an expired callback. */ }
}
