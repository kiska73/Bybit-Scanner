// BYBIT SQUEEZE SCANNER PRO V6 - Hardcoded credentials (NO ENV)
// Focus: leverage compression + imbalance + OI spike

const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const BASE = "https://api.bybit.com";

let lastOI = {};

const REQUEST_DELAY_MS = 1800;          // ms tra una richiesta e la successiva in batch
const BATCH_SIZE       = 2;             // quante richieste parallele al massimo
const SCAN_INTERVAL_MS = 1000 * 60 * 7; // scan ogni \~7 minuti

// ────────────────────────────────────────────────

async function sendTelegram(msg) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: msg,
      parse_mode: "Markdown"
    });
  } catch (err) {
    console.error("Errore invio Telegram:", err.message);
  }
}

// ────────────────────────────────────────────────

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ────────────────────────────────────────────────

async function getPairs() {
  try {
    const res = await axios.get(`${BASE}/v5/market/instruments-info`, {
      params: { category: "linear" },
      timeout: 10000
    });

    return res.data.result.list
      .filter(p => p.quoteCoin === "USDT" && p.status === "Trading")
      // Filtro volume per non sprecare richieste su micro-coin
      .filter(p => parseFloat(p.turnover24h || 0) > 4_000_000)
      .map(p => p.symbol);
  } catch (err) {
    console.error("Errore getPairs:", err.message);
    await sendTelegram("⚠️ Impossibile ottenere lista simboli da Bybit");
    return [];
  }
}

// ────────────────────────────────────────────────

async function getTicker(symbol) {
  try {
    const res = await axios.get(`${BASE}/v5/market/tickers`, {
      params: { category: "linear", symbol },
      timeout: 8000
    });
    return res.data.result.list?.[0] || null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────

async function getKlines(symbol) {
  try {
    const res = await axios.get(`${BASE}/v5/market/kline`, {
      params: {
        category: "linear",
        symbol,
        interval: "30",
        limit: 12
      },
      timeout: 8000
    });
    return res.data.result.list || [];
  } catch {
    return [];
  }
}

// ────────────────────────────────────────────────

async function getLongShortRatio(symbol) {
  try {
    const res = await axios.get(`${BASE}/v5/market/account-ratio`, {
      params: {
        category: "linear",
        symbol,
        period: "30min",
        limit: 1
      },
      timeout: 8000
    });

    const d = res.data.result?.list?.[0];
    if (!d) return 1;

    const buy  = parseFloat(d.buyRatio  || 0);
    const sell = parseFloat(d.sellRatio || 0);

    return (sell > 0.001) ? buy / sell : 1;
  } catch {
    return 1;
  }
}

// ────────────────────────────────────────────────

function classify(score) {
  if (score >= 20) return "🔥 NUCLEAR SQUEEZE";
  if (score >= 16) return "🚀 HIGH PROBABILITY";
  if (score >= 12) return "⚠️ BUILDING PRESSURE";
  return null;
}

// ────────────────────────────────────────────────

async function scanSymbol(symbol, signals) {
  try {
    const ticker = await getTicker(symbol);
    if (!ticker) return;

    const volume24h = parseFloat(ticker.turnover24h || 0);
    if (volume24h < 3_000_000) return;

    const klines = await getKlines(symbol);
    if (klines.length < 3) return;

    const oi = parseFloat(ticker.openInterest || 0);
    const funding = parseFloat(ticker.fundingRate || 0);
    const lastClose = parseFloat(klines[0][4]);

    const oiUsd = oi * lastClose;
    if (oiUsd < 4_000_000) return;

    let oiChange = 0;
    if (lastOI[symbol]) {
      oiChange = ((oi - lastOI[symbol]) / lastOI[symbol]) * 100;
    }
    lastOI[symbol] = oi;

    if (Math.abs(oiChange) < 5.5) return;

    const oiVolumeRatio = oiUsd / volume24h;

    // Range compression ultime \~6 ore
    const closes = klines.map(k => parseFloat(k[4]));
    const high = Math.max(...closes);
    const low  = Math.min(...closes);
    const mid  = (high + low) / 2;
    const range = ((high - low) / mid) * 100;

    if (range > 1.8) return;

    const prevClose   = closes[1] || lastClose;
    const priceChange = ((lastClose - prevClose) / prevClose) * 100;

    const lsr = await getLongShortRatio(symbol);

    let score = 0;
    let bias  = "NEUTRAL";

    // ── Scoring ───────────────────────────────────────

    // OI spike
    if      (oiChange > 22) score += 9;
    else if (oiChange > 14) score += 6;
    else if (oiChange > 7)  score += 3;

    // Leverage proxy (OI/Volume)
    if      (oiVolumeRatio > 0.75) score += 7;
    else if (oiVolumeRatio > 0.50) score += 5;
    else if (oiVolumeRatio > 0.30) score += 2;

    // Compression
    if      (range < 0.65) score += 6;
    else if (range < 1.00) score += 3;

    // Funding
    if      (Math.abs(funding) > 0.0012) score += 4;
    else if (Math.abs(funding) > 0.0007) score += 2;

    // Long/Short imbalance
    if      (lsr > 3.0)  { score += 6; bias = "SHORT"; }
    else if (lsr < 0.33) { score += 6; bias = "LONG";  }
    else if (lsr > 2.0)  { score += 3; bias = "SHORT"; }
    else if (lsr < 0.50) { score += 3; bias = "LONG";  }

    // Trapped momentum
    if (bias === "SHORT" && priceChange > 0.6) score += 3;
    if (bias === "LONG"  && priceChange < -0.6) score += 3;

    const quality = classify(score);
    if (!quality) return;

    const message = 
`*${quality}* 🚨

*${symbol}*  |  ${bias}

**Score:** ${score}

OI Δ: ${oiChange.toFixed(2)}%  
OI/Vol: ${oiVolumeRatio.toFixed(2)}

Funding: ${funding.toFixed(5)}

Range 6h: ${range.toFixed(2)}%  
Price Δ (30m): ${priceChange.toFixed(2)}%

L/S: ${lsr.toFixed(2)}

${new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" })}`;

    signals.push({ score, msg: message });

  } catch (err) {
    console.log(`${symbol} → ${err.message}`);
  }
}

// ────────────────────────────────────────────────

async function scanner() {
  console.log(`\n══════ SCAN START ── ${new Date().toLocaleString("it-IT")} ══════`);

  const pairs = await getPairs();
  console.log(`Trovate ${pairs.length} coppie con volume sufficiente`);

  if (pairs.length === 0) return;

  let signals = [];

  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(s => scanSymbol(s, signals)));
    await delay(REQUEST_DELAY_MS);
  }

  if (signals.length > 0) {
    signals
      .sort((a, b) => b.score - a.score)
      .slice(0, 7)
      .forEach(s => {
        console.log(s.msg.replace(/\*/g, ''));
        sendTelegram(s.msg);
      });
  } else {
    console.log("Nessun segnale valido in questo scan.");
  }
}

// ────────────────────────────────────────────────
//                   AVVIO
// ────────────────────────────────────────────────

console.log("Squeeze Scanner avviato (credenziali hardcoded)");

(async () => {
  while (true) {
    try {
      await scanner();
    } catch (err) {
      console.error("CRASH nel ciclo principale:", err);
      await sendTelegram(`❌ Scanner crash: ${err.message}`);
    }
    await delay(SCAN_INTERVAL_MS);
  }
})();
