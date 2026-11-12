type SchemaField = {name:string;description?:string};
type Graphql = (query:string) => Promise<any>;

/** Read-only dedicated scheduled dataset, verified against the live provider schema. */
export async function cronMetrics(graphql:Graphql, target:{accountId:string;workerName:string;versionId:string;from:string;to:string}) {
  const schema=await graphql(`{ row: __type(name:"AccountWorkersInvocationsScheduled") { fields { name description } }
    filter: __type(name:"AccountWorkersInvocationsScheduledFilter_InputObject") { inputFields { name } } }`);
  const fields:SchemaField[]=schema.data?.row?.fields ?? [];
  const filters:SchemaField[]=schema.data?.filter?.inputFields ?? [];
  const names=fields.map(f=>f.name), filterNames=filters.map(f=>f.name);
  const time=filterNames.includes("datetime_geq")&&filterNames.includes("datetime_leq") ? "datetime" : "scheduledDatetime";
  if(schema.errors?.length || !["cron","status","cpuTimeUs","scheduledDatetime"].every(f=>names.includes(f))
    || !["scriptName",`${time}_geq`,`${time}_leq`].every(f=>filterNames.includes(f)))
    return {available:false,reason:"Scheduled schema needs review",fields:names,filters:filterNames};
  const versionFilter=filterNames.includes("scriptVersion") ? `,scriptVersion:${JSON.stringify(target.versionId)}` : "";
  const versionField=names.includes("scriptVersion") ? "scriptVersion" : "";
  const query=`{ viewer { accounts(filter:{accountTag:${JSON.stringify(target.accountId)}}) {
    workersInvocationsScheduled(limit:100,filter:{scriptName:${JSON.stringify(target.workerName)},
      ${time}_geq:${JSON.stringify(target.from)},${time}_leq:${JSON.stringify(target.to)}${versionFilter}}) {
      cron status cpuTimeUs scheduledDatetime ${versionField}
    }
  } } }`;
  const data=await graphql(query);
  const raw=data.data?.viewer?.accounts?.[0]?.workersInvocationsScheduled;
  if(data.errors?.length || !Array.isArray(raw)) return {available:false,reason:"Scheduled query unavailable"};
  const rows=raw.map(row=>({cron:String(row.cron),status:String(row.status),cpuTimeUs:Number(row.cpuTimeUs),
    scheduledDatetime:String(row.scheduledDatetime),...(versionField ? {scriptVersion:String(row.scriptVersion)} : {})}));
  if(rows.some(row=>!Number.isFinite(row.cpuTimeUs)||row.cpuTimeUs<0)) throw new Error("Invalid scheduled CPU data");
  return {available:true,source:"Cloudflare GraphQL workersInvocationsScheduled",rows,
    cpuFieldDescription:fields.find(f=>f.name==="cpuTimeUs")?.description ?? null,
    versionFilterApplied:!!versionFilter,emptyCoverage:rows.length===0,truncatedPossible:rows.length===100};
}
