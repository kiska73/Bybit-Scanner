// index.js
// Bybit Squeeze Scanner - versione 30m - credenziali hardcoded (NON caricare su repo pubblico!)

import axios from "axios";

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';
const BASE = "https://api.bybit.com";

let lastOI = {};
const REQUEST_DELAY_MS = 350;     // ~3 req/sec → sicuro con rate limit pubblici

// ────────────────────────────────────────────────
// FUNZIONI DI BASE
// ────────────────────────────────────────────────

async function sendTelegram(msg) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: msg,
      parse_mode: "Markdown"
    });
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getPairs() {
  try {
    const res = await axios.get(`${BASE}/v5/market/instruments-info`, {
      params: { category: "linear" }
    });
    return res.data.result.list
      .filter(p => p.quoteCoin === "USDT" && p.status === "Trading")
      .map(p => p.symbol);
  } catch (err) {
    console.error("getPairs error:", err.message);
    return [];
  }
}

async function getTicker(symbol) {
  const res = await axios.get(`${BASE}/v5/market/tickers`, {
    params: { category: "linear", symbol }
  });
  return res.data.result.list[0];
}

async function getKlines(symbol, interval = "30", limit = 11) {
  const res = await axios.get(`${BASE}/v5/market/kline`, {
    params: { category: "linear", symbol, interval, limit }
  });
  return res.data.result.list;
}

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
    const data = res.data.result.list?.[0];
    if (!data) return 1;
    const buy  = parseFloat(data.buyRatio)  || 0.5;
    const sell = parseFloat(data.sellRatio) || 0.5;
    return buy / sell; // >1 = più long, <1 = più short
  } catch {
    return 1;
  }
}

// ────────────────────────────────────────────────
// SCORING & CLASSIFICAZIONE
// ────────────────────────────────────────────────

function scoreSetup(data) {
  let score = 0;
  let bias = "NEUTRO";

  // OI spike
  if (data.oiChange > 6)   score += 4;
  if (data.oiChange > 10)  score += 5;

  // Range compresso
  if (data.range < 1.2) score += 3;
  if (data.range < 0.8) score += 4;

  // Volume spike
  if (data.volumeSpike > 2.2) score += 2;
  if (data.volumeSpike > 3.5) score += 4;

  // Funding estremo
  if (Math.abs(data.funding) > 0.0006) score += 2;
  if (Math.abs(data.funding) > 0.001)  score += 3;

  // Long/Short ratio (contrarian)
  const lsr = data.longShortRatio;
  if (lsr > 2.0) {
    score += 4;
    bias = "SHORT";
  } else if (lsr < 0.55) {
    score += 4;
    bias = "LONG";
  }

  // Rafforza bias con funding
  if (data.funding > 0.0008 && lsr > 1.8) bias = "SHORT";
  if (data.funding < -0.0008 && lsr < 0.6) bias = "LONG";

  return { score, bias };
}

function classify(score) {
  if (score >= 12) return "🔥 NUCLEARE";
  if (score >= 9)  return "🚀 OTTIMO";
  if (score >= 6)  return "✅ BUONO";
  return null;
}

// ────────────────────────────────────────────────
// ANALISI SINGOLO SIMBOLO
// ────────────────────────────────────────────────

async function scanSymbol(symbol) {
  try {
    const ticker = await getTicker(symbol);
    const klines = await getKlines(symbol, "30", 11);

    const oi     = parseFloat(ticker.openInterest || 0);
    const funding = parseFloat(ticker.fundingRate  || 0);

    // Protezione OI invalido
    if (lastOI[symbol] <= 0 || oi <= 0 || isNaN(oi) || isNaN(lastOI[symbol])) {
      lastOI[symbol] = oi;
      return;
    }

    const oiChange = ((oi - lastOI[symbol]) / lastOI[symbol]) * 100;
    lastOI[symbol] = oi;

    // Prezzi ultime 10 candele chiuse
    const prices = klines.slice(1, 11).map(k => parseFloat(k[4]));
    if (prices.length < 8) return;

    const high = Math.max(...prices);
    const low  = Math.min(...prices);
    const mid  = (high + low) / 2;
    const range = ((high - low) / mid) * 100;

    // Volume spike (candela chiusa precedente vs media)
    const volumes = klines.slice(1).map(k => parseFloat(k[5]));
    const avgVol = volumes.slice(1).reduce((a, b) => a + b, 0) / (volumes.length - 1 || 1);
    const volumeSpike = volumes[0] / avgVol;

    const longShortRatio = await getLongShortRatio(symbol);

    const data = { oiChange, funding, range, volumeSpike, longShortRatio };
    const { score, bias } = scoreSetup(data);
    const quality = classify(score);

    if (!quality) return;

    const msg = 
      `*${quality} SIGNAL* 🚨\n\n` +
      `**${symbol}**   |   ${bias}\n` +
      `Score: **${score}**\n` +
      `OI Δ: ${oiChange.toFixed(1)}%\n` +
      `Funding: ${funding.toFixed(6)}\n` +
      `Range (~5h): ${range.toFixed(2)}%\n` +
      `Vol Spike: ${volumeSpike.toFixed(1)}x\n` +
      `L/S ratio: ${longShortRatio.toFixed(2)}\n` +
      `\n${new Date().toLocaleTimeString('it-IT')}`;

    console.log(msg.replace(/\*/g, ''));
    await sendTelegram(msg);

  } catch (err) {
    if (!err.message?.includes("404") && !err.message?.includes("429")) {
      console.log(`${symbol} → error: ${err.message}`);
    }
  }
}

// ────────────────────────────────────────────────
// SCANNER PRINCIPALE
// ────────────────────────────────────────────────

async function scanner() {
  console.log(`\n─────────────── ${new Date().toLocaleString('it-IT')} ───────────────`);
  const pairs = await getPairs();
  console.log(`Scanning ${pairs.length} USDT perpetual pairs...`);

  for (const symbol of pairs) {
    try {
      await scanSymbol(symbol);
    } catch (e) {
      console.error(`Critical error scanning ${symbol}:`, e.message);
    }
    await delay(REQUEST_DELAY_MS);
  }

  console.log("Scan completato.\n");
}

// AVVIO
console.log("Bybit Squeeze Scanner avviato...");
scanner();                           // prima esecuzione immediata
setInterval(scanner, 30 * 60 * 1000); // poi ogni 30 minuti
