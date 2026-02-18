const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
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

// Probabilidades mínimas (ajústalas si quieres)
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

bot.start((ctx) => ctx.reply("Bot listo ✅\n/watch para activar\n/stop para parar"));
bot.command("watch", (ctx) => { watching = true; ctx.reply("🟢 Monitoreo activado"); });
bot.command("stop", (ctx) => { watching = false; ctx.reply("🔴 Monitoreo detenido"); });
bot.command("status", (ctx) =>
  ctx.reply(`Estado: ${watching ? "ACTIVO" : "DETENIDO"}\nAlertas: ${alerted.size}`)
);
bot.command("reset", (ctx) => { alerted.clear(); ctx.reply("🧹 Alertas limpiadas"); });
bot.command("debugon", (ctx) => { debug = true; ctx.reply("🧪 Debug ON"); });
bot.command("debugoff", (ctx) => { debug = false; ctx.reply("🧪 Debug OFF"); });

// ================= PARSE HELPERS =================
function norm(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function parseCurrentScoreFromText(t) {
  // Ejemplos:
  // "0 - 0(0 - 0)"  -> score actual "0-0"
  // "0 - 0"         -> score actual "0-0"
  const m = t.match(/(\d{1,2})\s*-\s*(\d{1,2})(?=\s*\(|\s*$)/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function parseMinuteBeforeScore(text) {
  const scoreMatch = text.match(/(\d{1,2}\s*-\s*\d{1,2})(?=\s*\(|\s*$)/);
  if (!scoreMatch) return null;

  const idx = scoreMatch.index;
  const left = text.slice(0, idx);

  // Captura números "solos" (no parte de decimales), pero ojo con fechas/horas:
  // Nos quedamos con el ÚLTIMO número 1..130 justo antes del marcador.
  const nums = [];
  const re = /(?<![\d.,])(\d{1,3})(?![\d.,])/g; // Node 18 soporta lookbehind
  let m;
  while ((m = re.exec(left)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 130) nums.push(n);
  }
  if (!nums.length) return null;
  return nums[nums.length - 1];
}

function parseProbsFromText(text) {
  // En Forebet suele aparecer como "38 62" (dos columnas)
  // tomamos el primer par razonable 0..100
  const re = /(?<!\d)(\d{1,3})\s+(\d{1,3})(?!\d)/;
  const m = text.match(re);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (![a, b].every((x) => Number.isFinite(x) && x >= 0 && x <= 100)) return null;
  return { p1: a, p2: b };
}

function parseMatchNameFromRow($row) {
  // Intento simple: texto del link principal (equipos + fecha/hora)
  const linkText = norm($row.find("a").first().text());
  if (!linkText) return "Partido";
  // Quitamos la fecha/hora al final si viene "18/02/2026 11:00"
  return linkText.replace(/\b\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\b.*$/, "").trim() || linkText;
}

// Scrape genérico de una página Forebet con tabla
async function scrapeForebet(url) {
  const res = await fetch(url, { timeout: 30_000 });
  const html = await res.text();
  const $ = cheerio.load(html);

  const matches = [];

  // La tabla de predicciones suele estar en filas <tr>.
  $("tr").each((_, tr) => {
    const $tr = $(tr);
    const text = norm($tr.text());
    if (!text) return;

    const probs = parseProbsFromText(text);
    if (!probs) return;

    const score = parseCurrentScoreFromText(text);
    if (!score) return;

    const minute = parseMinuteBeforeScore(text);
    if (minute === null) return; // si no hay minuto => NO es en vivo

    // “FT” o “FIN” => ignorar por si aparece
    if (/\bFT\b|\bFIN\b/i.test(text)) return;

    const matchName = parseMatchNameFromRow($tr);

    matches.push({
      matchName,
      minute,
      score,
      p2: probs.p2, // 2da columna (Más o Sí)
      rawKey: text.slice(0, 120), // para anti-spam
    });
  });

  return matches;
}

// ================= ALERT TEXT =================
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

  try {
    // ---- OVER 2.5 ----
    const overList = await scrapeForebet(URL_OVER25);

    // Debug: muestra una muestra REAL de lo que leyó
    if (debug) {
      const sample = overList.slice(0, 8).map(x => `OVER  | ${x.minute}' | ${x.score} | ${x.p2}% | ${x.matchName}`).join("\n");
      await bot.telegram.sendMessage(CHAT_ID, `🧪 DEBUG (Over2.5)\n${sample || "No detecté partidos EN VIVO en Over2.5"}`);
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

    // ---- BTTS ----
    const bttsList = await scrapeForebet(URL_BTTS);

    if (debug) {
      const sample = bttsList.slice(0, 8).map(x => `BTTS | ${x.minute}' | ${x.score} | ${x.p2}% | ${x.matchName}`).join("\n");
      await bot.telegram.sendMessage(CHAT_ID, `🧪 DEBUG (BTTS)\n${sample || "No detecté partidos EN VIVO en BTTS"}`);
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
    console.log("poll error:", e?.message || e);
  }
}

setInterval(poll, RULES.pollMs);
bot.launch().then(() => console.log("Bot launched ✅"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
