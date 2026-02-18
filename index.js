import { Telegraf } from "telegraf";

const bot = new Telegraf(process.env.BOT_TOKEN);
const CHAT_ID = process.env.CHAT_ID;

let watching = false;

bot.start(ctx => ctx.reply("Bot listo. Escribe /watch para empezar."));
bot.command("watch", ctx => {
  watching = true;
  ctx.reply("Monitoreo activado.");
});
bot.command("stop", ctx => {
  watching = false;
  ctx.reply("Monitoreo detenido.");
});

async function fakeMonitor(){
  if(!watching) return;
  await bot.telegram.sendMessage(CHAT_ID,
`🚨 ALERTA TEST

⚽ Partido: Demo vs Demo
⏱ Minuto: 35'
🔢 Marcador: 0-0
📊 Prob Over 2.5: 72%`);
}

setInterval(fakeMonitor,60000);
bot.launch();

