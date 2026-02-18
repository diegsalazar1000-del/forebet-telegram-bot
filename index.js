const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { Telegraf } = require("telegraf");

// ===================== ENV =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!CHAT_ID) throw new Error("Falta CHAT_ID");
if (!BROWSERLESS_TOKEN) throw new Error("Falta BROWSERLESS_TOKEN");

// ===================== FOREBET URLS =====================
const URL_OVER25 =
  "https://m.forebet.com/es/predicciones-para-hoy/predicciones-bajo-mas-2-5-goles";
const URL_BTTS =
  "https://m.forebet.com/es/predicciones-para-hoy/ambos-equipos-anotaran";

// ===================== RULES =====================
// Si quieres volver a 60%, cambia minProb a 60.
const RULES = {
  pollMs: 60_000,
  over25: { minProb: 50, minMinuteExclusive: 30, scores: ["0-0", "0-1", "1-0"] },
  btts: { minProb: 50, minMinuteInclusive: 30, score: "0-0" },
};

// ===================== WEB SERVER (Render) =====================
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.listen(PORT, () => console.log("Web alive on", PORT));

// ===================== TELEGRAM BOT =====================
const bot = new Telegraf(BOT_TOKEN);

let watching = false;
let debug = false;
let debugChatId = null;

const alerted = new Set();

bot.start((ctx) =>
  ctx.reply(
    "✅ Bot listo.\n\n/watch activar\n/stop detener\n/status estado\n/debugon debug\n/debugoff\n/reset limpiar alertas"
  )
);

bot.command("watch", (ctx) => {
  watching = true;
  ctx.reply("🟢 Monitoreo activado");
});

bot.command("stop", (ctx) => {
  watching = false;
  ctx.reply("🔴 Monitoreo detenido");
});

bot.command("status", (ctx) => {
  ctx.reply(
    `Estado: ${watching ? "ACTIVO" : "DETENIDO"}\nDebug: ${
      debug ? "ON" : "OFF"
    }\nAlertas enviadas: ${alerted.size}`
  );
});

bot.command("reset", (ctx) => {
  alerted.clear();
  ctx.reply("🧹 Alertas limpiadas");
});

bot.command("debugon", (ctx) => {
  debug = true;
  debugChatId = ctx.chat.id;
  ctx.reply("🧪 Debug ON");
});

bot.command("debugoff", (ctx) => {
  debug = false;
  debugChatId = null;
  ctx.reply("🧪 Debug OFF");
});

function dmsg(text) {
  if (!debug) return;
  const target = debugChatId || CHAT_ID;
  bot.telegram.sendMessage(target, text).catch(() => {});
}

// ===================== BROWSERLESS (real browser) =====================
// Usamos /function para poder esperar selectores antes de extraer HTML final.
async function browserlessGetHtml(url) {
  const endpoint = `https://chrome.browserless.io/function?token=${encodeURIComponent(
    BROWSERLESS_TOKEN
  )}`;

  // OJO: incrustamos la URL como string dentro del código remoto.
  // Escapamos comillas por seguridad básica.
  const safeUrl = String(url).replace(/"/g, '\\"');

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: `
        module.exports = async ({ page }) => {
          await page.goto("${safeUrl}", { waitUntil: "networkidle2", timeout: 60000 });

          // Espera a que exista alguna tabla (Forebet suele renderizar así)
          await page.waitForSelector("table", { timeout: 25000 });

          // Espera extra para que carguen filas/minutos en vivo
          await page.waitForTimeout(6000);

          return await page.content();
        }
      `,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Browserless HTTP ${res.status}: ${t.slice(0, 150)}`);
  }

  return await res.text();
}

// ===================== PARSER =====================
function norm(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function parseScore(text) {
  // "0 - 0(0 - 0)" o "0 - 0"
  const m = text.match(/(\d{1,2})\s*-\s*(\d{1,2})(?=\s*\(|\s*$)/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function parseMinute(text) {
  // Toma el último número 1..130 antes del score
  const scoreMatch = text.match(/(\d{1,2}\s*-\s*\d{1,2})/);
  if (!scoreMatch) return null;

  const left = text.slice(0, scoreMatch.index);
  const nums = [...left.matchAll(/(?<![\d.,])(\d{1,3})(?![\d.,])/g)]
    .map((m) => parseInt(m[1], 10))
    .filter((n) => n >= 1 && n <= 130);

  return nums.length ? nums[nums.length - 1] : null;
}

function parseProb2(text) {
  // primer par "NN NN", usamos el 2do (Más o Sí)
  const m = text.match(/(?<!\d)(\d{1,3})\s+(\d{1,3})(?!\d)/);
  if (!m) return null;
  const p2 = parseInt(m[2], 10);
  if (!Number.isFinite(p2) || p2 < 0 || p2 > 100) return null;
  return p2;
}

function parseMatchNameFromRow($row) {
  const a = norm($row.find("a").first().text());
  if (!a) return "Partido";
  return a.replace(/\b\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\b.*$/, "").trim() || a;
}

function scrapeMatches(html) {
  const $ = cheerio.load(html);
  const matches = [];

  $("tr").each((_, tr) => {
    const $tr = $(tr);
    const text = norm($tr.text());
    if (!text) return;

    if (/Just a moment|verify you are human/i.test(text)) return;

    const prob = parseProb2(text);
    const score = parseScore(text);
    const minute = parseMinute(text);

    if (prob === null || !score || minute === null) return;

    matches.push({
      match: parseMatchNameFromRow($tr),
      minute,
      score,
      prob,
      keyRaw: text.slice(0, 160),
    });
  });

  return matches;
}

// ===================== ALERT MESSAGES =====================
function msgOver(m) {
  return `🚨 OVER 2.5 (Forebet)

⚽ ${m.match}
⏱ Minuto: ${m.minute}'
🔢 Marcador: ${m.score}
📊 Prob Más 2.5: ${m.prob}%`;
}

function msgBTTS(m) {
  return `🔥 BTTS (Forebet)

⚽ ${m.match}
⏱ Minuto: ${m.minute}'
🔢 Marcador: ${m.score}
📊 Prob “Sí”: ${m.prob}%`;
}

// ===================== MAIN LOOP =====================
async function poll() {
  if (!watching) return;

  // -------- OVER 2.5 --------
  try {
    const htmlOver = await browserlessGetHtml(URL_OVER25);
    const over = scrapeMatches(htmlOver);

    dmsg(`En vivo Over 2.5 goles:\nDEBUG Over: parsed=${over.length}`);

    for (const m of over) {
      if (m.prob < RULES.over25.minProb) continue;
      if (!(m.minute > RULES.over25.minMinuteExclusive)) continue;
      if (!RULES.over25.scores.includes(m.score)) continue;

      const key = `O|${m.match}|${m.minute}|${m.score}|${m.prob}`;
      if (alerted.has(key)) continue;
      alerted.add(key);

      await bot.telegram.sendMessage(CHAT_ID, msgOver(m));
    }
  } catch (e) {
    console.log("Over error:", e.message);
    dmsg(`❌ Over error: ${e.message}`);
  }

  // -------- BTTS --------
  try {
    const htmlBtts = await browserlessGetHtml(URL_BTTS);
    const btts = scrapeMatches(htmlBtts);

    dmsg(`\nEn vivo BTTS:\nDEBUG BTTS: parsed=${btts.length}`);

    for (const m of btts) {
      if (m.prob < RULES.btts.minProb) continue;
      if (!(m.minute >= RULES.btts.minMinuteInclusive)) continue;
      if (m.score !== RULES.btts.score) continue;

      const key = `B|${m.match}|${m.minute}|${m.score}|${m.prob}`;
      if (alerted.has(key)) continue;
      alerted.add(key);

      await bot.telegram.sendMessage(CHAT_ID, msgBTTS(m));
    }
  } catch (e) {
    console.log("BTTS error:", e.message);
    dmsg(`❌ BTTS error: ${e.message}`);
  }
}

setInterval(poll, RULES.pollMs);

bot.launch().then(() => console.log("Bot launched ✅"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
