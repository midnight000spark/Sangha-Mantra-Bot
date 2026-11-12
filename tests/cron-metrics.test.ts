import {expect,test} from "bun:test";
import {cronMetrics} from "../scripts/cron-metrics";
import {safeCronEvents} from "../scripts/cron-telemetry";
const target={accountId:"local",workerName:"sangha-mantra-bot-test",versionId:"local-version",from:"2026-11-12T00:16:39Z",to:"2026-11-12T00:25:00Z"};
const schema={data:{row:{fields:["cron","status","cpuTimeUs","scheduledDatetime"].map(name=>({name,description:"microseconds"}))},
  filter:{inputFields:["scriptName","datetime_geq","datetime_leq"].map(name=>({name}))}}};
test("scheduled CPU uses its own dataset and verified units, without HTTP percentiles",async()=>{
  const queries:string[]=[];
  const result=await cronMetrics(async query=>{
    queries.push(query);
    return queries.length===1 ? schema : {data:{viewer:{accounts:[{workersInvocationsScheduled:[{cron:"*/5 * * * *",status:"success",cpuTimeUs:3210,scheduledDatetime:"2026-11-12T00:20:00Z",privateField:"ignored"}]}]}}};
  },target);
  expect(result.available).toBe(true);expect(result.rows?.[0]).toEqual({cron:"*/5 * * * *",status:"success",cpuTimeUs:3210,scheduledDatetime:"2026-11-12T00:20:00Z"});
  expect(result.cpuFieldDescription).toBe("microseconds");expect(queries[1]).toContain("workersInvocationsScheduled");
  expect(queries[1]).not.toContain("workersInvocationsAdaptive");expect(queries[1]).toContain("datetime_geq");
});
test("missing scheduled schema is missing coverage, never fabricated zero CPU",async()=>{
  const result=await cronMetrics(async()=>({data:{}}),target);expect(result.available).toBe(false);expect(result.rows).toBeUndefined();
});
test("invocation projection keeps only scheduled metrics for the named version and strips raw private fields",()=>{
  const worker={scriptName:target.workerName,eventType:"scheduled",scriptVersion:{id:target.versionId},cpuTimeMs:3.5,outcome:"ok",event:{secret:"do-not-print"}};
  const rows=safeCronEvents([{timestamp:1,$workers:worker,source:{private:"do-not-print"}},
    {$workers:{...worker,eventType:"fetch"}},{$workers:{...worker,scriptName:"other"}},{$workers:{...worker,scriptVersion:{id:"old"}}},
    {timestamp:2,$workers:{...worker,cpuTimeMs:undefined}}],target.workerName,target.versionId);
  expect(rows).toHaveLength(2);expect(rows[0]!.cpuTimeMs).toBe(3.5);expect(rows[1]!.cpuTimeMs).toBeNull();
  expect(JSON.stringify(rows)).not.toContain("do-not-print");
});
