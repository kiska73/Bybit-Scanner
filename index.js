const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const BASE = "https://api.bybit.com";
let lastOI = {};

const SCAN_INTERVAL = 1000 * 60 * 30; // 30 minuti
const MAX_CONCURRENT = 5;

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
// Recupera holder ratio e funding
async function getHolderAndFunding(symbol) {
  try {
    const res = await axios.get(`${BASE}/v5/market/account-ratio`, {
      params: { category: "linear", symbol, period: "1h", limit: 10, accountType: 0 },
      timeout: 8000
    });
    const list = res.data.result.list || [];
    if (!list.length) return null;

    let totalBuy = 0, totalSell = 0, totalFunding = 0;
    for (const d of list) {
      totalBuy += parseFloat(d.buyRatio) || 0;
      totalSell += parseFloat(d.sellRatio) || 0;
      totalFunding += parseFloat(d.fundingRate) || 0;
    }
    const avgBuy = totalBuy / list.length;
    const avgSell = totalSell / list.length;
    const avgFunding = totalFunding / list.length;

    return { buy: avgBuy, sell: avgSell, funding: avgFunding };
  } catch { return null; }
}

//────────────────────────────
function classifyQuality(holder, funding, oiMc) {
  // HIGH QUALITY: holder molto sbilanciato e funding alto
  if (holder > 0.8 && funding > 0.02 && oiMc > 0.18) return "🔥 HIGH QUALITY";
  // LOW QUALITY / prudente: holder >70% e funding moderato
  if (holder > 0.7 && funding < 0.02 && oiMc > 0.12) return "⚡ LOW QUALITY";
  return null;
}

//────────────────────────────
async function scanSymbol(symbol, messages) {
  try {
    const ticker = await getTicker(symbol);
    if (!ticker) return;
    const price = parseFloat(ticker.lastPrice);
    const oi = parseFloat(ticker.openInterest);
    const volume = parseFloat(ticker.turnover24h);
    if (volume < 5_000_000 || !price || !oi || oi <= 0) return;

    const prevOI = lastOI[symbol];
    lastOI[symbol] = oi;
    if (!prevOI || oi <= prevOI) return; // OI deve crescere

    const data = await getHolderAndFunding(symbol);
    if (!data) return;
    const holderRatio = data.buy / (data.buy + data.sell);
    const funding = data.funding;

    // Calcola OI/MC proxy
    const oiUsd = oi * price;
    const marketCapProxy = volume * 3;
    const oiMc = oiUsd / marketCapProxy;

    const quality = classifyQuality(holderRatio, funding, oiMc);
    if (!quality) return;

    // Direzione basata su holder
    const direction = holderRatio > 0.5 ? "🚨 Possible LONG" : "🚨 Possible SHORT";

    messages.push(`
<b>${quality}</b>
<b>${symbol}</b>
${direction}
Holder L/S: <b>${(holderRatio/(1-holderRatio)).toFixed(2)}</b>
Funding Rate: <b>${(funding*100).toFixed(2)}%</b>
OI/MC: <b>${oiMc.toFixed(3)}</b>
Volume 24h: <b>${(volume/1_000_000).toFixed(1)}M</b>
`);
  } catch (err) { console.log(`${symbol} → errore: ${err.message}`); }
}

//────────────────────────────
async function scanAllSymbols(pairs, messages) {
  for (let i = 0; i < pairs.length; i += MAX_CONCURRENT) {
    const batch = pairs.slice(i, i + MAX_CONCURRENT);
    await Promise.all(batch.map(s => scanSymbol(s, messages)));
  }
}

//────────────────────────────
async function scanner() {
  console.log(`\n══════ SCAN START ── ${new Date().toLocaleString("it-IT")} ══════`);
  const pairs = await getPairs();
  console.log(`Coppie da scansionare: ${pairs.length} (solo vol >5M)`);

  const messages = [];
  await scanAllSymbols(pairs, messages);

  if (messages.length > 0) {
    const finalMsg = `<b>📊 Bybit Scanner Report – ${new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" })}</b>\n\n` + messages.join("\n—————————\n");
    await sendTelegram(finalMsg);
  } else {
    console.log("Nessun segnale rilevante in questo scan.");
  }

  console.log("Scan completato.");
}

//────────────────────────────
(async () => {
  console.log("🚀 Bybit Holder + Funding Scanner avviato – ogni 30 min");
  while (true) {
    try { await scanner(); }
    catch (err) {
      console.log("❌ Crash:", err.message);
      await sendTelegram(`❌ Scanner crash: ${err.message}`);
    }
    await delay(SCAN_INTERVAL);
  }
})();
