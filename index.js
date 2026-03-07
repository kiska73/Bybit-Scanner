// BYBIT SQUEEZE SCANNER PRO V5
// Aggiornato 7 marzo 2026 - Versione definitiva e completa
// Tutte le correzioni applicate (parsing L/S, range, ranking, volume safety)

import axios from "axios";

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const BASE = "https://api.bybit.com";

let lastOI = {};

const REQUEST_DELAY_MS = 650;
const MAX_PARALLEL = 3;

//─────────────────────────────

async function sendTelegram(msg) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "Markdown"
      }
    );
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

//─────────────────────────────

async function getPairs() {
  const res = await axios.get(`${BASE}/v5/market/instruments-info`, {
    params: { category: "linear" }
  });

  return res.data.result.list
    .filter(p => p.quoteCoin === "USDT" && p.status === "Trading")
    .map(p => p.symbol);
}

//─────────────────────────────

async function getTicker(symbol) {
  const res = await axios.get(`${BASE}/v5/market/tickers`, {
    params: { category: "linear", symbol }
  });
  return res.data.result.list[0];
}

//─────────────────────────────

async function getKlines(symbol) {
  const res = await axios.get(`${BASE}/v5/market/kline`, {
    params: {
      category: "linear",
      symbol,
      interval: "30",
      limit: 12
    }
  });
  return res.data.result.list;
}

//─────────────────────────────
// LONG/SHORT RATIO - PARSING SICURO (correzione #1)
//─────────────────────────────
async function getLongShortRatio(symbol) {
  try {
    const res = await axios.get(`${BASE}/v5/market/account-ratio`, {
      params: {
        category: "linear",
        symbol,
        period: "30min",
        limit: 1
      }
    });

    const d = res.data.result.list?.[0];
    if (!d) return 1;

    const buy  = parseFloat(d.buyRatio);
    const sell = parseFloat(d.sellRatio);

    if (!buy || !sell) return 1;           // evita NaN
    if (sell < 0.01) return 999;

    return buy / sell;

  } catch (err) {
    if (!err.message.includes("404") && !err.message.includes("429")) {
      console.log(symbol, "errore L/S ratio:", err.message);
    }
    return 1;
  }
}

//─────────────────────────────

function classify(score) {
  if (score >= 19) return "🔥 NUCLEARE";
  if (score >= 15) return "🚀 ALTA";
  if (score >= 11) return "✅ BUONA";
  return null;
}

//─────────────────────────────

async function scanSymbol(symbol, signals) {
  try {
    const ticker = await getTicker(symbol);
    const volume24h = parseFloat(ticker.turnover24h || 0);
    if (volume24h < 2000000) return;

    const klines = await getKlines(symbol);
    const oi = parseFloat(ticker.openInterest || 0);
    const funding = parseFloat(ticker.fundingRate || 0);

    let oiChange = 0;
    if (lastOI[symbol]) {
      oiChange = ((oi - lastOI[symbol]) / lastOI[symbol]) * 100;
    }
    lastOI[symbol] = oi;

    if (oi < 500000) return;
    if (oiChange < 5) return;

    // Range 6h - correzione #2
    const allCloses = klines.map(k => parseFloat(k[4]));
    const lastClose = allCloses[0];
    const high = Math.max(...allCloses);
    const low = Math.min(...allCloses);
    const mid = (high + low) / 2;
    const range = ((high - low) / mid) * 100;

    if (range > 1.8) return;

    // Price change
    const prevClose = allCloses[1] || lastClose;
    const priceChange = ((lastClose - prevClose) / prevClose) * 100;

    // Volume spike - correzione #4 (sicurezza avgVol = 0)
    const currentVol = parseFloat(klines[0][5]);
    const prevVolumes = klines.slice(1).map(k => parseFloat(k[5]));
    const avgVol = prevVolumes.reduce((a, b) => a + b, 0) / (prevVolumes.length || 1);

    if (avgVol === 0) return;

    const volumeSpike = currentVol / avgVol;
    if (volumeSpike < 1.8) return;

    const lsr = await getLongShortRatio(symbol);

    let score = 0;
    let bias = "NEUTRO";

    // OI
    if (oiChange > 20) score += 8;
    else if (oiChange > 12) score += 5;
    else if (oiChange > 7) score += 3;

    // Range
    if (range < 0.7) score += 4;
    else if (range < 1.0) score += 2;

    // Volume
    if (volumeSpike > 3.5) score += 5;
    else if (volumeSpike > 2.2) score += 3;
    else if (volumeSpike > 1.8) score += 1;

    // Funding
    if (Math.abs(funding) > 0.001) score += 3;
    else if (Math.abs(funding) > 0.0006) score += 1;

    // L/S Ratio
    if (lsr > 2.8) { score += 5; bias = "SHORT"; }
    else if (lsr < 0.40) { score += 5; bias = "LONG"; }
    else if (lsr > 2.0) { score += 2; bias = "SHORT"; }
    else if (lsr < 0.55) { score += 2; bias = "LONG"; }

    // Price direction
    if (bias === "SHORT" && priceChange > 0.6) score += 2;
    if (bias === "LONG" && priceChange < -0.6) score += 2;

    if (oi < 800000) score = Math.max(0, score - 3);

    const quality = classify(score);
    if (!quality) return;

    signals.push({
      score,
      funding: Math.abs(funding),
      msg: `*${quality} SIGNAL* 🚨

*${symbol}* | ${bias}

Score: *${score}*
OI Δ: ${oiChange.toFixed(2)}%
Funding: ${funding.toFixed(6)}
Range 6h: ${range.toFixed(2)}%
Price Δ: ${priceChange.toFixed(2)}%
Vol Spike: ${volumeSpike.toFixed(2)}x
L/S Ratio: ${lsr.toFixed(2)}

${new Date().toLocaleTimeString("it-IT")}`
    });

  } catch (err) {
    if (!err.message.includes("404") && !err.message.includes("429")) {
      console.log(symbol, "errore:", err.message);
    }
  }
}

//─────────────────────────────

async function scanner() {
  console.log("\n=== SCAN INIZIATO ===", new Date().toLocaleString("it-IT"));

  const pairs = await getPairs();
  let signals = [];

  for (let i = 0; i < pairs.length; i += MAX_PARALLEL) {
    const batch = pairs.slice(i, i + MAX_PARALLEL);
    await Promise.all(batch.map(s => scanSymbol(s, signals)));
    await delay(REQUEST_DELAY_MS);
  }

  // Ranking corretto - correzione #3
  signals
    .sort((a, b) => (b.score + b.funding * 1000) - (a.score + a.funding * 1000))
    .slice(0, 6)
    .forEach(s => {
      console.log(s.msg.replace(/\*/g, ""));
      sendTelegram(s.msg);
    });

  console.log("Scan completato -", signals.length, "segnali trovati");
}

//─────────────────────────────

console.log("🚀 Bybit Squeeze Scanner PRO V5 avviato - marzo 2026");
scanner();
setInterval(scanner, 30 * 60 * 1000);
