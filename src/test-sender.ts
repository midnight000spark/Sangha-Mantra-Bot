import type { Config } from "./types";
import type { TelegramMessage } from "./telegram";

/** Called only after initialize() has verified the actual D1 deployment identity. */
export function isTestSender(config: Config, message: Pick<TelegramMessage, "chat" | "from">, privateAdmin = false) {
  const sender = config.testSender;
  return Boolean(config.deployment?.environment === "test" && sender && message.from?.is_bot
    && message.from.id === sender.botId && sender.botId !== config.deployment.botId
    && (privateAdmin
      ? message.chat.type === "private" && message.chat.id === sender.botId && config.adminIds.includes(sender.botId)
      : ["group", "supergroup"].includes(message.chat.type) && message.chat.id === sender.chatId
        && config.allowedChatIds.includes(sender.chatId)));
}
