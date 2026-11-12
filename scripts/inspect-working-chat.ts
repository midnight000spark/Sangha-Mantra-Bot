import {telegram,verifiedTestBot} from "./test-safety";

async function main() {
  process.umask(0o077);
  const username=Bun.argv[2];
  if(!username||!/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) throw new Error();
  const bot=await verifiedTestBot();
  const chat=await telegram<{id:number;type:string;title?:string;username?:string;linked_chat_id?:number}>(bot.token,"getChat",{chat_id:username});
  let membership:string|null=null;
  try {membership=(await telegram<{status:string}>(bot.token,"getChatMember",{chat_id:chat.id,user_id:bot.botId})).status;} catch { /* Not a membership proof. */ }
  const result={checkedAt:new Date().toISOString(),readOnly:true,botId:bot.botId,botUsername:bot.username,
    chatId:chat.id,type:chat.type,title:chat.title,username:chat.username,linkedChatId:chat.linked_chat_id??null,botMembership:membership,
    groupCandidate:["group","supergroup"].includes(chat.type)};
  await Bun.write(".secrets/working-chat.json",JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}
if(import.meta.main) main().catch(()=>{console.error("Working chat lookup failed; no credentials or token-bearing URLs are logged");process.exitCode=1;});
