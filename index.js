const express = require("express");
const fetch = require("node-fetch");
const { Telegraf } = require("telegraf");

// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!CHAT_ID) throw new Error("Falta CHAT_ID");

const URL_OVER25 =
  "https://m.forebet.com/es/predicciones-para-hoy/predicciones-bajo-mas-2-5-goles";

const URL_BTTS =
  "https://m.forebet.com/es/predicciones-para-hoy/ambos-equipos-anotaran";

// 🔥 NUEVAS REGLAS (50%)
const RULES = {
  pollMs: 60000,
  over25: { minProb: 50, minMinute: 30, scores: ["0-0","0-1","1-0"] },
  btts: { minProb: 50, minMinute: 30, score: "0-0" }
};

// ================= WEB SERVER (RENDER) =================
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req,res)=>res.send("OK"));
app.listen(PORT, ()=>console.log("Web alive on",PORT));

// ================= TELEGRAM BOT =================
const bot = new Telegraf(BOT_TOKEN);
let watching = false;
let debug = false;
const alerted = new Set();

bot.start(ctx=>ctx.reply("Bot listo ✅ /watch para activar"));
bot.command("watch", ctx=>{ watching=true; ctx.reply("🟢 Monitoreo activado"); });
bot.command("stop", ctx=>{ watching=false; ctx.reply("🔴 Monitoreo detenido"); });
bot.command("status", ctx=>ctx.reply("Estado: "+(watching?"ACTIVO":"DETENIDO")));
bot.command("reset", ctx=>{alerted.clear(); ctx.reply("Alertas limpiadas");});
bot.command("debugon", ctx=>{ debug=true; ctx.reply("🧪 Debug ON");});
bot.command("debugoff", ctx=>{ debug=false; ctx.reply("🧪 Debug OFF");});

// ================= PARSER FOREBET =================
function clean(html){
  return html.replace(/<[^>]+>/g," ")
             .replace(/\s+/g," ")
             .replace(/&nbsp;/g," ");
}

function parseMatches(html){
  const text = clean(html);
  const matches = [];
  const re = /(\d{2}\/\d{2}\/\d{4}\s\d{2}:\d{2})([\s\S]*?)(?=\d{2}\/\d{2}\/\d{4}|\Z)/g;
  let m;
  while((m=re.exec(text))!==null){
    const block=m[0];

    const probs = block.match(/\s(\d{1,3})\s+(\d{1,3})\s/);
    if(!probs) continue;

    const minuteMatch = block.match(/\s(\d{1,3})\s/);
    const scoreMatch = block.match(/(\d-\d)/);

    if(!minuteMatch || !scoreMatch) continue;

    matches.push({
      raw:block,
      minute: parseInt(minuteMatch[1]),
      score: scoreMatch[1],
      p2: parseInt(probs[2]),
      name:block.substring(0,40)
    });
  }
  return matches;
}

// ================= ALERT FORMATS =================
function alertOver(m){
return `🚨 OVER 2.5

${m.name}
Min ${m.minute}'
Score ${m.score}
Prob ${m.p2}%`;
}

function alertBTTS(m){
return `🔥 BTTS

${m.name}
Min ${m.minute}'
Score ${m.score}
Prob ${m.p2}%`;
}

// ================= MAIN LOOP =================
async function poll(){
  if(!watching) return;

  try{
    // ===== OVER 2.5 =====
    const overHtml = await (await fetch(URL_OVER25)).text();
    const overMatches = parseMatches(overHtml);

    for(const m of overMatches){
      if(m.p2>=RULES.over25.minProb &&
         m.minute>RULES.over25.minMinute &&
         RULES.over25.scores.includes(m.score)){
        const key="O"+m.raw;
        if(!alerted.has(key)){
          alerted.add(key);
          await bot.telegram.sendMessage(CHAT_ID,alertOver(m));
        }
      }
    }

    // ===== BTTS =====
    const bttsHtml = await (await fetch(URL_BTTS)).text();
    const bttsMatches = parseMatches(bttsHtml);

    if(debug){
      const sample=bttsMatches.slice(0,5).map(x=>`${x.minute} ${x.score} ${x.p2}%`).join("\n");
      await bot.telegram.sendMessage(CHAT_ID,"DEBUG:\n"+sample);
    }

    for(const m of bttsMatches){
      if(m.p2>=RULES.btts.minProb &&
         m.minute>=RULES.btts.minMinute &&
         m.score===RULES.btts.score){
        const key="B"+m.raw;
        if(!alerted.has(key)){
          alerted.add(key);
          await bot.telegram.sendMessage(CHAT_ID,alertBTTS(m));
        }
      }
    }

  }catch(e){
    console.log("Error:",e.message);
  }
}

setInterval(poll,60000);
bot.launch();
