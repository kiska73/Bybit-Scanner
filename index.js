// BYBIT SQUEEZE SCANNER PRO V8 – Final Clean Version
// Real Data: OI spike + Funding + L/S Ratio (con trend) + Compression + Volume Spike

const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const BASE = "https://api.bybit.com";

let lastOI = {};

const REQUEST_DELAY_MS = 2200;          // Conservativo per rate-limit Bybit
const BATCH_SIZE       = 2;
const SCAN_INTERVAL_MS = 1000 * 60 * 10; // 10 minuti – bilanciato

// ────────────────────────────────────────────────

async function sendTelegram(msg) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: msg.trim(),
      parse_mode: "HTML"
    });
  } catch (err) {
    console.error("Telegram failed:", err.message);
  }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ────────────────────────────────────────────────

async function getPairs() {
  try {
    const res = await axios.get(`${BASE}/v5/market/instruments-info`, {
      params: { category: "linear" },
      timeout: 15000
    });

    if (res.data.retCode !== 0) {
      console.error("instruments-info error:", res.data.retMsg);
      await sendTelegram("⚠️ Errore API Bybit (instruments-info)");
      return [];
    }

    return res.data.result.list
      .filter(p => p.quoteCoin === "USDT" && p.status === "Trading")
      .filter(p => parseFloat(p.turnover24h || 0) > 6_000_000) // più selettivo
      .map(p => p.symbol);

  } catch (err) {
    console.error("getPairs crash:", err.message);
    await sendTelegram("❌ Impossibile caricare lista simboli Bybit");
    return [];
  }
}

// ────────────────────────────────────────────────

async function getTicker(symbol) {
  try {
    const res = await axios.get(`${BASE}/v5/market/tickers`, {
      params: { category: "linear", symbol },
      timeout: 10000
    });
    if (res.data.retCode !== 0) return null;
    return res.data.result.list?.[0] || null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────

async function getKlines(symbol) {
  try {
    const res = await axios.get(`${BASE}/v5/market/kline`, {
      params: { category: "linear", symbol, interval: "30", limit: 12 },
      timeout: 10000
    });
    if (res.data.retCode !== 0) return [];
    return res.data.result.list || [];
  } catch {
    return [];
  }
}

// ────────────────────────────────────────────────

async function getLongShortRatio(symbol) {
  try {
    const res = await axios.get(`${BASE}/v5/market/account-ratio`, {
      params: { category: "linear", symbol, period: "1h", limit: 5 },
      timeout: 10000
    });

    if (res.data.retCode !== 0) return { ratio: 1, change: 0 };

    const list = res.data.result?.list || [];
    if (list.length === 0) return { ratio: 1, change: 0 };

    const latest = list[0];
    const buy  = parseFloat(latest.buyRatio  || 0);
    const sell = parseFloat(latest.sellRatio || 0);
    const ratio = sell > 0.001 ? buy / sell : 1;

    let prevRatio = ratio;
    if (list.length >= 2) {
      const prev = list[1];
      const pBuy  = parseFloat(prev.buyRatio  || 0);
      const pSell = parseFloat(prev.sellRatio || 0);
      prevRatio = pSell > 0.001 ? pBuy / pSell : ratio;
    }

    const change = prevRatio > 0 ? ((ratio - prevRatio) / prevRatio) * 100 : 0;
    return { ratio, change };
  } catch {
    return { ratio: 1, change: 0 };
  }
}

// ────────────────────────────────────────────────

function classify(score) {
  if (score >= 25) return "🔥 NUCLEAR SQUEEZE";
  if (score >= 20) return "🚀 HIGH PROBABILITY";
  if (score >= 16) return "⚠️ BUILDING PRESSURE";
  return null;
}

// ────────────────────────────────────────────────

async function scanSymbol(symbol, signals) {
  try {
    const ticker = await getTicker(symbol);
    if (!ticker) return;

    const volume24h = parseFloat(ticker.turnover24h || 0);
    if (volume24h < 6_000_000) return;

    const klines = await getKlines(symbol);
    if (klines.length < 6) return;

    const oi = parseFloat(ticker.openInterest || 0);
    if (oi <= 0) return;

    const funding = parseFloat(ticker.fundingRate || 0);
    const lastClose = parseFloat(klines[0][4]) || 0;
    if (lastClose <= 0) return;

    const oiUsd = oi * lastClose;
    if (oiUsd < 7_000_000) return;

    // OI Δ
    let oiChange = 0;
    if (lastOI[symbol]) {
      oiChange = ((oi - lastOI[symbol]) / lastOI[symbol]) * 100;
    }
    lastOI[symbol] = oi;

    if (Math.abs(oiChange) < 7) return;

    const oiVolumeRatio = oiUsd / volume24h;

    // Range
    const highs = klines.map(k => parseFloat(k[2]) || 0);
    const lows  = klines.map(k => parseFloat(k[3]) || 0);
    const high = Math.max(...highs);
    const low  = Math.min(...lows);
    const range = high > 0 && low > 0 ? ((high - low) / ((high + low) / 2)) * 100 : 999;

    if (range > 1.6) return;

    const closes = klines.map(k => parseFloat(k[4]) || 0);
    const prevClose = closes[1] || lastClose;
    const priceChange = prevClose > 0 ? ((lastClose - prevClose) / prevClose) * 100 : 0;

    // Volume spike
    const volumes = klines.map(k => parseFloat(k[5]) || 0);
    const recentVol = volumes.slice(0, 4).filter(v => v > 0);
    const olderVol  = volumes.slice(4).filter(v => v > 0);

    const avgRecent = recentVol.length ? recentVol.reduce((a,b)=>a+b,0)/recentVol.length : 0;
    const avgOlder  = olderVol.length ? olderVol.reduce((a,b)=>a+b,0)/olderVol.length : avgRecent;

    const currentVol = volumes[0];
    let volumeBonus = 0;

    if (currentVol > avgOlder * 3.2 && avgOlder > 0) volumeBonus = 6;
    else if (currentVol > avgRecent * 2.5 && currentVol > avgOlder * 1.8) volumeBonus = 4;
    else if (currentVol > avgRecent * 1.9) volumeBonus = 2;

    // L/S Ratio
    const lsrData = await getLongShortRatio(symbol);
    const lsr = lsrData.ratio;
    const lsrChange = lsrData.change;

    let score = volumeBonus;
    let bias = "NEUTRAL";

    // ── Scoring ────────────────────────────────────────
    // OI spike
    if (oiChange > 30) score += 11;
    else if (oiChange > 20) score += 8;
    else if (oiChange > 10) score += 5;

    // Leverage proxy
    if (oiVolumeRatio > 0.85) score += 9;
    else if (oiVolumeRatio > 0.60) score += 6;
    else if (oiVolumeRatio > 0.40) score += 3;

    // Compression
    if (range < 0.50) score += 8;
    else if (range < 0.85) score += 5;

    // Funding estremo
    if (Math.abs(funding) > 0.0018) score += 6;

    // L/S imbalance (valori reali Bybit)
    if (lsr < 0.35) { score += 11; bias = "LONG"; }
    else if (lsr > 3.8) { score += 10; bias = "SHORT"; }
    else if (lsr < 0.45) { score += 7; bias = "LONG"; }
    else if (lsr > 2.8) { score += 7; bias = "SHORT"; }

    // Trend L/S
    if (bias === "LONG"  && lsrChange < -30) score += 6;
    if (bias === "SHORT" && lsrChange > +45) score += 7;

    // Trapped momentum
    if (bias === "SHORT" && priceChange > 0.9) score += 5;
    if (bias === "LONG"  && priceChange < -0.9) score += 5;

    const quality = classify(score);
    if (!quality) return;

    const message = `
<b>${quality}</b> 🚨
<b>${symbol}</b> | ${bias}

Score: <b>${score}</b>

OI Δ: ${oiChange.toFixed(1)}%  
OI/Vol: ${oiVolumeRatio.toFixed(2)}
Funding: ${funding.toFixed(5)}
Range 6h: ${range.toFixed(2)}%
Price Δ: ${priceChange.toFixed(2)}%
L/S Ratio: ${lsr.toFixed(2)} (Δ ${lsrChange.toFixed(1)}%)
Volume bonus: ${volumeBonus}

${new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" })}
    `.trim();

    signals.push({ score, msg: message });

  } catch (err) {
    console.log(`${symbol} error → ${err.message}`);
  }
}

// ────────────────────────────────────────────────

async function scanner() {
  const now = new Date().toLocaleString("it-IT");
  console.log(`\n══════ SCAN START ── ${now} ══════`);

  const pairs = await getPairs();
  console.log(`Coppie da scansionare: ${pairs.length}`);

  if (pairs.length === 0) {
    console.log("Nessuna coppia valida trovata");
    return;
  }

  let signals = [];

  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(s => scanSymbol(s, signals)));
    await delay(REQUEST_DELAY_MS);
  }

  if (signals.length > 0) {
    signals
      .sort((a, b) => b.score - a.score)
      .slice(0, 8) // max 8 segnali per scan
      .forEach(s => {
        console.log(s.msg.replace(/<[^>]+>/g, ''));
        sendTelegram(s.msg);
      });
  } else {
    console.log("Nessun segnale questa volta");
  }
}

// ────────────────────────────────────────────────

console.log("Bybit Squeeze Scanner V8 – avviato correttamente");

(async () => {
  while (true) {
    try {
      await scanner();
    } catch (err) {
      console.error("CRASH nel loop principale:", err);
      await sendTelegram(`❌ Scanner crash: ${err.message}`);
    }
    await delay(SCAN_INTERVAL_MS);
  }
})();
