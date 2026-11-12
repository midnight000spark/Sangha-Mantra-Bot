import { expect, test } from "bun:test";
import { parseAmount } from "../src/parser";

for (const [text, amount] of [
  ["1000",1000], ["1000🙏",1000], ["Сегодня 1000!",1000], ["Начитал 108 мантр 🙏",108],
  ["Всем привет, накопил 2500",2500], ["\t108\r\n",108], ["\u00a0108\u00a0",108],
  ["Сегодня: 1000.",1000], ["(108)",108], ["🙏🏽 108 🧘‍♀️",108], ["Мне 35 лет",35],
  ["@user123 сегодня 108",108], ["https://example.org/1000 108",108], ["`1000` 108",108],
] as const) test(`one standalone amount: ${text}`, () => {
  expect(parseAmount(text,1_000_000)).toMatchObject({kind:"ONE_VALID",state:"VALID",amount,reason:null});
});

for (const text of [undefined,"","Привет всем","🙏","https://example.org/1000","www.example.org/1000",
  "example.org/1000","@user1000","user1000@example.org","`1000`","```ts\n1000\n```","/override -1001 1 108 причина"])
  test(`no count in ordinary or excluded context: ${text}`, () => {
    expect(parseAmount(text,1_000_000)).toMatchObject({kind:"NO_NUMBER",amount:0,reason:null});
  });

for (const text of ["1000 и ещё 2000","Сегодня 108, вчера 500","2 раза по 108","1000;2000"])
  test(`ambiguity: ${text}`, () => { expect(parseAmount(text,1_000_000)).toMatchObject({kind:"AMBIGUOUS",amount:0}); });

for (const text of ["-100","- 100","− 100","–100","+108","+ 108","0","01","1.5",".5","1 000","1\u00a0000",
  "1\u202f000","1,000","1.000","1\n000","2026-11-12","12/11/2026","12:30","+7 (999) 123-45-67",
  "1000001","9007199254740993","99999999999999999999999999999999999999999","١٠٨","１０８","108мантр","abc1000","1000abc","1️⃣"])
  test(`unsafe format rejected as a whole: ${text}`, () => {
    const parsed = parseAmount(text,1_000_000);
    expect(parsed.state).toBe("INVALID"); expect(parsed.amount).toBe(0); expect(parsed.kind).not.toBe("NO_NUMBER");
  });

test("Telegram entity offsets use UTF-16 and exclude hidden links/code, not surrounding text", () => {
  expect(parseAmount("🙏 1000 108",1_000_000,[{type:"text_link",offset:3,length:4}]).amount).toBe(108);
  for (const type of ["text_link","code","pre","url","mention","text_mention","email"])
    expect(parseAmount("1000",1_000_000,[{type,offset:0,length:4}]).kind).toBe("NO_NUMBER");
  expect(parseAmount("1000",1_000_000,[{type:"bold",offset:0,length:4}]).amount).toBe(1000);
  expect(parseAmount("xx1000",1_000_000,[{type:"code",offset:0,length:2}]).amount).toBe(0);
});

test("one malformed numeric expression retains a warning rather than being mistaken for separate quantities",()=>{
  for(const text of ["1.5","1010.5","1,000","1.000","12/11/2026","-1.5"])
    expect(parseAmount(text,1_000_000)).toMatchObject({kind:"INVALID_NUMERIC",amount:0,multipleNumbers:false});
});

test("multiple independent quantities stay quiet even if one has an invalid fractional format",()=>{
  for(const text of ["1000 и 2000","1.5 и 108","1000, 2000","1000 2000","2 раза по 108","1 000"])
    expect(parseAmount(text,1_000_000)).toMatchObject({amount:0,multipleNumbers:true});
});
