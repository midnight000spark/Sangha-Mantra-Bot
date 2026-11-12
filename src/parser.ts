export interface TextEntity { type: string; offset: number; length: number }
export type NumericKind = "NO_NUMBER" | "ONE_VALID" | "AMBIGUOUS" | "INVALID_NUMERIC";

/** Deterministic grammar, no digit stripping or locale guesses. Offsets are UTF-16, as in Telegram. */
export function parseAmount(text: string | undefined, maxAmount: number, entities: TextEntity[] = []) {
  let multipleNumbers = false;
  const result = (kind: NumericKind, reason: string | null = null, amount = 0) => ({
    kind, amount, multipleNumbers, state: kind === "ONE_VALID" ? "VALID" as const : "INVALID" as const, reason,
  });
  if (!text || /^\s*\//u.test(text)) return result("NO_NUMBER");
  const excluded = new Set(["url", "text_link", "code", "pre", "mention", "text_mention", "email", "bot_command"]);
  // Replace spans with a non-boundary sentinel: masking must not make an attached number standalone.
  const chars = text.split("");
  for (const entity of entities) {
    if (excluded.has(entity.type)) chars.fill("\uFFFD", entity.offset, entity.offset + entity.length);
  }
  const value = chars.join("")
    .replace(/```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$)/gu, match => "\uFFFD".repeat(match.length))
    .replace(/(?:[\p{L}][\p{L}\d+.-]*:\/\/|www\.)[^\s<>]+|[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_.-]+|@[\p{L}\p{N}_]+|(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:\/[^\s<>]*)?/gu,
      match => "\uFFFD".repeat(match.length));
  const numbers = [...value.matchAll(/\p{N}+/gu)];
  // A malformed numeric expression (1.5 / 1,000) is one attempted amount,
  // not two independent practice quantities. Keep its warning outside silence.
  // Separate quantities, including whitespace-separated ones, stay quiet.
  multipleNumbers = [...value.matchAll(/\p{N}+(?:[.,:/\\−–—-]\p{N}+)*/gu)].length > 1;
  if (!numbers.length) return result("NO_NUMBER");
  const invalid = () => result("INVALID_NUMERIC", "Не учтено: напишите одно целое положительное количество без знака и разделителей, например 108.");
  // Decimals, dates, telephone and grouped thousands are unsupported as a whole.
  if (/\p{N}[.,:/\\−–—-]\s*\p{N}|\p{N}[\s\u00a0\u202f]+\p{N}/u.test(value)) return invalid();
  if (numbers.length !== 1) return result("AMBIGUOUS", "Не учтено: в сообщении несколько чисел. Напишите одно количество за сессию.");
  const number = numbers[0]!;
  const start = number.index!;
  const before = value.slice(0, start);
  const after = value.slice(start + number[0].length);
  if (!/^[1-9][0-9]*$/.test(number[0])
    || /[\p{L}\p{N}_\uFFFD]$/u.test(before) || /^[\p{L}\p{N}_\uFFFD]/u.test(after)
    || /[+\-−–—]\s*$/u.test(before)
    || /(?:^|\s)[.,]$/u.test(before) || /^[\uFE0F]?\u20E3/u.test(after)) return invalid();
  const amount = Number(number[0]);
  if (!Number.isSafeInteger(amount) || amount > maxAmount) {
    return result("INVALID_NUMERIC", `Не учтено: число больше допустимого предела ${maxAmount}. Обратитесь к ответственному за учёт.`);
  }
  return result("ONE_VALID", null, amount);
}

export async function eventKey(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
