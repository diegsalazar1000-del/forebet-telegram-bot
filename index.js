const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => res.send("OK"));
app.listen(PORT, () => console.log("Alive on", PORT));

const express = require("express");
const app = express();

const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("OK"));
app.listen(PORT, () => console.log("Web alive on", PORT));

const { Telegraf } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);
const CHAT_ID = process.env.CHAT_ID;

let watching = false;
let alertedMatches = new Set();

bot.start(ctx => ctx.reply("Bot listo. Usa /watch para activar"));
bot.command("watch", ctx => {
  watching = true;
  ctx.reply("Monitoreo activado ⚽");
});
bot.command("stop", ctx => {
  watching = false;
  ctx.reply("Monitoreo detenido");
});

async function checkForebet(){
  if(!watching) return;

  try{
    const res = await fetch("https://m.forebet.com/es/predicciones-para-hoy/predicciones-bajo-mas-2-5-goles");
    const html = await res.text();

    const probMatches = [...html.matchAll(/(\d{1,3})%/g)];
    if(!probMatches.length) return;

    for(const p of probMatches){
      const prob = parseInt(p[1]);
      if(prob < 60) continue;

      const chunk = html.substring(p.index-200, p.index+200);

      const minute = chunk.match(/(\d{2})'/);
      const score = chunk.match(/(\d-\d)/);

      if(!minute || !score) continue;

      const min = parseInt(minute[1]);
      const sc = score[1];

      if(min > 30 && ["0-0","0-1","1-0"].includes(sc)){
        const key = chunk.slice(0,50);
        if(alertedMatches.has(key)) continue;
        alertedMatches.add(key);

        bot.telegram.sendMessage(CHAT_ID,
`🚨 ALERTA OVER 2.5

⏱ Min ${min}'
🔢 ${sc}
📊 Prob ≥60%`);
      }
    }
  }catch(e){
    console.log("error scraping");
  }
}

setInterval(checkForebet,60000);
bot.launch();
