import { expect, test } from "bun:test";
import { telegramEnvelopeSummary } from "../src/diagnostics";

test("diagnostics expose only whitelisted structural metadata, including send-as and forwarded contexts",()=>{
  const metadata=telegramEnvelopeSummary({update_id:77,message:{message_id:22,chat:{id:-1001,type:"supergroup",title:"private title"},
    from:{id:777,is_bot:false,first_name:"private name"},sender_chat:{id:-2001,title:"private sender"},text:"secret-token-123456",forward_origin:{type:"channel"}}});
  expect(metadata).toEqual({type:"message",updateId:77,chatId:-1001,chatType:"supergroup",messageId:22,hasText:true,senderPresent:true,
    senderIsBot:false,hasSenderChat:true,forwarded:true});
  const text=JSON.stringify(metadata);
  for(const privateValue of ["private title","private name","private sender","secret-token-123456"]) expect(text).not.toContain(privateValue);
});

test("diagnostics distinguish channels and malformed envelopes without storing arbitrary field values",()=>{
  expect(telegramEnvelopeSummary({update_id:1,channel_post:{message_id:12,chat:{id:-1001,type:"channel"},text:"1000"}}).type).toBe("channel_post");
  expect(telegramEnvelopeSummary(null).type).toBe("other");
  expect(telegramEnvelopeSummary({message:{chat:{type:"secret-value"}}}).chatType).toBeNull();
});
