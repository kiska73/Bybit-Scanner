const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const BASE = "https://api.bybit.com";
let lastOI = {};

const SCAN_INTERVAL    = 1000 * 60 * 30; // 30 min
const MIN_OI_INCREASE  = 0.10;           // +10% minimo per trigger
const MAX_CONCURRENT   = 3;              // Abbassato per rate limit

//────────────────────────────
async function sendTelegram(msg) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: msg.trim(), parse_mode: "HTML" }
    );
  } catch (err) { console.log("❌ Telegram error:", err.message); }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

//────────────────────────────
async function getPairs() {
  try {
    const res = await axios.get(`${BASE}/v5/market/instruments-info`, { params: { category: "linear" }, timeout: 10000 });
    if (res.data.retCode !== 0) return [];
    return res.data.result.list
      .filter(p => p.quoteCoin === "USDT" && p.status === "Trading")
      .map(p => p.symbol);
  } catch { return []; }
}

async function getTicker(symbol) {
  try {
    const res = await axios.get(`${BASE}/v5/market/tickers`, { params: { category: "linear", symbol }, timeout: 8000 });
    return res.data.result.list?.[0] || null;
  } catch { return null; }
}

//────────────────────────────
// Recupera account ratio (≈ retail-heavy) + funding dal ticker
async function getRatioAndFunding(symbol) {
  try {
    // Ratio account (long/short holders)
    const ratioRes = await axios.get(`${BASE}/v5/market/account-ratio`, {
      params: { category: "linear", symbol, period: "1h", limit: 10 },
      timeout: 8000
    });
    const ratioList = ratioRes.data.result.list || [];
    if (!ratioList.length) return null;

    let totalBuy = 0, totalSell = 0;
    for (const d of ratioList) {
      totalBuy  += parseFloat(d.buyRatio)  || 0;
      totalSell += parseFloat(d.sellRatio) || 0;
    }
    const avgBuy  = totalBuy  / ratioList.length;
    const avgSell = totalSell / ratioList.length;

    // Funding dal ticker (più affidabile e veloce)
    const ticker = await getTicker(symbol);
    if (!ticker) return null;
    const funding = parseFloat(ticker.fundingRate) || 0;

    return { buy: avgBuy, sell: avgSell, funding };
  } catch { return null; }
}

//────────────────────────────
function classifyQuality(holderLongPct, funding, oiMc) {
  const lsRatio = holderLongPct / (1 - holderLongPct + 0.0001); // evita /0

  if (holderLongPct > 0.70 && funding > 0.0003 && oiMc > 0.15) {
    return "🔥 HIGH QUALITY (crowd long crowded)";
  }
  if (holderLongPct < 0.35 && funding < -0.0003 && oiMc > 0.12) {
    return "🔥 HIGH QUALITY (crowd short crowded)";
  }
  if (holderLongPct > 0.65 && oiMc > 0.10) {
    return "⚡ MEDIUM (long bias)";
  }
  if (holderLongPct < 0.40 && oiMc > 0.10) {
    return "⚡ MEDIUM (short bias)";
  }
  return null;
}

//────────────────────────────
async function scanSymbol(symbol, messages) {
  try {
    const ticker = await getTicker(symbol);
    if (!ticker) return;
    const price   = parseFloat(ticker.lastPrice);
    const oi      = parseFloat(ticker.openInterest);
    const volume  = parseFloat(ticker.turnover24h);
    if (volume < 10_000_000 || !price || !oi || oi <= 0) return; // alzato a 10M

    const prevOI = lastOI[symbol];
    lastOI[symbol] = oi;

    if (!prevOI) return;
    const oiIncrease = (oi - prevOI) / prevOI;
    if (oiIncrease < MIN_OI_INCREASE) return;

    const data = await getRatioAndFunding(symbol);
    if (!data) return;

    const holderLongPct = data.buy / (data.buy + data.sell);
    const funding       = data.funding;

    const oiUsd       = oi * price;
    const marketCapProxy = volume * 2.5; // un po' più conservativo
    const oiMc        = oiUsd / marketCapProxy;

    const quality = classifyQuality(holderLongPct, funding, oiMc);
    if (!quality) return;

    const direction = holderLongPct > 0.5 ? "🚨 Possible SHORT squeeze" : "🚨 Possible LONG squeeze";

    messages.push(`
<b>${quality}</b>
<b>${symbol}</b>
${direction}
Holder L/S: <b>${(holderLongPct / (1 - holderLongPct + 0.0001)).toFixed(2)}</b>
Funding: <b>${(funding * 100).toFixed(4)}%</b>
OI ↑: <b>+${(oiIncrease * 100).toFixed(1)}%</b>
OI/MC: <b>${oiMc.toFixed(3)}</b>
Vol 24h: <b>${(volume / 1_000_000).toFixed(1)}M</b>
    `);
  } catch (err) { console.log(`${symbol} → errore: ${err.message}`); }
}

//────────────────────────────
async function scanAllSymbols(pairs, messages) {
  for (let i = 0; i < pairs.length; i += MAX_CONCURRENT) {
    const batch = pairs.slice(i, i + MAX_CONCURRENT);
    await Promise.all(batch.map(s => scanSymbol(s, messages)));
    await delay(400); // piccolo delay tra batch per rate limit
  }
}

//────────────────────────────
async function scanner() {
  console.log(`\n══════ SCAN START ── ${new Date().toLocaleString("it-IT")} ══════`);
  const pairs = await getPairs();
  console.log(`Coppie da scansionare: ${pairs.length}`);

  const messages = [];
  await scanAllSymbols(pairs, messages);

  if (messages.length > 0) {
    const finalMsg = `<b>📊 Bybit Crowd + Funding Scanner – ${new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" })}</b>\n\n` + messages.join("\n—————————\n");
    await sendTelegram(finalMsg);
  } else {
    console.log("Nessun segnale.");
  }

  console.log("Scan completato.");
}

//────────────────────────────
(async () => {
  console.log("🚀 Bybit Crowd Squeeze Scanner avviato – ogni 30 min");
  while (true) {
    try { await scanner(); }
    catch (err) {
      console.log("❌ Crash:", err.message);
      await sendTelegram(`❌ Crash: ${err.message}`);
    }
    await delay(SCAN_INTERVAL);
  }
})();
