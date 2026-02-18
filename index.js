const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { Telegraf } = require("telegraf");

// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!CHAT_ID) throw new Error("Falta CHAT_ID");

// ✅ URLs NO MÓVILES (www)
const URL_OVER25 =
  "https://www.forebet.com/es/predicciones-para-hoy/predicciones-bajo-mas-2-5-goles";

const URL_BTTS =
  "https://www.forebet.com/es/predicciones-para-hoy/ambos-equipos-anotaran";

// Reglas (ahora 50%)
const RULES = {
  pollMs: 60_000,
  over25: { minProb: 50, minMinuteExclusive: 30, scores: ["0-0", "0-1", "1-0"] },
  btts: { minProb: 50, minMinuteInclusive: 30, score: "0-0" },
};

// ================= WEB SERVER (RENDER) =================
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log("Web alive on", PORT));

// ================= TELEGRAM BOT =================
const bot = new Telegraf(BOT_TOKEN);
let watching = false;
let debug = false;
const alerted = new Set();

bot.start((ctx) =>
  ctx.reply(
    "Bot listo ✅\n/watch activar\n/stop detener\n/status estado\n/debugon debug\n/debugoff\n/reset"
  )
);

bot.command("watch", (ctx) => { watching = true; ctx.reply("🟢 Monitoreo activado"); });
bot.command("stop", (ctx) => { watching = false; ctx.reply("🔴 Monitoreo detenido"); });
bot.command("status", (ctx) =>
  ctx.reply(`Estado: ${watching ? "ACTIVO" : "DETENIDO"} | Alertas: ${alerted.size}`)
);
bot.command("reset", (ctx) => { alerted.clear(); ctx.reply("🧹 Alertas limpiadas"); });
bot.command("debugon", (ctx) => { debug = true; ctx.reply("🧪 Debug ON"); });
bot.command("debugoff", (ctx) => { debug = false; ctx.reply("🧪 Debug OFF"); });

// ================= FETCH CON HEADERS =================
async function fetchHtml(url) {
  const res = await fetch(url, {
    timeout: 30_000,
    headers: {
      // Fingimos navegador normal (desktop) para www
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.6",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Referer": "https://www.forebet.com/es/predicciones-para-hoy",
      "Connection": "keep-alive",
    },
  });

  const html = await res.text();
  return { status: res.status, html };
}

// ================= PARSE HELPERS =================
function norm(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function parseCurrentScoreFromText(t) {
  // "0 - 0(0 - 0)" o "0 - 0"
  const m = t.match(/(\d{1,2})\s*-\s*(\d{1,2})(?=\s*\(|\s*$)/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function parseMinuteBeforeScore(text) {
  const scoreMatch = text.match(/(\d{1,2}\s*-\s*\d{1,2})(?=\s*\(|\s*$)/);
  if (!scoreMatch) return null;

  const idx = scoreMatch.index;
  const left = text.slice(0, idx);

  // último número 1..130 antes del marcador
  const nums = [];
  const re = /(?<![\d.,])(\d{1,3})(?![\d.,])/g; // Node 18 ok
  let m;
  while ((m = re.exec(left)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 130) nums.push(n);
  }
  if (!nums.length) return null;
  return nums[nums.length - 1];
}

function parseProbsFromText(text) {
  // primer par "NN NN" (dos columnas)
  const re = /(?<!\d)(\d{1,3})\s+(\d{1,3})(?!\d)/;
  const m = text.match(re);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (![a, b].every((x) => Number.isFinite(x) && x >= 0 && x <= 100)) return null;
  return { p1: a, p2: b };
}

function parseMatchNameFromRow($row) {
  const linkText = norm($row.find("a").first().text());
  if (!linkText) return "Partido";
  // a veces contiene fecha/hora al final
  return linkText.replace(/\b\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\b.*$/, "").trim() || linkText;
}

function scrapeFromHtml(html) {
  const $ = cheerio.load(html);
  const matches = [];

  $("tr").each((_, tr) => {
    const $tr = $(tr);
    const text = norm($tr.text());
    if (!text) return;

    // Ignora cabeceras típicas
    if (/Equipo local|Equipo visitante|Probabilidad|Tiempo|Marcador Pred|Promedio/i.test(text)) return;

    const probs = parseProbsFromText(text);
    if (!probs) return;

    const score = parseCurrentScoreFromText(text);
    if (!score) return;

    const minute = parseMinuteBeforeScore(text);
    if (minute === null) return; // sin minuto => no en vivo

    if (/\bFT\b|\bFIN\b/i.test(text)) return;

    matches.push({
      matchName: parseMatchNameFromRow($tr),
      minute,
      score,
      p2: probs.p2, // Over: "Más", BTTS: "Sí"
    });
  });

  return matches;
}

// ================= ALERTS =================
function msgOver(m) {
  return `🚨 ALERTA OVER 2.5 (Forebet)

⚽ ${m.matchName}
⏱ Minuto: ${m.minute}'
🔢 Marcador: ${m.score}
📊 Prob Más 2.5: ${m.p2}%`;
}

function msgBTTS(m) {
  return `🔥 ALERTA BTTS (Forebet)

⚽ ${m.matchName}
⏱ Minuto: ${m.minute}'
🔢 Marcador: ${m.score}
📊 Prob “Sí”: ${m.p2}%`;
}

// ================= LOOP =================
async function poll() {
  if (!watching) return;

  // ---- OVER 2.5 ----
  try {
    const { status, html } = await fetchHtml(URL_OVER25);

    const overList = scrapeFromHtml(html);

    if (debug) {
      const snippet = norm(html.slice(0, 220));
      const sample = overList.slice(0, 8).map(x => `${x.minute}' ${x.score} ${x.p2}% | ${x.matchName}`).join("\n");
      await bot.telegram.sendMessage(
        CHAT_ID,
        `🧪 DEBUG Over2.5 (www)\nHTTP: ${status}\nHTML len: ${html.length}\nParsed: ${overList.length}\n\nSample:\n${sample || "(vacío)"}\n\nSnippet:\n${snippet}`
      );
    }

    for (const m of overList) {
      if (m.p2 < RULES.over25.minProb) continue;
      if (!(m.minute > RULES.over25.minMinuteExclusive)) continue;
      if (!RULES.over25.scores.includes(m.score)) continue;

      const key = `OVER|${m.matchName}|${m.minute}|${m.score}|${m.p2}`;
      if (alerted.has(key)) continue;
      alerted.add(key);

      await bot.telegram.sendMessage(CHAT_ID, msgOver(m));
    }
  } catch (e) {
    console.log("Over error:", e?.message || e);
  }

  // ---- BTTS ----
  try {
    const { status, html } = await fetchHtml(URL_BTTS);

    const bttsList = scrapeFromHtml(html);

    if (debug) {
      const snippet = norm(html.slice(0, 220));
      const sample = bttsList.slice(0, 8).map(x => `${x.minute}' ${x.score} ${x.p2}% | ${x.matchName}`).join("\n");
      await bot.telegram.sendMessage(
        CHAT_ID,
        `🧪 DEBUG BTTS (www)\nHTTP: ${status}\nHTML len: ${html.length}\nParsed: ${bttsList.length}\n\nSample:\n${sample || "(vacío)"}\n\nSnippet:\n${snippet}`
      );
    }

    for (const m of bttsList) {
      if (m.p2 < RULES.btts.minProb) continue;
      if (!(m.minute >= RULES.btts.minMinuteInclusive)) continue;
      if (m.score !== RULES.btts.score) continue;

      const key = `BTTS|${m.matchName}|${m.minute}|${m.score}|${m.p2}`;
      if (alerted.has(key)) continue;
      alerted.add(key);

      await bot.telegram.sendMessage(CHAT_ID, msgBTTS(m));
    }
  } catch (e) {
    console.log("BTTS error:", e?.message || e);
  }
}

setInterval(poll, RULES.pollMs);
bot.launch().then(() => console.log("Bot launched ✅"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
