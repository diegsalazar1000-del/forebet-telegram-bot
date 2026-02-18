const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const { Telegraf } = require("telegraf");

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// Apify
const APIFY_TOKEN = process.env.APIFY_TOKEN;          // requerido
const APIFY_DATASET_ID = process.env.APIFY_DATASET_ID; // requerido

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!CHAT_ID) throw new Error("Falta CHAT_ID");
if (!APIFY_TOKEN) throw new Error("Falta APIFY_TOKEN");
if (!APIFY_DATASET_ID) throw new Error("Falta APIFY_DATASET_ID");

// ================= Forebet URLs (solo para identificar cada HTML) =================
const URL_OVER25 =
  "https://m.forebet.com/es/predicciones-para-hoy/predicciones-bajo-mas-2-5-goles";
const URL_BTTS =
  "https://m.forebet.com/es/predicciones-para-hoy/ambos-equipos-anotaran";

// ================= RULES =================
const RULES = {
  pollMs: 60_000,

  // (probabilidades ya en 50%)
  over25: { minProb: 50, minMinuteExclusive: 30, scores: ["0-0", "0-1", "1-0"] },
  btts: { minProb: 50, minMinuteInclusive: 30, score: "0-0" },

  // Apify: cuántos items leer del dataset (últimos)
  apifyLimit: 20
};

// ================= WEB SERVER (Render port binding) =================
const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => console.log("Web alive on", PORT));

// ================= TELEGRAM BOT =================
const bot = new Telegraf(BOT_TOKEN);

let watching = false;
let debug = false;

// Anti-spam
const alerted = new Set();

bot.start((ctx) =>
  ctx.reply(
    "✅ Bot listo.\n\n/watch activar\n/stop detener\n/status estado\n/reset limpiar alertas\n/debugon debug\n/debugoff"
  )
);

bot.command("watch", (ctx) => { watching = true; ctx.reply("🟢 Monitoreo activado (vía Apify)"); });
bot.command("stop", (ctx) => { watching = false; ctx.reply("🔴 Monitoreo detenido"); });
bot.command("status", (ctx) =>
  ctx.reply(`Estado: ${watching ? "ACTIVO" : "DETENIDO"} | Alertas: ${alerted.size} | Debug: ${debug ? "ON" : "OFF"}`)
);
bot.command("reset", (ctx) => { alerted.clear(); ctx.reply("🧹 Alertas limpiadas"); });
bot.command("debugon", (ctx) => { debug = true; ctx.reply("🧪 Debug ON"); });
bot.command("debugoff", (ctx) => { debug = false; ctx.reply("🧪 Debug OFF"); });

// ================= APIFY DATASET READ =================
// Esperamos que cada item tenga: { url: "...", html: "..."} o { url, pageContent }.
// El código intenta detectar el campo HTML automáticamente.
async function getLatestApifyItems() {
  const url =
    `https://api.apify.com/v2/datasets/${APIFY_DATASET_ID}/items` +
    `?token=${encodeURIComponent(APIFY_TOKEN)}` +
    `&format=json&clean=true&limit=${RULES.apifyLimit}&desc=true`;

  const res = await fetch(url, { timeout: 30_000 });
  if (!res.ok) throw new Error(`Apify dataset HTTP ${res.status}`);

  const items = await res.json();
  return Array.isArray(items) ? items : [];
}

function pickHtmlField(item) {
  // campos típicos según actor
  return (
    item?.html ||
    item?.pageContent ||
    item?.content ||
    item?.body ||
    item?.pageHtml ||
    null
  );
}

// ================= PARSING FOREBET HTML =================
function norm(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function parseCurrentScoreFromText(t) {
  const m = t.match(/(\d{1,2})\s*-\s*(\d{1,2})(?=\s*\(|\s*$)/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function parseMinuteBeforeScore(text) {
  const scoreMatch = text.match(/(\d{1,2}\s*-\s*\d{1,2})(?=\s*\(|\s*$)/);
  if (!scoreMatch) return null;

  const idx = scoreMatch.index;
  const left = text.slice(0, idx);

  const nums = [];
  const re = /(?<![\d.,])(\d{1,3})(?![\d.,])/g;
  let m;
  while ((m = re.exec(left)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 130) nums.push(n);
  }
  if (!nums.length) return null;
  return nums[nums.length - 1];
}

function parseProbsFromText(text) {
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
  return linkText.replace(/\b\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\b.*$/, "").trim() || linkText;
}

function scrapeFromForebetHtml(html) {
  const $ = cheerio.load(html);
  const matches = [];

  $("tr").each((_, tr) => {
    const $tr = $(tr);
    const text = norm($tr.text());
    if (!text) return;

    // ignora cabeceras típicas
    if (/Equipo local|Equipo visitante|Probabilidad|Tiempo|Marcador Pred|Promedio/i.test(text)) return;

    const probs = parseProbsFromText(text);
    if (!probs) return;

    const score = parseCurrentScoreFromText(text);
    if (!score) return;

    const minute = parseMinuteBeforeScore(text);
    if (minute === null) return; // sin minuto => no live

    if (/\bFT\b|\bFIN\b|Just a moment|verify you are human/i.test(text)) return;

    matches.push({
      matchName: parseMatchNameFromRow($tr),
      minute,
      score,
      p2: probs.p2
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

// ================= MAIN LOOP =================
async function poll() {
  if (!watching) return;

  try {
    const items = await getLatestApifyItems();

    // Busca el HTML más reciente para cada URL
    let htmlOver = null;
    let htmlBtts = null;

    for (const it of items) {
      const u = it?.url || it?.request?.url || it?.loadedUrl || "";
      const html = pickHtmlField(it);

      if (!html) continue;

      if (!htmlOver && u.includes("predicciones-bajo-mas-2-5-goles")) htmlOver = html;
      if (!htmlBtts && u.includes("ambos-equipos-anotaran")) htmlBtts = html;

      if (htmlOver && htmlBtts) break;
    }

    if (debug) {
      await bot.telegram.sendMessage(
        CHAT_ID,
        `🧪 DEBUG Apify\nItems recibidos: ${items.length}\nOver HTML: ${htmlOver ? "✅" : "❌"} | BTTS HTML: ${htmlBtts ? "✅" : "❌"}`
      );
    }

    // Si no hay HTML, no podemos hacer nada (actor no corrió o dataset vacío)
    if (!htmlOver && !htmlBtts) return;

    // ---- OVER 2.5 ----
    if (htmlOver) {
      const overList = scrapeFromForebetHtml(htmlOver);

      if (debug) {
        const sample = overList.slice(0, 8).map(x => `${x.minute}' ${x.score} ${x.p2}% | ${x.matchName}`).join("\n");
        await bot.telegram.sendMessage(CHAT_ID, `🧪 DEBUG Over (Apify)\nParsed: ${overList.length}\n${sample || "(vacío)"}`);
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
    }

    // ---- BTTS ----
    if (htmlBtts) {
      const bttsList = scrapeFromForebetHtml(htmlBtts);

      if (debug) {
        const sample = bttsList.slice(0, 8).map(x => `${x.minute}' ${x.score} ${x.p2}% | ${x.matchName}`).join("\n");
        await bot.telegram.sendMessage(CHAT_ID, `🧪 DEBUG BTTS (Apify)\nParsed: ${bttsList.length}\n${sample || "(vacío)"}`);
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
    }
  } catch (e) {
    console.log("poll error:", e?.message || e);
  }
}

setInterval(poll, RULES.pollMs);
bot.launch().then(() => console.log("Bot launched ✅"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
