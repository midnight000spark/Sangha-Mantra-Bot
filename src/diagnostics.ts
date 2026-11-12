/** Whitelisted structural metadata only. Never includes text, names, tokens or full payloads. */
export function telegramEnvelopeSummary(value: unknown) {
  const obj = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null ? v as Record<string,unknown> : {};
  const raw=obj(value);
  const type=["message","edited_message","callback_query","my_chat_member","channel_post","edited_channel_post"]
    .find(key=>raw[key]!==undefined) ?? "other";
  const body=obj(raw[type]);
  const chat=obj(body.chat ?? obj(body.message).chat);
  const from=obj(body.from);
  const id=(v:unknown)=>Number.isSafeInteger(v) ? v as number : null;
  return {type,updateId:id(raw.update_id),chatId:id(chat.id),
    chatType:["private","group","supergroup","channel"].includes(String(chat.type))?chat.type as string:null,
    messageId:id(body.message_id),hasText:typeof body.text==="string",senderPresent:body.from!==undefined,
    senderIsBot:typeof from.is_bot==="boolean"?from.is_bot:null,hasSenderChat:body.sender_chat!==undefined,
    forwarded:body.forward_origin!==undefined || body.forward_date!==undefined || body.is_automatic_forward===true};
}
