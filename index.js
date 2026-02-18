const express = require("express");
const fetch = require("node-fetch");
const { Telegraf } = require("telegraf");

// --- Mini web para que Render tenga tráfico ---
const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => res.send("OK"));
app.listen(PORT, () => console.log("Web alive on", PORT));

// --- Bot ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!CHAT_ID) throw new Error("Falta CHAT_ID");

const bot = new Telegraf(BOT_TOKEN);

let watching = false;
const alerted = new Set();

bot.start((ctx) => ctx.reply("Bot listo ✅ Usa /watch para activar y /stop para parar"));
bot.command("watch", (ctx) => {
  watching = true;
  ctx.reply("🟢 Monitoreo activado");
});
bot.command("stop", (ctx) => {
  watching = false;
  ctx.reply("🔴 Monitoreo detenido");
});
bot.command("reset", (ctx) => {
  alerted.clear();
  ctx.reply("🧹 Reset listo (puede volver a alertar los mismos partidos)");
});

function qualifies({ prob, minute, score }) {
  return (
    prob >= 60 &&
    minute > 30 &&
    (score === "0-0" || score === "0-1" || score === "1-0")
  );
}

function extractLiveCandidates(html) {
  // Heurística simple: buscamos % y miramos alrededor para minuto y marcador
  const results = [];
  const re = /(\d{1,3})%/g;

  let m;
  while ((m = re.exec(html)) !== null) {
    const prob = parseInt(m[1], 10);
    if (Number.isNaN(prob) || prob < 60) continue;

    const start = Math.max(0, m.index - 250);
    const end = Math.min(html.length, m.index + 250);
    const chunk = html.slice(start, end);

    const minuteMatch = chunk.match(/(\d{1,3})\s*['’]/); // 34' o 34’
    const scoreMatch = chunk.match(/\b(\d{1,2}\s*-\s*\d{1,2})\b/);

    if (!minuteMatch || !scoreMatch) continue;

    const minute = parseInt(minuteMatch[1], 10);
    const score = scoreMatch[1].replace(/\s*/g, "");

    // Intento de nombre de partido (si no sale, igual alertamos)
    const nameMatch = chunk.match(/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 .'-]{3,}?)\s+vs\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 .'-]{3,})/i);
    const matchName = nameMatch ? `${nameMatch[1].trim()} vs ${nameMatch[2].trim()}` : "Partido en vivo";

    results.push({ matchName, prob, minute, score });
  }

  // dedupe por matchName + score + minute (evita spam)
  const dedup = new Map();
  for (const r of results) {
    const key = `${r.matchName}|${r.score}|${r.minute}|${r.prob}`;
    if (!dedup.has(key)) dedup.set(key, r);
  }
  return [...dedup.values()];
}

async function poll() {
  if (!watching) return;

  try {
    const url = "https://m.forebet.com/es/predicciones-para-hoy/predicciones-bajo-mas-2-5-goles";
    const res = await fetch(url, { timeout: 30000 });
    const html = await res.text();

    const candidates = extractLiveCandidates(html).filter(qualifies);

    // Solo alertar si hay al menos uno nuevo
    for (const c of candidates) {
      const alertKey = `${c.matchName}|${c.score}|${c.prob}`;
      if (alerted.has(alertKey)) continue;
      alerted.add(alertKey);

      await bot.telegram.sendMessage(
        CHAT_ID,
        `🚨 ALERTA OVER 2.5 (Forebet)\n\n⚽ ${c.matchName}\n⏱ Minuto: ${c.minute}'\n🔢 Marcador: ${c.score}\n📊 Prob Over 2.5: ${c.prob}%\n\n✅ Cumple criterios (EN VIVO, >30', score permitido, prob ≥60%)`
      );
    }
  } catch (e) {
    console.log("poll error:", e && e.message ? e.message : e);
  }
}

setInterval(poll, 60_000);

bot.launch().then(() => console.log("Bot launched ✅"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
