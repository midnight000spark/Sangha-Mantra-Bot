import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { deliverNotices, enqueueNotice, handleAdmin } from "../src/admin";
import { adjust, ingest, inspect } from "../src/core";
import { parseAmount } from "../src/parser";
import { setTestSilence, testConfig as config } from "./db";

const now = Date.parse("2026-11-10T21:05:00Z");
const date = now / 1000 - 100;
const stale = "Source revision no longer confirms warning";

/** Deterministic statement interleaving, also used against real D1. */
export function sourceGate(db: D1Database, action: () => Promise<unknown>, afterRead = false): D1Database {
  let used = false;
  return new Proxy(db, { get(target, property) {
    if (property !== "prepare") {
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (sql: string) => {
      const original = target.prepare(sql);
      if (!sql.includes("SELECT 1 FROM notices WHERE")) return original;
      const wrap = (s: D1PreparedStatement): D1PreparedStatement => new Proxy(s, { get(stmt, p) {
        if (p === "bind") return (...v: (string | number | null)[]) => wrap(stmt.bind(...v));
        if (p === "first") return async () => {
          if (used) return stmt.first();
          used = true;
          if (afterRead) { const row = await stmt.first(); await action(); return row; }
          await action(); return stmt.first();
        };
        const value = Reflect.get(stmt, p);
        return typeof value === "function" ? value.bind(stmt) : value;
      } });
      return wrap(original);
    };
  } });
}

export function noticeSourceCases(label: string, open: () => Promise<{ db: D1Database; close?: () => Promise<void> }>) {
  let db: D1Database;
  let close: (() => Promise<void>) | undefined;
  let network: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  let sends: string[];
  beforeEach(async () => {
    ({ db, close } = await open()); sends = [];
    network = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
      sends.push(JSON.parse(String(init?.body)).text);
      return Response.json({ ok: true, result: { message_id: 901 } });
    }) as unknown as typeof fetch);
  });
  afterEach(async () => { network?.mockRestore(); await close?.(); });
  const run = (name: string, fn: () => Promise<void>) => test(`${label} ${name}`, fn, 30_000);
  const key = (revision: string) => `rejected:-1001:10:${revision}`;
  const row = (revision = "bad") => db.prepare("SELECT * FROM notices WHERE notice_key=?").bind(key(revision)).first();
  const deliver = (at = now) => deliverNotices(db, config, "synthetic-token", at);
  const event = (revision: string, text: string, version = date, isEdit = false, originalDate = date) => ({
    key: revision, updateId: 100, chatId: -1001, messageId: 10, userId: 77, originalDate,
    versionDate: version, isEdit, ...parseAmount(text, config.maxAmount), now,
  });
  const input = async (revision: string, text: string, version = date, isEdit = false, originalDate = date) => {
    const e = event(revision, text, version, isEdit, originalDate);
    await ingest(db, config, e);
    return e;
  };
  const queue = (revision = "bad", text = "warning:bad") => enqueueNotice(db, config, key(revision), -1001,
    text, now, 10, date * 1000, revision);
  const invalid = async () => { await input("bad", "-5"); await queue(); };
  const canceled = async () => {
    expect(sends).toEqual([]);
    expect((await row())?.state).toBe("FAILED_KNOWN");
    expect((await row())?.last_error).toBe(stale);
    expect((await row())?.sent_message_id).toBeNull();
    expect((await row())?.claim_token).toBeNull();
  };

  run("F05 invalid queued then valid edit suppresses stale warning", async () => {
    await invalid(); await input("good", "108", date + 1, true);
    expect((await inspect(db, -1001, 10))?.effective_amount).toBe(108);
    await deliver(); await canceled();
    await deliver(now + 600_000); await canceled();
  });
  run("unchanged invalid source delivers once with concurrent senders", async () => {
    await invalid(); await Promise.all([deliver(), deliver()]); await deliver(now + 600_000);
    expect(sends).toEqual(["warning:bad"]); expect((await row())?.state).toBe("SENT");
  });
  run("several revisions deliver only latest invalid intent", async () => {
    await invalid(); await input("good", "108", date + 1, true);
    await input("bad2", "1.5", date + 2, true); await queue("bad2", "warning:decimal");
    await deliver(); expect(sends).toEqual(["warning:decimal"]);
    expect((await row())?.state).toBe("FAILED_KNOWN"); expect((await row("bad2"))?.state).toBe("SENT");
  });
  run("duplicates and delayed originals cannot revive stale intent", async () => {
    await invalid(); await input("good", "108", date + 2, true);
    await input("bad", "-5"); await queue();
    await input("late", "-5"); await queue("late");
    await input("older-edit", "-5", date + 1, true); await queue("older-edit");
    await input("good-duplicate", "108", date + 2, true);
    await deliver(); await deliver(); expect(sends).toEqual([]);
    expect((await inspect(db, -1001, 10))?.last_event_key).toBe("good");
  });
  run("same-second edit outranks original; later conflict requires current review warning", async () => {
    await invalid(); await input("same-second", "108", date, true);
    await deliver(); await canceled();
    await input("conflict", "-5", date, true); await queue("conflict", "warning:review");
    await deliver(); expect(sends).toEqual(["warning:review"]);
    expect((await inspect(db, -1001, 10))?.source_state).toBe("REVIEW");
  });
  run("already sent warning retains existing once-per-message behavior across later invalid edits", async () => {
    await invalid(); await deliver();
    await input("bad2", "1.5", date + 1, true); await queue("bad2", "warning:decimal");
    await deliver(); expect(sends).toEqual(["warning:bad"]); expect(await row("bad2")).toBeNull();
  });
  run("edit to conversation suppresses warning without number parser changes", async () => {
    await invalid(); await input("conversation", "спасибо", date + 1, true); await deliver(); await canceled();
  });
  run("explicit override zero suppresses invalid-source warning", async () => {
    await invalid(); await adjust(db, config, { key: "override", actorId: 42, chatId: -1001, messageId: 10,
      amount: 0, reason: "checked", now });
    await deliver(); await canceled();
  });
  run("original date mismatch cannot authorize numeric warning", async () => {
    await invalid(); await input("wrong-date", "-5", date + 2, true, date + 1);
    await queue("wrong-date"); await deliver(); expect(sends).toEqual([]);
  });
  for (const afterRead of [false, true]) run(`edit ${afterRead ? "after" : "before"} final read documents TOCTOU`, async () => {
    await invalid();
    await deliverNotices(sourceGate(db, () => input("good", "108", date + 1, true), afterRead), config, "synthetic-token", now);
    if (afterRead) { expect(sends).toEqual(["warning:bad"]); expect((await row())?.state).toBe("SENT"); }
    else await canceled();
  });
  run("SQL failure at final gate fails closed; lease becomes UNCERTAIN", async () => {
    await invalid();
    const controlled = sourceGate(db, () => db.prepare("SELECT * FROM missing_source_gate_table").first());
    await expect(deliverNotices(controlled, config, "synthetic-token", now)).rejects.toThrow();
    expect(sends).toEqual([]); expect((await row())?.state).toBe("SENDING");
    await deliver(now + 300_001); expect((await row())?.state).toBe("UNCERTAIN"); expect(sends).toEqual([]);
  });
  for (const failure of ["audit", "state"]) run(`stale cancellation ${failure} SQL failure rolls back and sends nothing`, async () => {
    await invalid(); await input("good", "108", date + 1, true);
    await db.prepare(failure === "audit"
      ? "CREATE TRIGGER fail_source BEFORE INSERT ON operational_events WHEN NEW.kind='NOTICE_SOURCE_STALE' BEGIN SELECT RAISE(ABORT,'source audit failure'); END"
      : "CREATE TRIGGER fail_source BEFORE UPDATE ON notices WHEN NEW.last_error='Source revision no longer confirms warning' BEGIN SELECT RAISE(ABORT,'source state failure'); END").run();
    await expect(deliver()).rejects.toThrow(); expect(sends).toEqual([]);
    expect((await row())?.state).toBe("SENDING");
    expect(await db.prepare("SELECT COUNT(*) n FROM operational_events WHERE kind='NOTICE_SOURCE_STALE'").first("n")).toBe(0);
    await db.prepare("DROP TRIGGER fail_source").run(); await deliver(now + 300_001);
    expect((await row())?.state).toBe("UNCERTAIN"); expect(sends).toEqual([]);
  });
  run("lost claim cannot send or cancel another owner", async () => {
    await invalid();
    await deliverNotices(sourceGate(db, () => db.prepare("UPDATE notices SET claim_token='other-owner' WHERE notice_key=?")
      .bind(key("bad")).run()), config, "synthetic-token", now);
    expect(sends).toEqual([]); expect((await row())?.state).toBe("SENDING");
    expect((await row())?.claim_token).toBe("other-owner");
  });
  run("silent hold survives OFF and explicit retry still rechecks corrected source", async () => {
    await setTestSilence(db, config, true, 42, "on", now - 2000); await invalid();
    await input("good", "108", date + 1, true); await deliver();
    expect((await row())?.publication_hold).toBe(1); expect((await row())?.state).toBe("PENDING");
    await setTestSilence(db, config, false, 42, "off", now + 1000); await deliver(); expect(sends).toEqual([]);
    await handleAdmin(db, config, { service: false, message_id: 100, date: now / 1000 + 2,
      chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false },
      text: `/notice_retry ${key("bad")} checked absent` }, "retry", now + 2000);
    await deliver(); expect(sends.filter(s => s.startsWith("warning:"))).toEqual([]);
    expect((await row())?.state).toBe("FAILED_KNOWN");
  });
  run("legacy unbound rejected notice is refused rather than guessed from key or time", async () => {
    await input("bad", "-5");
    await enqueueNotice(db, config, key("bad"), -1001, "warning:legacy", now, 10, date * 1000);
    await deliver(); await canceled();
  });
  run("genuinely invalid held warning still delivers after explicit release", async () => {
    await setTestSilence(db, config, true, 42, "on", now - 2000); await invalid();
    await setTestSilence(db, config, false, 42, "off", now + 1000); await deliver(); expect(sends).toEqual([]);
    await handleAdmin(db, config, { service: false, message_id: 100, date: now / 1000 + 2,
      chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false },
      text: `/notice_retry ${key("bad")} checked absent` }, "release-valid-warning", now + 2000);
    await deliver(); expect(sends.filter(s => s.startsWith("warning:"))).toEqual(["warning:bad"]);
    expect((await row())?.state).toBe("SENT");
  });
  run("concurrent stale senders record exactly one cancellation", async () => {
    await invalid(); await input("good", "108", date + 1, true);
    await Promise.all([deliver(), deliver()]); await canceled();
    expect(await db.prepare("SELECT COUNT(*) n FROM operational_events WHERE kind='NOTICE_SOURCE_STALE'").first("n")).toBe(1);
  });
  run("late enqueue after correction remains bound to the old event", async () => {
    await input("bad", "-5"); await input("good", "108", date + 1, true); await queue();
    await deliver(); await canceled();
  });
  run("same invalid contents in newer edit invalidate prior intent", async () => {
    await invalid(); await input("same-bad", "-5", date + 1, true); await queue("same-bad", "warning:current");
    await deliver(); expect(sends).toEqual(["warning:current"]); expect((await row())?.state).toBe("FAILED_KNOWN");
  });
  run("message route mismatch cannot borrow a valid source revision", async () => {
    await invalid(); await db.prepare("UPDATE notices SET reply_message_id=11 WHERE notice_key=?").bind(key("bad")).run();
    await deliver(); await canceled();
  });
  run("ingest rollback retains last confirmed invalid source", async () => {
    await invalid();
    await db.prepare("CREATE TRIGGER fail_ingest BEFORE UPDATE ON contributions BEGIN SELECT RAISE(ABORT,'ingest failed'); END").run();
    await expect(input("good", "108", date + 1, true)).rejects.toThrow();
    expect(await db.prepare("SELECT event_key FROM event_log WHERE event_key='good'").first()).toBeNull();
    await deliver(); expect(sends).toEqual(["warning:bad"]);
  });
  for (const outcome of ["FAILED_KNOWN", "UNCERTAIN"]) run(`${outcome} remains nonautomatic; manual retry rechecks source`, async () => {
    await invalid();
    network.mockImplementation((async () => {
      sends.push("first-attempt");
      if (outcome === "UNCERTAIN") throw new Error("lost response");
      return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 30 } });
    }) as unknown as typeof fetch);
    await deliver(); expect((await row())?.state).toBe(outcome);
    await input("good", "108", date + 1, true); await deliver(now + 600_000); expect(sends).toEqual(["first-attempt"]);
    await handleAdmin(db, config, { service: false, message_id: 101, date: now / 1000 + 601,
      chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false },
      text: `/notice_retry ${key("bad")} checked absent` }, "retry-after-failure", now + 601_000);
    // Ignore the unrelated admin response; the group warning must never reach transport again.
    network.mockImplementation((async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); if (body.chat_id < 0) sends.push(body.text);
      return Response.json({ ok: true, result: { message_id: 902 } });
    }) as typeof fetch);
    await deliver(now + 601_000); expect(sends).toEqual(["first-attempt"]);
    expect((await row())?.state).toBe("FAILED_KNOWN"); expect((await row())?.last_error).toBe(stale);
  });
}
