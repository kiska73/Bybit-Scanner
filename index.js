const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const BASE = "https://api.bybit.com";
let lastOI = {};

const SCAN_INTERVAL = 1000 * 60 * 30;   // 30 minuti
const MAX_CONCURRENT = 5;                // massimo 5 richieste in parallelo

//────────────────────────────
async function sendTelegram(msg) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: msg.trim(), parse_mode: "HTML" }
    );
  } catch (err) { console.log("❌ Telegram error:", err.message); }
}

//────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

//────────────────────────────
async function getPairs() {
  try {
    const res = await axios.get(`${BASE}/v5/market/instruments-info`, {
      params: { category: "linear" }, timeout: 10000
    });
    if (res.data.retCode !== 0) return [];
    return res.data.result.list
      .filter(p => p.quoteCoin === "USDT" && p.status === "Trading")
      .map(p => p.symbol);
  } catch { return []; }
}

//────────────────────────────
async function getTicker(symbol) {
  try {
    const res = await axios.get(`${BASE}/v5/market/tickers`, {
      params: { category: "linear", symbol }, timeout: 8000
    });
    return res.data.result.list?.[0] || null;
  } catch { return null; }
}

async function getHolderRatio(symbol) {
  try {
    const res = await axios.get(`${BASE}/v5/market/account-ratio`, {
      params: { category: "linear", symbol, period: "1h", limit: 1, accountType: 0 }, timeout: 8000
    });
    const d = res.data.result.list?.[0]; if (!d) return 1;
    const buy = parseFloat(d.buyRatio) || 0, sell = parseFloat(d.sellRatio) || 0;
    return sell > 0.001 ? buy / sell : 1;
  } catch { return 1; }
}

async function getTopTraderRatio(symbol) {
  try {
    const res = await axios.get(`${BASE}/v5/market/account-ratio`, {
      params: { category: "linear", symbol, period: "1h", limit: 1, accountType: 1 }, timeout: 8000
    });
    const d = res.data.result.list?.[0]; if (!d) return 1;
    const buy = parseFloat(d.buyRatio) || 0, sell = parseFloat(d.sellRatio) || 0;
    return sell > 0.001 ? buy / sell : 1;
  } catch { return 1; }
}

//────────────────────────────
function checkDivergence(holder, top) {
  if (holder > 2.5 && top < 0.7) return { type: "SHORT", strength: "STRONG" };
  if (holder > 1.5 && top < 0.9) return { type: "SHORT", strength: "NORMAL" };
  if (holder < 0.5 && top > 2.0) return { type: "LONG",  strength: "STRONG" };
  if (holder < 0.7 && top > 1.5) return { type: "LONG",  strength: "NORMAL" };
  return null;
}

function checkExtremeTrend(holder, top, prevOI, currentOI) {
  if (prevOI && currentOI <= prevOI) return null;
  if (holder > 2 && top > 2) return { type: "LONG", strength: "EXTREME" };
  if (holder < 0.5 && top < 0.5) return { type: "SHORT", strength: "EXTREME" };
  return null;
}

function classifyQuality(oiMc) {
  if (oiMc > 0.08) return "🔥 HIGH QUALITY";
  if (oiMc > 0.05) return "⚡ LOW QUALITY";
  return null;
}

//────────────────────────────
async function scanSymbol(symbol) {
  try {
    const ticker = await getTicker(symbol); if (!ticker) return;
    const price  = parseFloat(ticker.lastPrice);
    const oi     = parseFloat(ticker.openInterest);
    const volume = parseFloat(ticker.turnover24h);
    if (volume < 2_000_000 || !price || !oi || oi <= 0) return;

    const prevOI = lastOI[symbol]; lastOI[symbol] = oi;

    const holder = await getHolderRatio(symbol);
    const top    = await getTopTraderRatio(symbol);

    const div = checkDivergence(holder, top) || checkExtremeTrend(holder, top, prevOI, oi);
    if (!div) return;

    const oiUsd = oi * price;
    const marketCapProxy = volume * 3;
    const oiMc = oiUsd / marketCapProxy;
    const quality = classifyQuality(oiMc);
    if (!quality) return;

    const direction = div.type === "SHORT" ? "🚨 Possible SHORT" : "🚨 Possible LONG";

    const msg = `
<b>${quality}</b>

<b>${symbol}</b>

${direction} (${div.strength})

Holder L/S: <b>${holder.toFixed(2)}</b> ← Retail
Top Trader L/S: <b>${top.toFixed(2)}</b> ← Whales/Top 100

OI/MC: <b>${oiMc.toFixed(3)}</b>
Volume 24h: <b>${(volume/1_000_000).toFixed(1)}M</b>

${new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" })}
    `.trim();

    console.log(`✅ SEGNALE: ${symbol} → ${direction} (Vol: ${(volume/1_000_000).toFixed(1)}M)`);
    await sendTelegram(msg);

  } catch (err) { console.log(`${symbol} → errore: ${err.message}`); }
}

//────────────────────────────
// Funzione per parallelizzare le scansioni
async function scanAllSymbols(pairs) {
  for (let i = 0; i < pairs.length; i += MAX_CONCURRENT) {
    const batch = pairs.slice(i, i + MAX_CONCURRENT);
    await Promise.all(batch.map(s => scanSymbol(s)));
  }
}

//────────────────────────────
async function scanner() {
  console.log(`\n══════ SCAN START ── ${new Date().toLocaleString("it-IT")} ══════`);
  const pairs = await getPairs();
  console.log(`Coppie da scansionare: ${pairs.length} (solo vol >2M)`);
  await scanAllSymbols(pairs);
  console.log("Scan completato.");
}

//────────────────────────────
(async () => {
  console.log("🚀 Bybit Squeeze + Extreme Trend Scanner avviato – ogni 30 min + solo vol >2M");

  while (true) {
    try {
      await scanner();
    } catch (err) {
      console.log("❌ Crash:", err.message);
      await sendTelegram(`❌ Scanner crash: ${err.message}`);
    }
    await delay(SCAN_INTERVAL);
  }
})();
