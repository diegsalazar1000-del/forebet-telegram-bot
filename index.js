const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const URL_OVER25="https://m.forebet.com/es/predicciones-para-hoy/predicciones-bajo-mas-2-5-goles";
const URL_BTTS="https://m.forebet.com/es/predicciones-para-hoy/ambos-equipos-anotaran";

const RULES={
 over25:{minProb:50,minMinute:30,scores:["0-0","0-1","1-0"]},
 btts:{minProb:50,minMinute:30,score:"0-0"}
};

const app=express();
app.get("/",(r,s)=>s.send("OK"));
app.listen(process.env.PORT||10000);

const bot=new Telegraf(BOT_TOKEN);
let watching=false;
let debug=false;
const alerted=new Set();

bot.start(ctx=>ctx.reply("Bot listo /watch"));
bot.command("watch",ctx=>{watching=true;ctx.reply("ON")});
bot.command("stop",ctx=>{watching=false;ctx.reply("OFF")});
bot.command("debugon",ctx=>{debug=true;ctx.reply("DEBUG ON")});
bot.command("debugoff",ctx=>{debug=false;ctx.reply("DEBUG OFF")});

async function scrape(url){
 const html=await(await fetch(url)).text();
 const $=cheerio.load(html);
 const rows=$("tr").toArray();
 const matches=[];

 rows.forEach(r=>{
   const text=$(r).text();

   const prob=text.match(/(\d{1,3})\s+(\d{1,3})/);
   const minute=text.match(/(\d{1,3})'/);
   const score=text.match(/(\d-\d)/);

   if(!prob||!minute||!score) return;

   matches.push({
     prob:parseInt(prob[2]),
     minute:parseInt(minute[1]),
     score:score[1],
     raw:text.substring(0,50)
   });
 });

 return matches;
}

async function poll(){
 if(!watching) return;

 const over=await scrape(URL_OVER25);
 const btts=await scrape(URL_BTTS);

 if(debug){
   const txt=over.slice(0,5).map(m=>`${m.minute} ${m.score} ${m.prob}%`).join("\n");
   await bot.telegram.sendMessage(CHAT_ID,"DEBUG:\n"+txt);
 }

 for(const m of over){
   if(m.prob>=RULES.over25.minProb &&
      m.minute>RULES.over25.minMinute &&
      RULES.over25.scores.includes(m.score)){
      const key="O"+m.raw;
      if(!alerted.has(key)){
        alerted.add(key);
        await bot.telegram.sendMessage(CHAT_ID,`OVER ALERT\n${m.minute}' ${m.score} ${m.prob}%`);
      }
   }
 }

 for(const m of btts){
   if(m.prob>=RULES.btts.minProb &&
      m.minute>=RULES.btts.minMinute &&
      m.score===RULES.btts.score){
      const key="B"+m.raw;
      if(!alerted.has(key)){
        alerted.add(key);
        await bot.telegram.sendMessage(CHAT_ID,`BTTS ALERT\n${m.minute}' ${m.score} ${m.prob}%`);
      }
   }
 }
}

setInterval(poll,60000);
bot.launch();
