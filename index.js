const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!CHAT_ID) throw new Error("Falta CHAT_ID");
if (!BROWSERLESS_TOKEN) throw new Error("Falta BROWSERLESS_TOKEN");

const URL_OVER25 =
  "https://m.forebet.com/es/predicciones-para-hoy/predicciones-bajo-mas-2-5-goles";
const URL_BTTS =
  "https://m.forebet.com/es/predicciones-para-hoy/ambos-equipos-anotaran";

const RULES = {
  pollMs: 60000,
  over25: { minProb: 50, minMinuteExclusive: 30, scores: ["0-0","0-1","1-0"] },
  btts: { minProb: 50, minMinuteInclusive: 30, score: "0-0" }
};

const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (_,res)=>res.send("OK"));
app.listen(PORT, ()=>console.log("Web alive", PORT));

const bot = new Telegraf(BOT_TOKEN);
let watching = false;
let debug = false;
let debugChatId = null;
const alerted = new Set();

bot.start(ctx=>ctx.reply("✅ Bot listo\n/watch /stop /debugon /debugoff /status"));
bot.command("watch", ctx=>{watching=true; ctx.reply("🟢 ON");});
bot.command("stop", ctx=>{watching=false; ctx.reply("🔴 OFF");});
bot.command("status", ctx=>ctx.reply(`Estado: ${watching?"ACTIVO":"DETENIDO"}`));
bot.command("debugon", ctx=>{debug=true; debugChatId=ctx.chat.id; ctx.reply("🧪 Debug ON");});
bot.command("debugoff", ctx=>{debug=false; debugChatId=null; ctx.reply("Debug OFF");});

function dmsg(text){
  if(!debug) return;
  bot.telegram.sendMessage(debugChatId || CHAT_ID, text);
}

// Browserless: ejecuta JS en Chrome y devuelve HTML final
async function browserlessGetHtml(url){
  const endpoint = `https://chrome.browserless.io/content?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({
      url,
      gotoOptions: { waitUntil: "networkidle2", timeout: 60000 }
    })
  });

  if(!res.ok){
    const t = await res.text().catch(()=> "");
    throw new Error(`Browserless HTTP ${res.status} ${t.slice(0,120)}`);
  }
  return await res.text();
}

function norm(s){return String(s||"").replace(/\s+/g," ").trim();}
function parseScore(t){
  const m=t.match(/(\d{1,2})\s*-\s*(\d{1,2})(?=\s*\(|\s*$)/);
  return m?`${m[1]}-${m[2]}`:null;
}
function parseMinute(text){
  const scoreMatch=text.match(/(\d{1,2}\s*-\s*\d{1,2})/);
  if(!scoreMatch) return null;
  const left=text.slice(0,scoreMatch.index);
  const nums=[...left.matchAll(/(?<![\d.,])(\d{1,3})(?![\d.,])/g)]
    .map(m=>parseInt(m[1],10))
    .filter(n=>n>=1&&n<=130);
  return nums.length?nums[nums.length-1]:null;
}
function parseProb(text){
  const m=text.match(/(?<!\d)(\d{1,3})\s+(\d{1,3})(?!\d)/);
  if(!m) return null;
  return parseInt(m[2],10);
}
function scrape(html){
  const $=cheerio.load(html);
  const out=[];
  $("tr").each((_,tr)=>{
    const text=norm($(tr).text());
    if(!text) return;
    if(/Just a moment|verify you are human/i.test(text)) return;

    const prob=parseProb(text);
    const score=parseScore(text);
    const minute=parseMinute(text);
    if(prob===null || !score || minute===null) return;

    out.push({ minute, score, prob, raw: text.slice(0,120) });
  });
  return out;
}

function overMsg(m){
  return `🚨 OVER 2.5\nMin ${m.minute}'\nScore ${m.score}\nProb ${m.prob}%`;
}
function bttsMsg(m){
  return `🔥 BTTS\nMin ${m.minute}'\nScore ${m.score}\nProb ${m.prob}%`;
}

async function poll(){
  if(!watching) return;

  try{
    const htmlOver = await browserlessGetHtml(URL_OVER25);
    const over = scrape(htmlOver);
    dmsg(`DEBUG Over: parsed=${over.length}`);

    for(const m of over){
      if(m.prob >= RULES.over25.minProb &&
         m.minute > RULES.over25.minMinuteExclusive &&
         RULES.over25.scores.includes(m.score)){
        const key="O"+m.raw+m.minute+m.score+m.prob;
        if(alerted.has(key)) continue;
        alerted.add(key);
        await bot.telegram.sendMessage(CHAT_ID, overMsg(m));
      }
    }
  }catch(e){
    console.log("Over error:", e.message);
    dmsg("Over error: "+e.message);
  }

  try{
    const htmlBtts = await browserlessGetHtml(URL_BTTS);
    const btts = scrape(htmlBtts);
    dmsg(`DEBUG BTTS: parsed=${btts.length}`);

    for(const m of btts){
      if(m.prob >= RULES.btts.minProb &&
         m.minute >= RULES.btts.minMinuteInclusive &&
         m.score === RULES.btts.score){
        const key="B"+m.raw+m.minute+m.score+m.prob;
        if(alerted.has(key)) continue;
        alerted.add(key);
        await bot.telegram.sendMessage(CHAT_ID, bttsMsg(m));
      }
    }
  }catch(e){
    console.log("BTTS error:", e.message);
    dmsg("BTTS error: "+e.message);
  }
}

setInterval(poll, RULES.pollMs);
bot.launch();
