const { Telegraf } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);
const CHAT_ID = process.env.CHAT_ID;

let watching = false;
let alertedMatches = new Set();

bot.start(ctx => ctx.reply("Bot listo. Escribe /watch"));
bot.command("watch", ctx => {
  watching = true;
  ctx.reply("Monitoreo Forebet activado ⚽");
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

    const matches = html.match(/(\d{1,3}%)(.*?)vs(.*?)(\d-\d)/gs);
    if(!matches) return;

    for(const m of matches){
      const probMatch = m.match(/\d{1,3}%/);
      const scoreMatch = m.match(/\d-\d/);
      const minuteMatch = m.match(/(\d{2})'/);

      if(!probMatch || !scoreMatch || !minuteMatch) continue;

      const prob = parseInt(probMatch[0]);
      const score = scoreMatch[0];
      const minute = parseInt(minuteMatch[1]);

      if(
        prob >= 60 &&
        minute > 30 &&
        ["0-0","0-1","1-0"].includes(score)
      ){
        if(alertedMatches.has(m)) continue;
        alertedMatches.add(m);

        bot.telegram.sendMessage(CHAT_ID,
`🚨 ALERTA OVER 2.5

⏱ Minuto ${minute}'
🔢 Marcador ${score}
📊 Probabilidad ${prob}%`);
      }
    }
  }catch(e){
    console.log("Error scraping");
  }
}

setInterval(checkForebet,60000);
bot.launch();
