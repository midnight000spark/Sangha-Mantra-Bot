const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const clockFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timezone, formatter);
  }
  return formatter;
}

/** Validate each configured zone once per isolate, sharing the calendar formatter. */
export function validateTimezone(timezone: string): void {
  dateFormatter(timezone); // Invalid zones still throw before entering the cache.
}

/** Telegram timestamps and returned boundaries use seconds; wall-clock arguments use ms. */
export function localDay(epochSeconds: number, timezone: string): string {
  const formatter = dateFormatter(timezone);
  const parts = formatter.formatToParts(new Date(epochSeconds * 1000));
  return `${parts.find((part) => part.type === "year")!.value}-${parts.find((part) => part.type === "month")!.value}-${parts.find((part) => part.type === "day")!.value}`;
}

/** Arithmetic on calendar labels, never adding 24 hours to a zoned instant. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** First instant in each local day, including zones whose DST transition is at midnight. */
export function dayBounds(day: string, timezone: string): { start: number; end: number } {
  const boundaries = [day, addDays(day, 1)].map((label) => {
    const utcMidnight = Date.parse(`${label}T00:00:00Z`) / 1000;
    let low = utcMidnight - 36 * 3600;
    let high = utcMidnight + 36 * 3600;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (localDay(middle, timezone) < label) low = middle + 1;
      else high = middle;
    }
    return low;
  });
  return { start: boundaries[0]!, end: boundaries[1]! };
}

export function latestReportDay(nowMs: number, timezone: string, reportTime: string): string {
  let formatter = clockFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    clockFormatters.set(timezone, formatter);
  }
  const localTime = formatter.format(new Date(nowMs));
  return addDays(localDay(nowMs / 1000, timezone), localTime >= reportTime ? -1 : -2);
}
