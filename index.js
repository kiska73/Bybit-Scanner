const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const BASE = "https://api.bybit.com";
let lastOI = {};  // memorizza OI in USD precedente

const SCAN_INTERVAL      = 1000 * 60 * 30;   // 30 minuti
const MIN_OI_INCREASE    = 0.18;             // +18% minimo per segnalare
const MIN_OI_USD         = 5_000_000;       // minimo 5 milioni $ di OI
const VOLUME_MIN         = 2_000_000;       // Volume 24h minimo in USD
const MAX_CONCURRENT     = 8;               // aumentato, Bybit tollera abbastanza

//────────────────────────────
async function sendTelegram(msg) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: msg.trim(), parse_mode: "HTML" }
    );
  } catch (err) {
    console.log("❌ Errore Telegram:", err.message);
  }
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
  } catch (err) {
    console.log("Errore getPairs:", err.message);
    return [];
  }
}

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

    return {
      buy: avgBuy,
      sell: avgSell,
      funding: parseFloat(ticker.fundingRate) || 0
    };
  } catch {
    return null;
  }
}

//────────────────────────────
function classifyQuality(holderLongPct, funding, oiIncrease) {
  // NUCLEARE – casi estremi
  if (holderLongPct > 0.82 && funding > 0.0025 && oiIncrease > 0.28) {
    return { level: "NUCLEARE", squeeze: "SHORT SQUEEZE" };
  }
  if (holderLongPct < 0.18 && funding < -0.0025 && oiIncrease > 0.28) {
    return { level: "NUCLEARE", squeeze: "LONG SQUEEZE" };
  }

  // BUONO – segnali forti
  if (holderLongPct > 0.74 && funding > 0.0015 && oiIncrease > 0.18) {
    return { level: "BUONO", squeeze: "SHORT SQUEEZE" };
  }
  if (holderLongPct < 0.28 && funding < -0.0015 && oiIncrease > 0.18) {
    return { level: "BUONO", squeeze: "LONG SQUEEZE" };
  }

  return null;
}

//────────────────────────────
async function scanSymbol(symbol, messages) {
  try {
    const ticker = await getTicker(symbol);
    if (!ticker) return;

    const price     = parseFloat(ticker.lastPrice);
    const oiUsd     = parseFloat(ticker.openInterestValue || 0);
    const volume    = parseFloat(ticker.turnover24h);
    const funding   = parseFloat(ticker.fundingRate) || 0;

    if (volume < VOLUME_MIN || oiUsd < MIN_OI_USD || !price || oiUsd <= 0) return;

    const prevOI = lastOI[symbol];
    lastOI[symbol] = oiUsd;

    if (!prevOI) return;

    const oiIncrease = (oiUsd - prevOI) / prevOI;
    if (oiIncrease < MIN_OI_INCREASE) return;

    const data = await getRatioAndFunding(symbol);
    if (!data) return;

    const holderLongPct = data.buy / (data.buy + data.sell);
    const quality = classifyQuality(holderLongPct, funding, oiIncrease);

    if (!quality) return;

    const { level, squeeze } = quality;

    const emoji       = level === "NUCLEARE" ? "☢️" : "🔥";
    const direction   = squeeze === "SHORT SQUEEZE" ? "🚨 Possibile SHORT SQUEEZE" : "🚨 Possibile LONG SQUEEZE";
    const smallText   = squeeze === "SHORT SQUEEZE" 
      ? "<i>(molti trader long → possibile squeeze short)</i>"
      : "<i>(molti trader short → possibile squeeze long)</i>";

    const lsRatio = holderLongPct / (1 - holderLongPct + 0.0001);

    messages.push({
      level,
      oiIncrease,
      text: `
<b>${emoji} ${level} - ${squeeze}</b>
<b>${symbol}</b>
${direction}
${smallText}

L/S tutti account: <b>${lsRatio.toFixed(1)} : 1</b>  (${(holderLongPct*100).toFixed(1)}% long)
Funding: <b>${(funding*100).toFixed(4)}%</b> ${funding > 0 ? "(long pagano)" : "(short pagano)"}
OI ↑: <b>+${(oiIncrease*100).toFixed(1)}%</b>
OI USD: <b>$${(oiUsd/1_000_000).toFixed(1)}M</b>
Vol 24h: <b>$${(volume/1_000_000).toFixed(1)}M</b>
      `.trim()
    });
  } catch (err) {
    console.log(`${symbol} → errore: ${err.message}`);
  }
}

//────────────────────────────
async function scanAllSymbols(pairs, messages) {
  for (let i = 0; i < pairs.length; i += MAX_CONCURRENT) {
    const batch = pairs.slice(i, i + MAX_CONCURRENT);
    await Promise.all(batch.map(s => scanSymbol(s, messages)));
    await delay(350); // un po' più veloce ma ancora sicuro
  }
}

//────────────────────────────
function sortMessages(messages) {
  return messages.sort((a, b) => {
    if (a.level === "NUCLEARE" && b.level !== "NUCLEARE") return -1;
    if (b.level === "NUCLEARE" && a.level !== "NUCLEARE") return 1;
    return b.oiIncrease - a.oiIncrease; // OI% decrescente
  }).map(m => m.text);
}

//────────────────────────────
async function scanner() {
  const now = new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" });
  console.log(`\n══════ SCAN START ── ${now} ══════`);

  const pairs = await getPairs();
  console.log(`Coppie da scansionare: ${pairs.length}`);

  const messages = [];
  await scanAllSymbols(pairs, messages);

  if (messages.length > 0) {
    const sorted = sortMessages(messages);
    const finalMsg = `<b>📊 Bybit Squeeze Scanner – ${now}</b>\n\n` 
                   + sorted.join("\n—————————\n");
    await sendTelegram(finalMsg);
    console.log(`✅ ${messages.length} segnale/i inviato/i`);
  } else {
    console.log("Nessun segnale rilevato.");
  }

  console.log("Scan terminato.");
}

//────────────────────────────
(async () => {
  console.log("🚀 Bybit Squeeze Scanner avviato – ogni 30 min");
  console.log("Soglie attuali:");
  console.log("• OI aumento ≥ 18%");
  console.log("• OI ≥ 5M$");
  console.log("• BUONO:  long >74% o <28% + funding ±0.015%");
  console.log("• NUCLEARE: long >82% o <18% + funding ±0.025%");
  
  while (true) {
    try {
      await scanner();
    } catch (err) {
      console.error("❌ Crash scanner:", err.message);
      await sendTelegram(`❌ Scanner crash: ${err.message}`);
    }
    await delay(SCAN_INTERVAL);
  }
})();
