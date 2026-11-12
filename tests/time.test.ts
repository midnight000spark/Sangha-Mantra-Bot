import { describe, expect, test } from "bun:test";
import { addDays, dayBounds, latestReportDay, localDay } from "../src/time";

describe("calendar days", () => {
  test("original Telegram date belongs to its local day", () => {
    expect(localDay(Date.parse("2026-11-10T21:00:00Z") / 1000, "Europe/Moscow")).toBe("2026-11-11");
    expect(localDay(Date.parse("2026-11-10T20:59:59Z") / 1000, "Europe/Moscow")).toBe("2026-11-10");
  });

  test("Moscow midnight is UTC 21:00", () => {
    expect(dayBounds("2026-11-10", "Europe/Moscow")).toEqual({
      start: Date.parse("2026-11-09T21:00:00Z") / 1000,
      end: Date.parse("2026-11-10T21:00:00Z") / 1000,
    });
  });

  test.each([
    ["2026-03-08", "America/New_York", 23],
    ["2026-11-01", "America/New_York", 25],
    ["2026-03-29", "Europe/Berlin", 23],
    ["2026-10-25", "Europe/Berlin", 25],
    ["2026-03-08", "America/Havana", 23],
  ])("%s in %s has %s hours", (day, timezone, hours) => {
    const { start, end } = dayBounds(day as string, timezone as string);
    expect(end - start).toBe(Number(hours) * 3600);
    expect(localDay(start, timezone as string)).toBe(day);
    expect(localDay(end - 1, timezone as string)).toBe(day);
    expect(localDay(end, timezone as string)).toBe(addDays(day as string, 1));
  });

  test("report cutoff uses local wall clock and keeps older days eligible", () => {
    expect(latestReportDay(Date.parse("2026-11-10T21:04:59Z"), "Europe/Moscow", "00:05")).toBe("2026-11-09");
    expect(latestReportDay(Date.parse("2026-11-10T21:05:00Z"), "Europe/Moscow", "00:05")).toBe("2026-11-10");
    expect(latestReportDay(Date.parse("2026-03-09T04:05:00Z"), "America/New_York", "00:05")).toBe("2026-03-08");
  });

  test("calendar arithmetic crosses leap days and years", () => {
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
