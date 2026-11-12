type Post = (path:string,body:unknown)=>Promise<{status:number;data:any}>;

/** No raw log payload, request headers, URLs or messages leave the user-terminal process. */
export function safeCronEvents(events:any[], workerName:string, versionId:string) {
  return events.flatMap(event=>{
    const source=typeof event.source==="object" ? event.source : {};
    const worker=event.$workers ?? source.$workers ?? {};
    if(worker.scriptName!==workerName || !["scheduled","cron"].includes(worker.eventType)) return [];
    if(worker.scriptVersion?.id && worker.scriptVersion.id!==versionId) return [];
    return [{timestamp:event.timestamp,eventType:worker.eventType,versionId:worker.scriptVersion?.id ?? null,
      outcome:worker.outcome ?? null,cpuTimeMs:typeof worker.cpuTimeMs==="number"&&Number.isFinite(worker.cpuTimeMs) ? worker.cpuTimeMs : null,
      wallTimeMs:typeof worker.wallTimeMs==="number" ? worker.wallTimeMs : null}];
  });
}

export async function cronTelemetry(post:Post,target:{workerName:string;versionId:string;from:string;to:string}) {
  const timeframe={from:Date.parse(target.from),to:Date.parse(target.to)};
  const scope={key:"$metadata.service",operation:"eq",type:"string",value:target.workerName};
  const keys=await post("keys",{timeframe,filters:[scope]});
  if(keys.status!==200 || !Array.isArray(keys.data.result)) return {available:false,httpStatus:keys.status};
  const names=keys.data.result.map((v:any)=>v.key);
  if(!names.includes("$workers.eventType")) return {available:false,reason:"Scheduled event key not present",keysCount:names.length};
  const response=await post("query",{queryId:"sangha-test-cron-cpu",dry:true,view:"events",limit:100,timeframe,
    parameters:{filterCombination:"and",filters:[scope,{key:"$workers.eventType",operation:"in",type:"string",value:"scheduled,cron"}]}});
  if(response.status!==200 || response.data.success===false) return {available:false,httpStatus:response.status};
  const raw=response.data.result?.events?.events;
  if(!Array.isArray(raw)) return {available:false,reason:"Invocation response unavailable"};
  const rows=safeCronEvents(raw,target.workerName,target.versionId);
  return {available:true,source:"Cloudflare Workers Observability invocation events",cpuUnit:"milliseconds",rows,
    emptyCoverage:rows.length===0,missingCpu:rows.filter(row=>row.cpuTimeMs===null).length,truncatedPossible:raw.length===100};
}
