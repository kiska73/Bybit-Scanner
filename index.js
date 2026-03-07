const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const BASE = "https://api.bybit.com";
let lastOI = {};

const SCAN_INTERVAL      = 1000 * 60 * 30;   // 30 minuti
const MIN_OI_INCREASE    = 0.10;             // +10% minimo OI
const VOLUME_MIN         = 2_000_000;       // Volume 24h minimo
const MAX_CONCURRENT     = 3;                // Per rate limit

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
    const res = await axios.get(`${BASE}/v5/market/instruments-info`, { 
      params: { category: "linear" }, 
      timeout: 10000 
    });
    if (res.data.retCode !== 0) return [];
    return res.data.result.list
      .filter(p => p.quoteCoin === "USDT" && p.status === "Trading")
      .map(p => p.symbol);
  } catch { return []; }
}

async function getTicker(symbol) {
  try {
    const res = await axios.get(`${BASE}/v5/market/tickers`, { 
      params: { category: "linear", symbol }, 
      timeout: 8000 
    });
    return res.data.result.list?.[0] || null;
  } catch { return null; }
}

//────────────────────────────
async function getRatioAndFunding(symbol) {
  try {
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

    const ticker = await getTicker(symbol);
    if (!ticker) return null;
    const funding = parseFloat(ticker.fundingRate) || 0;

    return { buy: avgBuy, sell: avgSell, funding };
  } catch { return null; }
}

//────────────────────────────
function classifyQuality(holderLongPct, funding, oiMc, oiIncrease) {
  const absFunding = Math.abs(funding);

  // NUCLEARE: casi estremi
  if (holderLongPct > 0.80 && funding > 0.0020 && oiMc > 0.18 && oiIncrease > 0.25) {
    return { level: "NUCLEARE", squeeze: "SHORT SQUEEZE" };
  }
  if (holderLongPct < 0.20 && funding < -0.0020 && oiMc > 0.18 && oiIncrease > 0.25) {
    return { level: "NUCLEARE", squeeze: "LONG SQUEEZE" };
  }

  // BUONO: segnali forti standard
  if (holderLongPct > 0.70 && funding > 0.0010 && oiMc > 0.15 && oiIncrease > 0.15) {
    return { level: "BUONO", squeeze: "SHORT SQUEEZE" };
  }
  if (holderLongPct < 0.35 && funding < -0.0010 && oiMc > 0.15 && oiIncrease > 0.15) {
    return { level: "BUONO", squeeze: "LONG SQUEEZE" };
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
    const funding = parseFloat(ticker.fundingRate) || 0;

    if (volume < VOLUME_MIN || !price || !oi || oi <= 0) return;

    const prevOI = lastOI[symbol];
    lastOI[symbol] = oi;

    if (!prevOI) return;
    const oiIncrease = (oi - prevOI) / prevOI;
    if (oiIncrease < MIN_OI_INCREASE) return;

    const data = await getRatioAndFunding(symbol);
    if (!data) return;

    const holderLongPct = data.buy / (data.buy + data.sell);
    const oiUsd         = oi * price;
    const marketCapProxy = volume * 2.5;
    const oiMc          = oiUsd / marketCapProxy;

    const quality = classifyQuality(holderLongPct, funding, oiMc, oiIncrease);
    if (!quality) return;

    const { level, squeeze } = quality;

    // Direzione e testo
    let direction = "";
    let emoji = level === "NUCLEARE" ? "☢️" : "🔥";
    let smallText = "";

    if (squeeze === "SHORT SQUEEZE") {
      direction = `🚨 Possible SHORT SQUEEZE`;
      smallText = "<i>piccoli aprono MASSICCIO long</i>";
    } else {
      direction = `🚨 Possible LONG SQUEEZE`;
      smallText = "<i>piccoli aprono MASSICCIO short</i>";
    }

    const lsRatio = holderLongPct / (1 - holderLongPct + 0.0001);

    messages.push(`
<b>${emoji} ${level} - ${squeeze}</b>
<b>${symbol}</b>
${direction}
${smallText}

Holder L/S: <b>${lsRatio.toFixed(2)}</b> (${(holderLongPct*100).toFixed(1)}% long)
Funding: <b>${(funding*100).toFixed(4)}%</b> ${funding > 0 ? "(longs pagano shorts)" : "(shorts pagano longs)"}
OI ↑: <b>+${(oiIncrease*100).toFixed(1)}%</b>
OI/MC: <b>${oiMc.toFixed(3)}</b>
Vol 24h: <b>${(volume/1_000_000).toFixed(1)}M</b>
    `);
  } catch (err) {
    console.log(`${symbol} → errore: ${err.message}`);
  }
}

//────────────────────────────
async function scanAllSymbols(pairs, messages) {
  for (let i = 0; i < pairs.length; i += MAX_CONCURRENT) {
    const batch = pairs.slice(i, i + MAX_CONCURRENT);
    await Promise.all(batch.map(s => scanSymbol(s, messages)));
    await delay(400);
  }
}

//────────────────────────────
async function scanner() {
  console.log(`\n══════ SCAN START ── ${new Date().toLocaleString("it-IT")} ══════`);
  const pairs = await getPairs();
  console.log(`Coppie da scansionare: ${pairs.length} (vol >10M)`);

  const messages = [];
  await scanAllSymbols(pairs, messages);

  if (messages.length > 0) {
    const finalMsg = `<b>📊 Bybit SQUEEZE Scanner – ${new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" })}</b>\n\n` 
                   + messages.join("\n—————————\n");
    await sendTelegram(finalMsg);
    console.log(`✅ ${messages.length} segnale/i inviato/i`);
  } else {
    console.log("Nessun segnale BUONO o NUCLEARE.");
  }

  console.log("Scan completato.");
}

//────────────────────────────
(async () => {
  console.log("🚀 Bybit BUONO / NUCLEARE Squeeze Scanner avviato – ogni 30 min");
  console.log("Soglie: BUONO → holder >70%/<35% + funding ±0.10% + OI +15%");
  console.log("NUCLEARE → holder >80%/<20% + funding ±0.20% + OI +25%");
  
  while (true) {
    try { await scanner(); }
    catch (err) {
      console.log("❌ Crash:", err.message);
      await sendTelegram(`❌ Scanner crash: ${err.message}`);
    }
    await delay(SCAN_INTERVAL);
  }
})();
