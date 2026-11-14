import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { deliverNotices, enqueueNotice, handleAdmin, notifyOperators } from "../src/admin";
import type { Config } from "../src/types";
import { setTestSilence, testConfig } from "./db";

const now = Date.parse("2026-11-10T21:05:00Z");
const denied = "Administrator access revoked before notice delivery";

/** Interleave at the real statement boundary, retaining the underlying SQL/claim semantics. */
function atFinalGate(db: D1Database, action: () => Promise<unknown>, afterRead = false): D1Database {
  let used = false;
  return new Proxy(db, { get(target, property) {
    if (property !== "prepare") {
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (sql: string) => {
      const original = target.prepare(sql);
      if (!sql.includes("SELECT 1 FROM notices WHERE")) return original;
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(s, p) {
        if (p === "bind") return (...values: (string | number | null)[]) => wrap(s.bind(...values));
        if (p === "first") return async () => {
          if (used) return s.first();
          used = true;
          if (afterRead) { const row = await s.first(); await action(); return row; }
          await action(); return s.first();
        };
        const value = Reflect.get(s, p);
        return typeof value === "function" ? value.bind(s) : value;
      } });
      return wrap(original);
    };
  } });
}

export function noticeAuthorizationCases(label: string, open: () => Promise<{ db: D1Database; close?: () => Promise<void> }>) {
  let db: D1Database;
  let close: (() => Promise<void>) | undefined;
  let config: Config;
  let sends: { chat_id: number; text: string }[];
  let network: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  beforeEach(async () => {
    ({ db, close } = await open());
    config = { ...testConfig, adminIds: [42] };
    sends = [];
    network = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
      const { chat_id, text } = JSON.parse(String(init?.body));
      sends.push({ chat_id, text });
      return Response.json({ ok: true, result: { message_id: 100 + sends.length } });
    }) as typeof fetch);
  });
  afterEach(async () => { network?.mockRestore(); await close?.(); });
  const run = (name: string, fn: () => Promise<void>) => test(`${label} ${name}`, fn, 30_000);
  const row = (key = "admin:queued") => db.prepare("SELECT state,last_error,sent_message_id,claim_token,claimed_at,publication_hold FROM notices WHERE notice_key=?").bind(key).first();
  const audits = async () => (await db.prepare("SELECT kind,source_chat_id,detail FROM operational_events WHERE kind='NOTICE_AUTH_DENIED'").all()).results;
  const deliver = (at = now) => deliverNotices(db, config, "local-dummy-token", at);
  const queue = (key = "admin:queued", chat = 42) => enqueueNotice(db, config, key, chat, "sensitive fixture body", now);
  const command = (key: string, at: number, date = at / 1000) => handleAdmin(db, config, {
    service: false, message_id: at - now, date, chat: { id: 43, type: "private" },
    from: { id: 43, is_bot: false }, text: "/notice_retry admin:queued Checked absent",
  }, key, at);

  for (const prefix of ["admin:", "ui:", "alert:"]) {
    run(`F03 ${prefix} queued then revoked: no send, durable denial, no automatic replay`, async () => {
      const key = `${prefix}queued`;
      await queue(key);
      config = { ...config, adminIds: [43] }; // New invocation configuration, not enqueue-time authority.
      await deliver();
      expect(sends).toEqual([]);
      expect(await row(key)).toEqual({ state: "FAILED_KNOWN", last_error: denied, sent_message_id: null,
        claim_token: null, claimed_at: null, publication_hold: 0 });
      expect(await audits()).toEqual([{ kind: "NOTICE_AUTH_DENIED", source_chat_id: 42,
        detail: JSON.stringify({ noticeKey: key, reason: "ADMIN_ACCESS_REVOKED" }) }]);
      await deliver(now + 600_000);
      config.adminIds = [42, 43];
      await deliver(now + 900_000); // Regrant alone cannot release FAILED_KNOWN.
      expect(sends).toEqual([]);
      expect(await audits()).toHaveLength(1);
    });

    run(`${prefix} retained administrator receives one response with concurrent senders`, async () => {
      await queue(`${prefix}queued`);
      await Promise.all([deliver(), deliver()]);
      await deliver(now + 600_000);
      expect(sends).toEqual([{ chat_id: 42, text: "sensitive fixture body" }]);
      expect((await row(`${prefix}queued`))?.state).toBe("SENT");
      expect(await audits()).toEqual([]);
    });
  }

  run("operator-generated alert uses the same final authorization", async () => {
    await db.prepare("INSERT INTO bot_membership VALUES(-1001,?,'kicked',0,?,?)").bind(config.campaignId, now, now).run();
    await notifyOperators(db, config, now);
    config.adminIds = [43];
    await deliver();
    expect(sends).toEqual([]);
    expect(await db.prepare("SELECT state FROM notices WHERE notice_key LIKE 'alert:%'").first("state")).toBe("FAILED_KNOWN");
    expect(await audits()).toHaveLength(1);
  });

  run("concurrent revoked senders record a single denial", async () => {
    await queue(); config.adminIds = [43];
    await Promise.all([deliver(), deliver()]);
    expect(sends).toEqual([]);
    expect((await row())?.state).toBe("FAILED_KNOWN");
    expect(await audits()).toHaveLength(1);
  });

  for (const afterRead of [false, true]) run(`revocation ${afterRead ? "after" : "before"} final D1 read is checked before transport`, async () => {
    await queue();
    const controlled = atFinalGate(db, async () => { config.adminIds = [43]; }, afterRead);
    await deliverNotices(controlled, config, "local-dummy-token", now);
    expect(sends).toEqual([]);
    expect((await row())?.state).toBe("FAILED_KNOWN");
  });

  run("authorization exception fails closed and expired claim requires inspection", async () => {
    await queue();
    Object.defineProperty(config, "adminIds", { get() { throw new Error("authorization unavailable"); } });
    await expect(deliver()).rejects.toThrow("authorization unavailable");
    expect(sends).toEqual([]);
    expect((await row())?.state).toBe("SENDING");
    await deliver(now + 300_001);
    expect((await row())?.state).toBe("UNCERTAIN");
    expect(await audits()).toEqual([]);
  });

  run("final D1 SQL failure never grants send and lease expiry never retries", async () => {
    await queue();
    const controlled = atFinalGate(db, () => db.prepare("SELECT * FROM missing_authorization_gate").first());
    await expect(deliverNotices(controlled, config, "local-dummy-token", now)).rejects.toThrow();
    expect(sends).toEqual([]);
    expect((await row())?.state).toBe("SENDING");
    await deliver(now + 300_001);
    expect((await row())?.state).toBe("UNCERTAIN");
    expect(sends).toEqual([]);
  });

  for (const failure of ["audit", "state"]) run(`denial batch ${failure} failure rolls back state and audit without sending`, async () => {
    await queue(); config.adminIds = [43];
    await db.prepare(failure === "audit"
      ? `CREATE TRIGGER fail_denial BEFORE INSERT ON operational_events WHEN NEW.kind='NOTICE_AUTH_DENIED'
          BEGIN SELECT RAISE(ABORT,'synthetic denial audit failure'); END`
      : `CREATE TRIGGER fail_denial BEFORE UPDATE ON notices WHEN NEW.state='FAILED_KNOWN'
          BEGIN SELECT RAISE(ABORT,'synthetic denial state failure'); END`).run();
    await expect(deliver()).rejects.toThrow();
    expect(sends).toEqual([]);
    expect((await row())?.state).toBe("SENDING");
    expect(await audits()).toEqual([]);
    await db.prepare("DROP TRIGGER fail_denial").run();
    await deliver(now + 300_001);
    expect((await row())?.state).toBe("UNCERTAIN");
    expect(sends).toEqual([]);
  });

  run("lost claim cannot send or record denial for another owner", async () => {
    await queue(); config.adminIds = [43];
    const controlled = atFinalGate(db, () => db.prepare("UPDATE notices SET claim_token='other-owner' WHERE notice_key='admin:queued'").run());
    await deliverNotices(controlled, config, "local-dummy-token", now);
    expect(sends).toEqual([]);
    expect((await row())?.state).toBe("SENDING");
    expect((await row())?.claim_token).toBe("other-owner");
    expect(await audits()).toEqual([]);
  });

  run("denial occurs before payload parsing and audit omits body and markup", async () => {
    await queue(); config.adminIds = [43];
    await db.prepare("UPDATE notices SET reply_markup='invalid sensitive markup' WHERE notice_key='admin:queued'").run();
    await deliver();
    expect(sends).toEqual([]);
    expect((await row())?.state).toBe("FAILED_KNOWN");
    expect(JSON.stringify(await audits())).not.toContain("sensitive");
  });

  run("ordinary participant private and group notices bypass admin authority", async () => {
    await queue("participant:queued", 77); await queue("rejected:-1001:7", -1001);
    Object.defineProperty(config, "adminIds", { get() { throw new Error("must not check participant authority"); } });
    await deliver(); await deliver();
    expect(sends.map(s => s.chat_id).sort((a, b) => a - b)).toEqual([-1001, 77]);
    expect(await audits()).toEqual([]);
  });

  run("silent holds survive OFF; explicit release retains delivery and revoked-admin denial", async () => {
    await setTestSilence(db, config, true, 42, "on", now - 2);
    await queue("held-group", -1001); await queue();
    config.adminIds = [43];
    await deliver();
    expect(sends).toEqual([]);
    expect((await row("held-group"))?.publication_hold).toBe(1);
    await setTestSilence(db, config, false, 43, "off", now + 1);
    await deliver(now + 2);
    expect(sends).toEqual([]);
    await handleAdmin(db, config, { service: false, message_id: 8, date: (now + 3000) / 1000,
      chat: { id: 43, type: "private" }, from: { id: 43, is_bot: false }, text: "/notice_retry held-group Checked absent" }, "release", now + 3000);
    await deliver(now + 3001); await deliver(now + 3002);
    expect(sends.filter(s => s.chat_id < 0)).toHaveLength(1);
    expect(sends.filter(s => s.chat_id === 42)).toEqual([]);
    expect((await row())?.state).toBe("FAILED_KNOWN");
    expect(await audits()).toHaveLength(1);
  });

  run("UNCERTAIN admin delivery remains uncertain after revoke and silence cycle", async () => {
    await queue();
    network.mockImplementation((async () => { throw new Error("lost transport response"); }) as unknown as typeof fetch);
    await deliver();
    expect((await row())?.state).toBe("UNCERTAIN");
    config.adminIds = [43];
    await setTestSilence(db, config, true, 43, "on", now + 1);
    await setTestSilence(db, config, false, 43, "off", now + 2);
    await deliver(now + 600_000);
    expect(network).toHaveBeenCalledTimes(1);
    expect((await row())?.state).toBe("UNCERTAIN");
    expect(await audits()).toEqual([]);
  });

  run("recovery rejects stale release; explicit retry rechecks recipient; regrant needs fresh release", async () => {
    await queue(); config.adminIds = [43]; await deliver();
    await db.prepare("INSERT INTO recovery_state(campaign_id,restored_at,backup_at,reason) VALUES(?,?,?,'Synthetic restore')")
      .bind(config.campaignId, now + 1000, now).run();
    await command("stale-release", now + 5000, now / 1000);
    expect((await row())?.state).toBe("FAILED_KNOWN");
    await command("fresh-release", now + 6000);
    expect((await row())?.state).toBe("PENDING");
    for (let i = 0; i < 3; i++) await deliver(now + 7000 + i);
    expect((await row())?.state).toBe("FAILED_KNOWN");
    expect(sends.filter(s => s.chat_id === 42)).toEqual([]);
    expect(await audits()).toHaveLength(2);
    config.adminIds = [42, 43];
    await command("regranted-release", now + 8000);
    for (let i = 0; i < 3; i++) await deliver(now + 9000 + i);
    expect((await row())?.state).toBe("SENT");
    expect(sends.filter(s => s.chat_id === 42)).toHaveLength(1);
  });

  run("already authorized transport can complete after revoke (external API boundary)", async () => {
    await queue();
    network.mockImplementation((async () => {
      config.adminIds = [43]; // Request has already crossed the final authorization boundary.
      return Response.json({ ok: true, result: { message_id: 777 } });
    }) as unknown as typeof fetch);
    await deliver();
    expect(network).toHaveBeenCalledTimes(1);
    expect((await row())?.state).toBe("SENT");
    expect(await audits()).toEqual([]);
  });
}
