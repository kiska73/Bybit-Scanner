// BYBIT SQUEEZE SCANNER PRO V2
// 30m timeframe

import axios from "axios";

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const BASE = "https://api.bybit.com";

let lastOI = {};

const REQUEST_DELAY_MS = 350;
const MAX_PARALLEL = 5;

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
    params: {
      category: "linear",
      symbol
    }
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

    const buy = parseFloat(d.buyRatio || 0.5);
    const sell = parseFloat(d.sellRatio || 0.5);

    return buy / sell;

  } catch {
    return 1;
  }
}

//─────────────────────────────

function classify(score) {

  if (score >= 15) return "🔥 NUCLEARE";
  if (score >= 12) return "🚀 ALTA";
  if (score >= 9) return "✅ BUONA";

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

    if (!lastOI[symbol]) {
      lastOI[symbol] = oi;
      return;
    }

    const oiChange = ((oi - lastOI[symbol]) / lastOI[symbol]) * 100;

    lastOI[symbol] = oi;

    if (oiChange < 5) return;

    const closes = klines.slice(1).map(k => parseFloat(k[4]));
    const lastClose = parseFloat(klines[0][4]);

    const high = Math.max(...closes);
    const low = Math.min(...closes);

    const mid = (high + low) / 2;

    const range = ((high - low) / mid) * 100;

    if (range > 2) return;

    const priceChange = ((lastClose - closes[0]) / closes[0]) * 100;

    const volumes = klines.slice(1).map(k => parseFloat(k[5]));

    const avgVol =
      volumes.slice(1).reduce((a, b) => a + b, 0) / (volumes.length - 1 || 1);

    const volumeSpike = volumes[0] / avgVol;

    if (volumeSpike < 1.8) return;

    const lsr = await getLongShortRatio(symbol);

    let score = 0;
    let bias = "NEUTRO";

//─────────────────────────────
// OI SCORE
//─────────────────────────────

    if (oiChange > 6) score += 3;
    if (oiChange > 10) score += 5;
    if (oiChange > 15) score += 6;

//─────────────────────────────
// RANGE COMPRESSION
//─────────────────────────────

    if (range < 1.2) score += 2;
    if (range < 0.8) score += 3;

//─────────────────────────────
// VOLUME
//─────────────────────────────

    if (volumeSpike > 2) score += 2;
    if (volumeSpike > 3.5) score += 4;

//─────────────────────────────
// FUNDING
//─────────────────────────────

    if (Math.abs(funding) > 0.0008) score += 2;

//─────────────────────────────
// LONG SHORT BIAS
//─────────────────────────────

    if (lsr > 2.5) {

      score += 4;
      bias = "SHORT";

    }

    if (lsr < 0.45) {

      score += 4;
      bias = "LONG";

    }

//─────────────────────────────
// PRICE DIRECTION FILTER
//─────────────────────────────

    if (bias === "SHORT" && priceChange > 0.5) score += 1;

    if (bias === "LONG" && priceChange < -0.5) score += 1;

//─────────────────────────────

    const quality = classify(score);

    if (!quality) return;

//─────────────────────────────

    const msg =
`*${quality} SIGNAL* 🚨

*${symbol}* | ${bias}

Score: *${score}*

OI Δ: ${oiChange.toFixed(2)}%
Funding: ${funding.toFixed(6)}
Range 5h: ${range.toFixed(2)}%
Price Δ: ${priceChange.toFixed(2)}%
Vol Spike: ${volumeSpike.toFixed(2)}x
L/S Ratio: ${lsr.toFixed(2)}

${new Date().toLocaleTimeString("it-IT")}`;

//─────────────────────────────

    signals.push({ score, msg });

  } catch (err) {

    if (
      !err.message.includes("404") &&
      !err.message.includes("429")
    ) {
      console.log(symbol, "error", err.message);
    }

  }

}

//─────────────────────────────

async function scanner() {

  console.log("\nSCAN", new Date().toLocaleString("it-IT"));

  const pairs = await getPairs();

  let signals = [];

  for (let i = 0; i < pairs.length; i += MAX_PARALLEL) {

    const batch = pairs.slice(i, i + MAX_PARALLEL);

    await Promise.all(
      batch.map(s => scanSymbol(s, signals))
    );

    await delay(REQUEST_DELAY_MS);

  }

  signals
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .forEach(s => {

      console.log(s.msg.replace(/\*/g, ""));
      sendTelegram(s.msg);

    });

  console.log("Scan completato");

}

//─────────────────────────────

console.log("Bybit Squeeze Scanner PRO v2 avviato");

scanner();

setInterval(scanner, 30 * 60 * 1000);
