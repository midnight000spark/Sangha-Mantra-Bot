import { beforeEach, describe, expect, test } from "bun:test";
import { adjust, importContribution, ingest, inspect, totals } from "../src/core";
import { initialize } from "../src/config";
import { parseAmount } from "../src/parser";
import type { ContributionEvent } from "../src/types";
import { createTestDb, testConfig as config } from "./db";

let db: D1Database;
const originalDate = Date.parse("2026-11-10T10:00:00Z") / 1000;
let sequence = 0;
function event(amount: number, extra: Partial<ContributionEvent> = {}): ContributionEvent {
  const id = ++sequence;
  return {key:`event-${id}`,updateId:id,chatId:-1001,messageId:id,userId:7,
    originalDate,versionDate:originalDate,isEdit:false,amount,state:"VALID",reason:null,now:originalDate*1000,...extra};
}
beforeEach(async () => { db = await createTestDb(); await initialize(db,config); sequence = 0; });


test("3108 acceptance, redelivery, equal amounts and source chat keys", async () => {
  const a = event(1000);
  await ingest(db,config,a); await ingest(db,config,event(2000)); await ingest(db,config,event(108));
  expect((await totals(db,config.campaignId)).total).toBe("3108");
  await ingest(db,config,a);
  expect((await totals(db,config.campaignId)).total).toBe("3108");
  await ingest(db,config,event(1000));
  expect((await totals(db,config.campaignId)).total).toBe("4108");
  await ingest(db,config,event(108,{chatId:-1002,messageId:a.messageId}));
  expect((await totals(db,config.campaignId)).total).toBe("4216");
});

test("edit before original, stale versions, and update ID reset", async () => {
  const initial = event(1000);
  await ingest(db,config,event(2000,{messageId:initial.messageId,isEdit:true,versionDate:originalDate+10}));
  expect((await ingest(db,config,initial)).outcome).toBe("IGNORED_STALE");
  await ingest(db,config,event(3000,{messageId:initial.messageId,isEdit:true,versionDate:originalDate+8*86400,updateId:1}));
  expect((await totals(db,config.campaignId)).total).toBe("3000");
  expect((await inspect(db,-1001,initial.messageId))!.local_day).toBe("2026-11-10");
});

test("number to text to number changes same row and audit exactly", async () => {
  const a = event(1000); await ingest(db,config,a);
  await ingest(db,config,event(0,{messageId:a.messageId,state:"INVALID",isEdit:true,versionDate:originalDate+1}));
  expect((await totals(db,config.campaignId)).total).toBe("0");
  await ingest(db,config,event(108,{messageId:a.messageId,isEdit:true,versionDate:originalDate+2}));
  expect((await totals(db,config.campaignId)).total).toBe("108");
  expect((await totals(db,config.campaignId)).messages).toBe(1);
  const rows = await db.prepare("SELECT old_amount,new_amount FROM event_log ORDER BY rowid").all();
  expect(rows.results).toEqual([{old_amount:0,new_amount:1000},{old_amount:1000,new_amount:0},{old_amount:0,new_amount:108}]);
});

test("same-second conflicts are quarantined for both delivery orders", async () => {
  for (const amounts of [[108,216],[216,108]]) {
    const id = ++sequence;
    await Promise.all(amounts.map(amount => ingest(db,config,event(amount,{messageId:id,isEdit:true,versionDate:originalDate+1}))));
    expect((await inspect(db,-1001,id))!.source_state).toBe("REVIEW");
    expect((await inspect(db,-1001,id))!.effective_amount).toBe(0);
    await ingest(db,config,event(324,{messageId:id,isEdit:true,versionDate:originalDate+2}));
    expect((await inspect(db,-1001,id))!.effective_amount).toBe(324);
  }
});

test("duplicate old event never replays an earlier APPLIED decision", async () => {
  const first = event(108); await ingest(db,config,first);
  await ingest(db,config,event(216,{messageId:first.messageId,isEdit:true,versionDate:originalDate+1}));
  await ingest(db,config,first);
  expect((await inspect(db,-1001,first.messageId))!.effective_amount).toBe(216);
  expect((await db.prepare("SELECT COUNT(*) n FROM event_log").first<{n:number}>())!.n).toBe(2);
});

test("original date mismatch does not move a contribution into another day", async () => {
  const first = event(108); await ingest(db,config,first);
  await ingest(db,config,event(216,{messageId:first.messageId,isEdit:true,originalDate:originalDate+86400,versionDate:originalDate+86400}));
  const row = (await inspect(db,-1001,first.messageId))!;
  expect(row.source_state).toBe("REVIEW"); expect(row.local_day).toBe("2026-11-10");
});

test("override survives source edits, release uses latest source, retry cannot undo newer admin action", async () => {
  const first = event(108); await ingest(db,config,first);
  const correction = {key:"admin1",actorId:42,chatId:-1001,messageId:first.messageId,amount:500,reason:"Сверено с участником",now:Date.now()};
  await adjust(db,config,correction);
  await ingest(db,config,event(216,{messageId:first.messageId,isEdit:true,versionDate:originalDate+1}));
  expect((await inspect(db,-1001,first.messageId))!.effective_amount).toBe(500);
  await adjust(db,config,{...correction,key:"admin2",amount:null});
  await adjust(db,config,correction);
  expect((await inspect(db,-1001,first.messageId))!.effective_amount).toBe(216);
  expect((await db.prepare("SELECT COUNT(*) n FROM admin_adjustments").first<{n:number}>())!.n).toBe(2);
});

test("cannot silently release unresolved same-second conflict", async () => {
  await ingest(db,config,event(108,{messageId:1,isEdit:true}));
  await ingest(db,config,event(216,{messageId:1,isEdit:true}));
  await expect(adjust(db,config,{key:"release",actorId:42,chatId:-1001,messageId:1,amount:null,reason:"test",now:Date.now()})).rejects.toThrow("unresolved");
});

test("failed batch rolls back both ledger and source", async () => {
  await db.exec(`CREATE TRIGGER injected_failure BEFORE INSERT ON contributions BEGIN SELECT RAISE(ABORT,'test disk failure'); END;`);
  await expect(ingest(db,config,event(108))).rejects.toThrow();
  expect((await db.prepare("SELECT COUNT(*) n FROM event_log").first<{n:number}>())!.n).toBe(0);
  expect((await totals(db,config.campaignId)).total).toBe("0");
});

test("independent inputs and concurrent edits cannot double count", async () => {
  const first = event(108); await ingest(db,config,first);
  const edits = [5,3,10,7,2].map(n => event(n*108,{messageId:first.messageId,isEdit:true,versionDate:originalDate+n}));
  await Promise.all([...edits,...edits].map(e => ingest(db,config,e)));
  expect((await totals(db,config.campaignId)).total).toBe("1080");
});

test("goal records first crossing and counting continues", async () => {
  await ingest(db,config,event(1_000_000)); await ingest(db,config,event(108));
  expect((await totals(db,config.campaignId)).total).toBe("1000108");
  expect((await db.prepare("SELECT goal_reached_at FROM campaigns").first<{goal_reached_at:number}>())!.goal_reached_at).toBe(originalDate*1000);
});

test("manual recovery import keeps source key and audit, repeated key is safe", async () => {
  const input = {key:"import",actorId:42,chatId:-1001,messageId:900,amount:108,originalDate,reason:"Сверено по экспорту Telegram",now:Date.now()};
  await importContribution(db,config,input); await importContribution(db,config,input);
  await importContribution(db,config,{...input,messageId:901});
  expect((await totals(db,config.campaignId)).total).toBe("108");
  expect((await totals(db,config.campaignId)).messages).toBe(1);
  await expect(importContribution(db,config,{...input,key:"other"})).rejects.toThrow("already exists");
});

test("before campaign start is durable rejection with no contribution", async () => {
  const earlier = Date.parse("2026-10-31T10:00:00Z") / 1000;
  expect((await ingest(db,config,event(108,{originalDate:earlier,versionDate:earlier}))).outcome).toBe("REJECTED");
  expect((await totals(db,config.campaignId)).messages).toBe(0);
});
