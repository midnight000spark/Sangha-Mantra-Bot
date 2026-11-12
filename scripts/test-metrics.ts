import { resolve } from "node:path";
import { describeTestTarget } from "./test-target";
import { deploymentWindow } from "./metrics-window";
import { cronMetrics } from "./cron-metrics";
import { cronTelemetry } from "./cron-telemetry";
import { productionTarget } from "./production-ops";

/** User-terminal only: OAuth stays in child/process memory and is never logged or saved. */
async function main() {
  process.umask(0o077);
  const args=Bun.argv.slice(2);
  if(args.length>3 || new Set(args).size!==args.length || args.some(arg=>!["--since-deploy","--cron","--production"].includes(arg))) throw new Error();
  const sinceDeploy=args.includes("--since-deploy");
  if(args.includes("--cron")&&!sinceDeploy) throw new Error();
  const production=args.includes("--production");
  if(production&&!sinceDeploy) throw new Error();
  const environment=production ? "production" : "test";
  const config=await Bun.file("wrangler.jsonc").json();
  const target=production ? productionTarget(config) : describeTestTarget(config);
  const outputDirectory=production ? "test-results/production" : "test-results/live";
  let receipt: {accountId:string;databaseId:string;versionId:string};
  if(production) {
    const p=Bun.spawn([process.execPath,resolve("node_modules/wrangler/bin/wrangler.js"),"deployments","list","--env",environment,"--json"],{stdout:"pipe",stderr:"pipe"});
    const [code,raw]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
    if(code!==0) throw new Error();
    const deployments=JSON.parse(raw).sort((a:any,b:any)=>Date.parse(b.created_on)-Date.parse(a.created_on));
    receipt={accountId:config.env.production.account_id,databaseId:target.databaseId,versionId:deployments[0]?.versions?.[0]?.version_id};
    deploymentWindow(deployments,receipt.versionId);
  } else receipt=await Bun.file(".secrets/test-deployment.json").json();
  if(config.env[environment].account_id!==receipt.accountId || target.databaseId!==receipt.databaseId) throw new Error();
  const child=Bun.spawn([process.execPath,resolve("node_modules/wrangler/bin/wrangler.js"),"auth","token","--env",environment,"--json"],{
    stdout:"pipe",stderr:"pipe",env:{...process.env,CLOUDFLARE_ACCOUNT_ID:receipt.accountId,WRANGLER_SEND_METRICS:"false"},
  });
  const [code,raw]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  if(code!==0) throw new Error();const auth=JSON.parse(raw);
  if(!["oauth","api_token"].includes(auth.type) || typeof auth.token!=="string") throw new Error();
  async function currentWindow() {
    const child=Bun.spawn([process.execPath,resolve("node_modules/wrangler/bin/wrangler.js"),"deployments","list","--env",environment,"--json"],{
      stdout:"pipe",stderr:"pipe",env:{...process.env,CLOUDFLARE_ACCOUNT_ID:receipt.accountId,WRANGLER_SEND_METRICS:"false"},
    });
    const [code,raw]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    if(code!==0) throw new Error();
    return deploymentWindow(JSON.parse(raw),receipt.versionId);
  }
  const window=sinceDeploy ? await currentWindow() : null;
  const from=window?.from ?? (await Bun.file("test-results/live/version-initial.json").json()).metadata.created_on;
  const to=window?.to ?? new Date().toISOString();
  if(args.includes("--cron")) {
    const result=await cronMetrics(async query=>{
      const response=await fetch("https://api.cloudflare.com/client/v4/graphql",{
        method:"POST",headers:{Authorization:`Bearer ${auth.token}`,"Content-Type":"application/json"},
        body:JSON.stringify({query}),signal:AbortSignal.timeout(20_000),
      });
      if(!response.ok) throw new Error();
      return response.json();
    },{accountId:receipt.accountId,workerName:target.workerName,versionId:window!.versionId,from,to});
    const invocations=result.emptyCoverage||!result.available ? await cronTelemetry(async(path,body)=>{
      const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${receipt.accountId}/workers/observability/telemetry/${path}`,{
        method:"POST",headers:{Authorization:`Bearer ${auth.token}`,"Content-Type":"application/json"},
        body:JSON.stringify(body),signal:AbortSignal.timeout(20_000),
      });
      return {status:response.status,data:await response.json()};
    },{workerName:target.workerName,versionId:window!.versionId,from,to}) : null;
    if((await currentWindow()).deploymentId!==window!.deploymentId) throw new Error();
    const output={worker:target.workerName,...window,...result,...(invocations ? {invocations} : {})};
    await Bun.write(`${outputDirectory}/cron-metrics-${window!.versionId}.json`,JSON.stringify(output,null,2));
    console.log(JSON.stringify(output));
    if(!result.available || result.emptyCoverage) {
      const hasInvocations=invocations?.available && "rows" in invocations && invocations.rows?.some(row=>row.cpuTimeMs!==null);
      if(!hasInvocations) process.exitCode=2; // Missing coverage is pending, never PASS.
    }
    return;
  }
  let descriptions:Record<string,string>={};
  let dimensionFields:string[]=[];
  try {
    const schemaResponse=await fetch("https://api.cloudflare.com/client/v4/graphql",{
      method:"POST",headers:{Authorization:`Bearer ${auth.token}`,"Content-Type":"application/json"},
      body:JSON.stringify({query:'{ quantiles: __type(name: "AccountWorkersInvocationsAdaptiveQuantiles") { fields { name description } } dimensions: __type(name: "AccountWorkersInvocationsAdaptiveDimensions") { fields { name } } }'}),
      signal:AbortSignal.timeout(20_000),
    });
    const schema=await schemaResponse.json() as {data?:{quantiles?:{fields?:{name:string;description:string}[]};dimensions?:{fields?:{name:string}[]}}};
    descriptions=Object.fromEntries((schema.data?.quantiles?.fields ?? []).filter(field=>["cpuTimeP50","cpuTimeP95","cpuTimeP99"].includes(field.name)).map(field=>[field.name,field.description]));
    dimensionFields=(schema.data?.dimensions?.fields ?? []).map(field=>field.name);
  } catch { /* Metrics remain raw if unit metadata is unavailable. */ }
  const withRequestSource=dimensionFields.includes("requestSource");
  const query=`query TestMetrics($accountTag: string, $scriptName: string, $from: string, $to: string) {
    viewer { accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(limit: 100, filter: {scriptName: $scriptName, datetime_geq: $from, datetime_leq: $to}) {
        dimensions {status ${withRequestSource ? "requestSource" : ""}} sum {requests errors subrequests} quantiles {cpuTimeP50 cpuTimeP95 cpuTimeP99}
      }
    } }
  }`;
  const response=await fetch("https://api.cloudflare.com/client/v4/graphql",{
    method:"POST",headers:{Authorization:`Bearer ${auth.token}`,"Content-Type":"application/json"},
    body:JSON.stringify({query,variables:{accountTag:receipt.accountId,scriptName:target.workerName,from,to}}),signal:AbortSignal.timeout(20_000),
  });
  const data=await response.json() as {errors?:unknown[];data?:{viewer?:{accounts?:{workersInvocationsAdaptive?: {dimensions?:{status?:string;requestSource?:string};sum?:{requests?:number;errors?:number;subrequests?:number};quantiles?:{cpuTimeP50?:number;cpuTimeP95?:number;cpuTimeP99?:number}}[]}[]}}};
  if(!response.ok || data.errors?.length) {
    console.error(`Worker metrics unavailable (HTTP ${response.status}); existing authorization may lack Analytics access. No permissions were changed.`);
    process.exitCode=1;return;
  }
  const rows=data.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  if(!Array.isArray(rows)) throw new Error();
  // Whitelist metric fields only, never write the auth object or remote error descriptions.
  const metrics=rows.map(row=>({status:String(row.dimensions?.status),...(withRequestSource ? {requestSource:String(row.dimensions?.requestSource)} : {}),requests:Number(row.sum?.requests),errors:Number(row.sum?.errors),
    subrequests:Number(row.sum?.subrequests),cpuTimeP50:Number(row.quantiles?.cpuTimeP50),cpuTimeP95:Number(row.quantiles?.cpuTimeP95),cpuTimeP99:Number(row.quantiles?.cpuTimeP99)}));
  // Refuse to label a comparison if traffic changed deployments during collection.
  if(window && (await currentWindow()).deploymentId!==window.deploymentId) throw new Error();
  const result={worker:target.workerName,from,to,rows:metrics,cpuFieldDescriptions:descriptions,source:"Cloudflare GraphQL workersInvocationsAdaptive",
    ...(window ? {versionId:window.versionId,deploymentId:window.deploymentId} : {}),
    includesInitialSetupWindow:!sinceDeploy,requestSourceBreakdown:withRequestSource,emptyCoverage:metrics.length===0};
  const output=window ? `${outputDirectory}/worker-metrics-${window.versionId}.json` : "test-results/live/worker-metrics.json";
  await Bun.write(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  if(result.emptyCoverage) process.exitCode=2;
}
if(import.meta.main) main().catch(()=>{console.error("Worker metrics unavailable; no credentials, auth output or remote error details are logged");process.exitCode=1;});
