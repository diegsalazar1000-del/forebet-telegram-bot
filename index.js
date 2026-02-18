const express = require("express");
const fetch = require("node-fetch");
const { Telegraf } = require("telegraf");

// =====================
// CONFIG
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!CHAT_ID) throw new Error("Falta CHAT_ID");

// Forebet URLs (HOY)
const URL_OVER25 =
  "https://m.forebet.com/es/predicciones-para-hoy/predicciones-bajo-mas-2-5-goles";

const URL_BTTS =
  "https://m.forebet.com/es/predicciones-para-hoy/ambos-equipos-anotaran";

// Reglas
const RULES = {
  pollMs: 60_000,

  over25: {
    minProbOver: 60, // "Más" (2da columna)
    minMinuteExclusive: 30,
    allowedScores: new Set(["0-0", "0-1", "1-0"]),
  },

  btts: {
    minProbYes: 60, // "Sí" (2da columna)
    minMinuteInclusive: 30,
    requiredScore: "0-0",
  },
};

// =====================
// MINI WEB (Render Web Service necesita PORT)
// =====================
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.listen(PORT, () => console.log("Web alive on", PORT));

// =====================
// TELEGRAM BOT
// =====================
const bot = new Telegraf(BOT_TOKEN);

let watching = false;
const alerted = new Set(); // anti-spam en memoria

bot.start((ctx) =>
  ctx.reply(
    "✅ Bot listo.\n\nComandos:\n/watch = activar\n/stop = detener\n/status = estado\n/reset = reset alertas"
  )
);

bot.command("watch", (ctx) => {
  watching = true;
  ctx.reply("🟢 Monitoreo activado (Over2.5 + BTTS desde Forebet).");
});

bot.command("stop", (ctx) => {
  watching = false;
  ctx.reply("🔴 Monitoreo detenido.");
});

bot.command("status", (ctx) => {
  ctx.reply(
    `Estado: ${watching ? "🟢 ACTIVO" : "🔴 DETENIDO"}\nAlertas enviadas: ${alerted.size}\nIntervalo: ${
      RULES.pollMs / 1000
    }s`
  );
});

bot.command("reset", (ctx) => {
  alerted.clear();
  ctx.reply("🧹 Reset listo. Podrán volver a salir alertas repetidas.");
});

// =====================
// PARSER “tolerante” PARA FOREBET
// (no depende de CSS/DOM exacto)
// =====================
function htmlToLooseText(html) {
  // quita scripts/styles y mete saltos de línea por etiquetas para conservar “bloques”
  let t = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|td|li|table|section|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  // entidades básicas
  t = t
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  // normaliza espacios / líneas
  t = t
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

  return t;
}

function splitMatchBlocks(text) {
  // Detecta “cabeceras” de partido por fecha/hora "dd/mm/yyyy hh:mm"
  const dtRe = /\b(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})\b/g;
  const starts = [];
  let m;

  while ((m = dtRe.exec(text)) !== null) {
    // agarramos la línea donde está esa fecha
    const idx = m.index;
    const lineStart = text.lastIndexOf("\n", idx) + 1;
    starts.push(lineStart);
  }

  // Dedup y orden
  const uniq = [...new Set(starts)].sort((a, b) => a - b);
  const blocks = [];

  for (let i = 0; i < uniq.length; i++) {
    const start = uniq[i];
    const end = i + 1 < uniq.length ? uniq[i + 1] : text.length;
    const block = text.slice(start, end).trim();
    if (block.length > 20) blocks.push(block);
  }
  return blocks;
}

function parseFirstTwoProbs(block) {
  // Primera ocurrencia “NN NN” (2 columnas de probabilidad)
  const re = /(^|\n)\s*(\d{1,3})\s+(\d{1,3})\s*(\n|$)/;
  const m = block.match(re);
  if (!m) return null;
  const a = parseInt(m[2], 10);
  const b = parseInt(m[3], 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { p1: a, p2: b };
}

function parseMinuteIfLive(block) {
  // Si está finalizado, lo ignoramos
  if (/\bFT\b/i.test(block)) return null;

  // Busca números en líneas “solas”: \n 66 \n
  const re = /\n\s*(\d{1,3})\s*\n/g;
  let m;
  let last = null;

  while ((m = re.exec(block)) !== null) {
    const v = parseInt(m[1], 10);
    if (v >= 1 && v <= 130) last = v;
  }

  return last; // puede ser null si no hay minuto
}

function parseCurrentScore(block) {
  // Tomamos el ÚLTIMO "d - d" del bloque como marcador actual más probable
  const re = /\b(\d{1,2})\s*-\s*(\d{1,2})\b/g;
  let m;
  let last = null;

  while ((m = re.exec(block)) !== null) {
    last = `${parseInt(m[1], 10)}-${parseInt(m[2], 10)}`;
  }
  return last;
}

function parseMatchName(block) {
  // Corta antes de la fecha/hora; lo que queda suele ser “EquipoA EquipoB …”
  const m = block.match(/^(.+?)\s+\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}/);
  if (!m) return "Partido";
  return m[1].trim().replace(/\s{2,}/g, " ");
}

function parseForebet(html) {
  const text = htmlToLooseText(html);
  const blocks = splitMatchBlocks(text);

  const parsed = [];

  for (const b of blocks) {
    const probs = parseFirstTwoProbs(b);
    if (!probs) continue;

    const minute = parseMinuteIfLive(b);
    if (minute === null) continue; // solo EN VIVO

    const score = parseCurrentScore(b);
    if (!score) continue;

    parsed.push({
      matchName: parseMatchName(b),
      minute,
      score,
      p1: probs.p1,
      p2: probs.p2, // en Over2.5 = "Más"; en BTTS = "Sí"
      raw: b,
    });
  }

  return parsed;
}

// =====================
// FORMAT ALERTS
// =====================
function formatOverAlert(m) {
  return `🚨 ALERTA OVER 2.5 (Forebet)

⚽ ${m.matchName}
⏱ Minuto: ${m.minute}'
🔢 Marcador: ${m.score}
📊 Prob Más 2.5: ${m.p2}%

✅ EN VIVO · >30' · 0-0/0-1/1-0 · Prob ≥60%`;
}

function formatBTTSAlert(m) {
  return `🔥 ALERTA BTTS (Forebet)

⚽ ${m.matchName}
⏱ Minuto: ${m.minute}'
🔢 Marcador: ${m.score}
📊 Prob “Sí”: ${m.p2}%

✅ EN VIVO · ≥30' · 0-0 · Prob ≥60%`;
}

// =====================
// POLL
// =====================
async function getHtml(url) {
  const res = await fetch(url, { timeout: 30_000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.text();
}

async function poll() {
  if (!watching) return;

  // ---- OVER 2.5 ----
  try {
    const html = await getHtml(URL_OVER25);
    const matches = parseForebet(html);

    for (const m of matches) {
      // p2 = "Más"
      if (m.p2 < RULES.over25.minProbOver) continue;
      if (!(m.minute > RULES.over25.minMinuteExclusive)) continue;
      if (!RULES.over25.allowedScores.has(m.score)) continue;

      const key = `OVER25|${m.matchName}|${m.minute}|${m.score}|${m.p2}`;
      if (alerted.has(key)) continue;
      alerted.add(key);

      await bot.telegram.sendMessage(CHAT_ID, formatOverAlert(m));
    }
  } catch (e) {
    console.log("Over2.5 error:", e?.message || e);
  }

  // ---- BTTS ----
  try {
    const html = await getHtml(URL_BTTS);
    const matches = parseForebet(html);

    for (const m of matches) {
      // p2 = "Sí"
      if (m.p2 < RULES.btts.minProbYes) continue;
      if (!(m.minute >= RULES.btts.minMinuteInclusive)) continue;
      if (m.score !== RULES.btts.requiredScore) continue;

      const key = `BTTS|${m.matchName}|${m.minute}|${m.score}|${m.p2}`;
      if (alerted.has(key)) continue;
      alerted.add(key);

      await bot.telegram.sendMessage(CHAT_ID, formatBTTSAlert(m));
    }
  } catch (e) {
    console.log("BTTS error:", e?.message || e);
  }
}

setInterval(poll, RULES.pollMs);

bot.launch().then(() => console.log("Bot launched ✅"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
