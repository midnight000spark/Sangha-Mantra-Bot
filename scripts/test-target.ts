/** Nonsecret target manifest / enrollment SQL. Does not perform any cloud operation. */
export function describeTestTarget(config: {env:{test:{name:string;vars:Record<string,string>;d1_databases:{binding:string;database_name:string;database_id:string}[]}}}, local=false) {
  const test = config.env.test;
  const db = test.d1_databases[0];
  const v = test.vars;
  const botId = local ? "123456" : v.EXPECTED_BOT_ID;
  if (test.name !== "sangha-mantra-bot-test" || v.DEPLOYMENT_ENV !== "test" || test.d1_databases.length !== 1
    || db?.binding !== "DB" || db.database_name !== "sangha-mantra-test"
    || v.EXPECTED_D1_ID !== db.database_id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(db.database_id)
    || (!local && /^00000000-/.test(db.database_id)) || !/^[1-9][0-9]*$/.test(botId ?? "")
    || !/^sangha-test(?:-[a-z0-9-]+)?$/.test(v.CAMPAIGN_ID ?? "")
    || !/^-[1-9][0-9]*$/.test(v.ALLOWED_CHAT_IDS ?? "") || v.ALLOWED_CHAT_IDS !== v.REPORT_CHAT_ID
    || !/^[1-9][0-9]*(?:,[1-9][0-9]*)*$/.test(v.ADMIN_IDS ?? "")
    || [botId,v.ALLOWED_CHAT_IDS,...v.ADMIN_IDS!.split(",")].some(id => !Number.isSafeInteger(Number(id))))
    throw new Error("TEST target contains placeholders, multiple source chats, or an unapproved name/identity");
  // Only the synthetic local bot is enrolled here. Remote cutoff always needs separate operator verification.
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  if(local && (!Number.isSafeInteger(Number(v.GOAL)) || Number(v.GOAL)<=0)) throw new Error("Invalid local goal");
  const localIntakeSql = local ? `
INSERT INTO campaigns(id,timezone,start_day,goal,report_chat_id) VALUES(${quote(v.CAMPAIGN_ID!)},${quote(v.TIMEZONE!)},${quote(v.CAMPAIGN_START!)},${Number(v.GOAL)},${v.REPORT_CHAT_ID}) ON CONFLICT(id) DO NOTHING;
INSERT INTO chat_aliases(chat_id,campaign_id) VALUES(${v.ALLOWED_CHAT_IDS},${quote(v.CAMPAIGN_ID!)}) ON CONFLICT(chat_id) DO NOTHING;
INSERT INTO automatic_intake_boundaries(campaign_id,chat_id,first_message_id,reason,approved_by,created_at) VALUES(${quote(v.CAMPAIGN_ID!)},${v.ALLOWED_CHAT_IDS},1,'Synthetic local messages only',123456,1) ON CONFLICT(campaign_id,chat_id) DO NOTHING;` : "";
  return {environment:"test",workerName:test.name,databaseName:db.database_name,databaseId:db.database_id,
    campaignId:v.CAMPAIGN_ID,botId:Number(botId),sourceChatIds:v.ALLOWED_CHAT_IDS,reportChatId:v.REPORT_CHAT_ID,
    enrollmentSql:`INSERT INTO deployment_identity(singleton,environment,database_id,campaign_id,bot_id,source_chat_ids,report_chat_id) VALUES(1,'test','${db.database_id}','${v.CAMPAIGN_ID}',${botId},'${v.ALLOWED_CHAT_IDS}',${v.REPORT_CHAT_ID}) ON CONFLICT(singleton) DO NOTHING;${localIntakeSql}`};
}
if(import.meta.main) {
  const args = Bun.argv.slice(2);
  if(args.some(v=>!["--local","--sql"].includes(v))) throw new Error("Use --local and/or --sql only");
  const target=describeTestTarget(await Bun.file("wrangler.jsonc").json(),args.includes("--local"));
  console.log(args.includes("--sql") ? target.enrollmentSql : JSON.stringify(target,null,2));
}
