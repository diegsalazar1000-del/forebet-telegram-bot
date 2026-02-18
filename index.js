const express = require("express");
const fetch = require("node-fetch");
const { Telegraf } = require("telegraf");

// ===================== ENV =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!CHAT_ID) throw new Error("Falta CHAT_ID");

// ===================== CONFIG =====================
const POLL_MS = 60_000;

// Base (tu filtro)
const MINUTE_MIN = 31; // >30
const ALLOWED_SCORES = new Set(["0-0", "0-1", "1-0"]);

// “Abierto” por stats (si existen)
const OPEN_RULES = {
  sotTotalMin: 2,
  cornersTotalMin: 3,
  possessionHighMin: 60,
  totalShotsMin: 10,
  redCard: { sotTotalMin: 1, cornersTotalMin: 2 },
};

// Histórico goleador (cuando faltan stats o como refuerzo)
const HISTORY_N = 10;
const HISTORY_RULES = {
  avgGoalsMin: 3.0,
  pctOver25Min: 0.55, // 55%
};

// Odds/bookies
const MIN_RECOGNIZED_BOOKIES = 3;
const RECOGNIZED_BOOKIES = new Set([
  "bet365",
  "1xbet",
  "betano",
  "bwin",
  "william hill",
  "unibet",
  "pinnacle",
  "betfair",
  "marathonbet",
  "stake",
  "888sport",
  "sportingbet",
  "betway",
  "ladbrokes",
  "coral",
]);

// ===================== WEB SERVER (Render) =====================
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.listen(PORT, () => console.log("Web alive on", PORT));

// ===================== TELEGRAM =====================
const bot = new Telegraf(BOT_TOKEN);

let watching = false;
let debug = false;
let debugChatId = null;
const alerted = new Set();

async function dmsg(text) {
  if (!debug) return;
  const target = debugChatId || CHAT_ID;
  try {
    await bot.telegram.sendMessage(target, text);
  } catch (_) {}
}

bot.start((ctx) =>
  ctx.reply(
    "✅ Bot SofaScore listo.\n\n/watch activar\n/stop detener\n/status\n/debugon\n/debugoff\n/ping\n/reset"
  )
);

bot.command("ping", (ctx) => ctx.reply("🏓 PONG (vivo)"));
bot.command("watch", async (ctx) => { watching = true; await ctx.reply("🟢 ON"); });
bot.command("stop", async (ctx) => { watching = false; await ctx.reply("🔴 OFF"); });
bot.command("reset", async (ctx) => { alerted.clear(); await ctx.reply("🧹 alertas limpiadas"); });

bot.command("status", (ctx) =>
  ctx.reply(`Estado: ${watching ? "ACTIVO" : "DETENIDO"} | Debug: ${debug ? "ON" : "OFF"} | Alertas: ${alerted.size}`)
);

bot.command("debugon", async (ctx) => {
  debug = true;
  debugChatId = ctx.chat.id;
  await ctx.reply("🧪 Debug ON (en este chat)");
});

bot.command("debugoff", async (ctx) => {
  debug = false;
  debugChatId = null;
  await ctx.reply("🧪 Debug OFF");
});

// ===================== SOFASCORE FETCH HELPERS =====================
const BASES = ["https://www.sofascore.com", "https://api.sofascore.com"];

async function fetchJsonWithFallback(path, timeoutMs = 15000) {
  let lastErr = null;

  for (const base of BASES) {
    const url = base + path;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        method: "GET",
        headers: {
          "accept": "application/json,text/plain,*/*",
          "user-agent": "Mozilla/5.0 (compatible; open-games-bot/1.0)",
        },
        signal: controller.signal,
      });

      clearTimeout(t);

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${txt.slice(0, 120)}`);
      }

      return await res.json();
    } catch (e) {
      lastErr = new Error(`${url} -> ${e.message}`);
    }
  }

  throw lastErr || new Error("No pude obtener JSON (fallback agotado)");
}

async function getLiveFootballEvents() {
  // live/inverse suele devolver “más” eventos en algunas zonas
  try {
    const data = await fetchJsonWithFallback("/api/v1/sport/football/events/live/inverse");
    return data?.events || [];
  } catch (_) {
    const data = await fetchJsonWithFallback("/api/v1/sport/football/events/live");
    return data?.events || [];
  }
}

// Odds endpoint (se usa como /api/v1/event/{id}/odds/1/all). :contentReference[oaicite:2]{index=2}
async function getEventOdds(eventId) {
  return await fetchJsonWithFallback(`/api/v1/event/${eventId}/odds/1/all`, 20000);
}

// Team last events: si en tu región cambia, lo verás en debug y lo ajustamos.
async function getTeamLastEvents(teamId, n = 10) {
  // Endpoint usado ampliamente por clientes no oficiales (patrón /team/{id}/events/last/{n})
  const data = await fetchJsonWithFallback(`/api/v1/team/${teamId}/events/last/${n}`, 20000);
  return data?.events || [];
}

async function getEventStatistics(eventId) {
  return await fetchJsonWithFallback(`/api/v1/event/${eventId}/statistics`, 20000);
}

// ===================== PARSERS =====================
function isLive(event) {
  const type = String(event?.status?.type || "").toLowerCase();
  return type === "inprogress";
}

function formatScore(event) {
  const hs = event?.homeScore?.current;
  const as = event?.awayScore?.current;
  if (Number.isFinite(hs) && Number.isFinite(as)) return `${hs}-${as}`;
  return null;
}

function estimateMinute(event) {
  if (Number.isFinite(event?.time?.current)) return event.time.current;
  if (Number.isFinite(event?.status?.minute)) return event.status.minute;

  const start = event?.time?.currentPeriodStartTimestamp;
  if (Number.isFinite(start)) {
    const now = Math.floor(Date.now() / 1000);
    const mins = Math.floor((now - start) / 60);
    if (mins >= 0 && mins <= 130) return mins;
  }
  return null;
}

function compactEventName(event) {
  const home = event?.homeTeam?.name || "Home";
  const away = event?.awayTeam?.name || "Away";
  return `${home} vs ${away}`;
}

function safeNum(x) {
  const n = typeof x === "string" ? parseFloat(x.replace("%", "").trim()) : Number(x);
  return Number.isFinite(n) ? n : null;
}

// statistics suele venir como groups/items, pero puede variar, así que recorremos profundo
function extractStat(statsJson, wantedNames) {
  const allItems = [];
  function walk(obj) {
    if (!obj) return;
    if (Array.isArray(obj)) return obj.forEach(walk);
    if (typeof obj !== "object") return;

    if (Array.isArray(obj.items)) allItems.push(...obj.items);
    if (Array.isArray(obj.statisticsItems)) allItems.push(...obj.statisticsItems);

    Object.values(obj).forEach(walk);
  }
  walk(statsJson);

  const lowerWanted = wantedNames.map((s) => s.toLowerCase());
  for (const it of allItems) {
    const name = String(it?.name || it?.title || "").toLowerCase();
    if (!name) continue;
    for (const w of lowerWanted) {
      if (name === w || name.includes(w)) {
        return {
          name: it?.name || it?.title,
          home: safeNum(it?.home),
          away: safeNum(it?.away),
        };
      }
    }
  }
  return null;
}

function isOpenGameByStats(stats) {
  const hasRed = (stats.redCardsTotal || 0) >= 1;
  const sotMin = hasRed ? OPEN_RULES.redCard.sotTotalMin : OPEN_RULES.sotTotalMin;
  const corMin = hasRed ? OPEN_RULES.redCard.cornersTotalMin : OPEN_RULES.cornersTotalMin;

  const cond1 = (stats.sotTotal ?? 0) >= sotMin;
  const cond2 = (stats.cornersTotal ?? 0) >= corMin;
  const cond3 =
    (stats.possessionMax ?? 0) >= OPEN_RULES.possessionHighMin ||
    (stats.totalShots ?? 0) >= OPEN_RULES.totalShotsMin;

  return cond1 && cond2 && cond3;
}

function computeHistoryMetrics(events) {
  // Solo partidos finalizados
  const finished = events.filter((e) => String(e?.status?.type || "").toLowerCase() === "finished");
  if (!finished.length) return { avgGoals: null, pctOver25: null, sample: 0 };

  let totalGoalsSum = 0;
  let over25Count = 0;

  for (const e of finished) {
    const hs = e?.homeScore?.current;
    const as = e?.awayScore?.current;
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    const g = hs + as;
    totalGoalsSum += g;
    if (g >= 3) over25Count += 1;
  }

  const sample = finished.length;
  if (!sample) return { avgGoals: null, pctOver25: null, sample: 0 };

  return {
    avgGoals: totalGoalsSum / sample,
    pctOver25: over25Count / sample,
    sample,
  };
}

function historyIsGoleador(homeHist, awayHist) {
  // combinamos “fuerza goleadora” de ambos equipos
  const avgGoals = [homeHist.avgGoals, awayHist.avgGoals].filter((x) => x !== null);
  const pctOver = [homeHist.pctOver25, awayHist.pctOver25].filter((x) => x !== null);

  const avgOk = avgGoals.length ? (avgGoals.reduce((a, b) => a + b, 0) / avgGoals.length) >= HISTORY_RULES.avgGoalsMin : false;
  const pctOk = pctOver.length ? (pctOver.reduce((a, b) => a + b, 0) / pctOver.length) >= HISTORY_RULES.pctOver25Min : false;

  return avgOk || pctOk;
}

function extractRecognizedBookmakers(oddsJson) {
  // Recorremos profundo buscando arrays de "bookmakers" con "name"
  const names = new Set();

  function walk(obj) {
    if (!obj) return;
    if (Array.isArray(obj)) return obj.forEach(walk);
    if (typeof obj !== "object") return;

    if (Array.isArray(obj.bookmakers)) {
      for (const b of obj.bookmakers) {
        const n = String(b?.name || b?.bookmaker || "").trim();
        if (!n) continue;
        const key = n.toLowerCase();
        if (RECOGNIZED_BOOKIES.has(key)) names.add(n);
      }
    }

    Object.values(obj).forEach(walk);
  }

  walk(oddsJson);
  return [...names];
}

function buildAlert(event, minute, score, stats, homeHist, awayHist, bookies, reason) {
  const name = compactEventName(event);

  const hAvg = homeHist?.avgGoals != null ? homeHist.avgGoals.toFixed(2) : "N/A";
  const aAvg = awayHist?.avgGoals != null ? awayHist.avgGoals.toFixed(2) : "N/A";
  const hPct = homeHist?.pctOver25 != null ? Math.round(homeHist.pctOver25 * 100) + "%" : "N/A";
  const aPct = awayHist?.pctOver25 != null ? Math.round(awayHist.pctOver25 * 100) + "%" : "N/A";

  return `🚨 PARTIDO “ABIERTO” (SofaScore)

⚽ ${name}
⏱ Minuto: ${minute}'
🔢 Marcador: ${score}

✅ Motivo: ${reason}

📊 Stats (si hay):
- 🎯 SOT: ${stats?.sotTotal ?? "N/A"}
- 🥅 Tiros: ${stats?.totalShots ?? "N/A"}
- 🚩 Corners: ${stats?.cornersTotal ?? "N/A"}
- 🧠 Posesión máx: ${stats?.possessionMax != null ? stats.possessionMax + "%" : "N/A"}
- 🟥 Rojas: ${stats?.redCardsTotal ?? "N/A"}

📈 Historial (últimos ${HISTORY_N}):
- Home avgG: ${hAvg} | Over2.5: ${hPct}
- Away avgG: ${aAvg} | Over2.5: ${aPct}

💰 Bookies detectadas (${bookies.length}):
${bookies.slice(0, 8).join(", ")}${bookies.length > 8 ? " ..." : ""}`;
}

// ===================== MAIN LOOP =====================
async function poll() {
  if (debug) await dmsg(`⏱ Heartbeat. Watch=${watching ? "ON" : "OFF"}`);
  if (!watching) return;

  let events = [];
  try {
    events = await getLiveFootballEvents();
  } catch (e) {
    await dmsg(`❌ Error live list: ${e.message}`);
    return;
  }

  // 1) candidatos por minuto + marcador
  const candidates = [];
  for (const ev of events) {
    if (!isLive(ev)) continue;

    const minute = estimateMinute(ev);
    const score = formatScore(ev);

    if (!minute || !score) continue;
    if (minute < MINUTE_MIN) continue;
    if (!ALLOWED_SCORES.has(score)) continue;

    candidates.push({ ev, minute, score });
  }

  await dmsg(`DEBUG: Live=${events.length} | Candidatos=${candidates.length}`);

  // 2) evaluamos cada candidato
  for (const c of candidates) {
    const ev = c.ev;
    const eventId = ev?.id;
    const homeId = ev?.homeTeam?.id;
    const awayId = ev?.awayTeam?.id;

    if (!eventId || !homeId || !awayId) continue;

    // anti-spam: 2-min bucket
    const bucket = Math.floor(c.minute / 2);
    const key = `${eventId}|${c.score}|${bucket}`;
    if (alerted.has(key)) continue;

    // 2A) Odds/bookies (si no hay bookies reconocidas, lo saltamos)
    let bookies = [];
    try {
      const odds = await getEventOdds(eventId);
      bookies = extractRecognizedBookmakers(odds);
    } catch (e) {
      await dmsg(`⚠️ Odds error (${eventId}): ${e.message}`);
      // Si falla odds, mejor NO alertar (tu requisito: que salga en bookies)
      continue;
    }

    if (bookies.length < MIN_RECOGNIZED_BOOKIES) {
      await dmsg(`DEBUG ${compactEventName(ev)}: bookies=${bookies.length} (skip)`);
      continue;
    }

    // 2B) Stats (si existen)
    let statsObj = null;
    try {
      const st = await getEventStatistics(eventId);

      const sot = extractStat(st, ["Shots on target", "Disparos a puerta"]);
      const shots = extractStat(st, ["Total shots", "Shots", "Tiros totales"]);
      const corners = extractStat(st, ["Corner kicks", "Corners", "Saques de esquina"]);
      const poss = extractStat(st, ["Ball possession", "Possession", "Posesión"]);
      const red = extractStat(st, ["Red cards", "Rojas", "Tarjetas rojas"]);

      const sotTotal = (sot?.home ?? 0) + (sot?.away ?? 0);
      const totalShots = (shots?.home ?? 0) + (shots?.away ?? 0);
      const cornersTotal = (corners?.home ?? 0) + (corners?.away ?? 0);
      const possessionMax = Math.max(poss?.home ?? 0, poss?.away ?? 0);
      const redCardsTotal = (red?.home ?? 0) + (red?.away ?? 0);

      // si TODO está en 0 / null, consideramos “stats incompletas”
      const hasAny =
        (sotTotal || 0) + (totalShots || 0) + (cornersTotal || 0) + (possessionMax || 0) + (redCardsTotal || 0) > 0;

      if (hasAny) {
        statsObj = { sotTotal, totalShots, cornersTotal, possessionMax, redCardsTotal };
      }
    } catch (e) {
      await dmsg(`⚠️ Stats error (${eventId}): ${e.message}`);
    }

    const openByStats = statsObj ? isOpenGameByStats(statsObj) : false;

    // 2C) Histórico goleador (si stats faltan o para reforzar)
    let homeHist = { avgGoals: null, pctOver25: null, sample: 0 };
    let awayHist = { avgGoals: null, pctOver25: null, sample: 0 };

    try {
      const [homeEvents, awayEvents] = await Promise.all([
        getTeamLastEvents(homeId, HISTORY_N),
        getTeamLastEvents(awayId, HISTORY_N),
      ]);
      homeHist = computeHistoryMetrics(homeEvents);
      awayHist = computeHistoryMetrics(awayEvents);
    } catch (e) {
      await dmsg(`⚠️ History error (${compactEventName(ev)}): ${e.message}`);
    }

    const openByHistory = historyIsGoleador(homeHist, awayHist);

    // ✅ Decisión final:
    // - Debe tener bookies reconocidas (ya filtrado)
    // - y (openByStats OR openByHistory)
    const shouldAlert = openByStats || openByHistory;

    await dmsg(
      `DEBUG ${compactEventName(ev)} min=${c.minute} score=${c.score} | bookies=${bookies.length} | openStats=${openByStats} openHist=${openByHistory}`
    );

    if (!shouldAlert) continue;

    alerted.add(key);

    const reason = openByStats && openByHistory
      ? "Stats EN VIVO + histórico goleador"
      : openByStats
        ? "Stats EN VIVO (juego abierto)"
        : "Histórico goleador (3+ goles frecuente)";

    await bot.telegram.sendMessage(
      CHAT_ID,
      buildAlert(ev, c.minute, c.score, statsObj, homeHist, awayHist, bookies, reason)
    );
  }
}

setInterval(poll, POLL_MS);

bot.launch().then(() => console.log("Bot launched ✅"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
