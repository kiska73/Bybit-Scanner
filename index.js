const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';
const BASE = "https://api.bybit.com";

const SCAN_INTERVAL = 1000 * 60 * 30; // 30 min
const MAX_CONCURRENT = 10; 

// SOGLIE ECCEZIONI (Valori esatti linea arancione)
const HIGH = 3.0; 
const LOW  = 0.5; 

async function sendTelegram(msg) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID, text: msg.trim(), parse_mode: "HTML"
        });
    } catch (err) { console.log("❌ Errore Telegram"); }
}

async function getData(symbol) {
    try {
        // 1. Ratio Massa (Account Ratio)
        const resMassa = await axios.get(`${BASE}/v5/market/account-ratio`, {
            params: { category: 'linear', symbol, period: '1h', limit: 1 }
        });
        // 2. Ratio Top 100 (Top Trader Ratio)
        const resTop = await axios.get(`${BASE}/v5/market/top-trader-account-ratio`, {
            params: { category: 'linear', symbol, period: '1h', limit: 1 }
        });
        // 3. Ticker per Funding Rate
        const resTicker = await axios.get(`${BASE}/v5/market/tickers`, {
            params: { category: 'linear', symbol }
        });

        const m = resMassa.data.result.list?.[0];
        const t = resTop.data.result.list?.[0];
        const ticker = resTicker.data.result.list?.[0];

        if (!m || !t || !ticker) return null;

        return {
            symbol,
            mRatio: parseFloat(m.accountRatio),
            tRatio: parseFloat(t.topTraderAccountRatio),
            funding: parseFloat(ticker.fundingRate) * 100
        };
    } catch { return null; }
}

async function scanSymbol(symbol, messages) {
    const data = await getData(symbol);
    if (!data) return;

    let signal = "";
    let emoji = "";

    // LOGICA DIVERGENZE (Eccezioni)
    if (data.tRatio >= HIGH && data.mRatio <= LOW) {
        signal = "⚡ SQUEEZE LONG (BULLISH)";
        emoji = "💰";
    } else if (data.tRatio <= LOW && data.mRatio >= HIGH) {
        signal = "⚠️ SHORT SQUEEZE (BEARISH)";
        emoji = "🚨";
    } else if (data.tRatio >= HIGH && data.mRatio >= HIGH) {
        signal = "🚀 FORTE TREND LONG";
        emoji = "📈";
    } else if (data.tRatio <= LOW && data.mRatio <= LOW) {
        signal = "📉 FORTE TREND SHORT";
        emoji = "📉";
    }

    if (signal) {
        const fundingEmoji = data.funding > 0 ? "🔴" : "🟢"; 
        messages.push(`
${emoji} <b>${signal}</b>
<b>Coppia:</b> ${data.symbol}
————————————
🟠 Ratio Top 100: <b>${data.tRatio.toFixed(2)}</b>
🟠 Ratio Massa: <b>${data.mRatio.toFixed(2)}</b>
💰 Funding: <b>${data.funding.toFixed(4)}%</b> ${fundingEmoji}
        `.trim());
    }
}

async function scanner() {
    try {
        const res = await axios.get(`${BASE}/v5/market/instruments-info`, { params: { category: "linear" } });
        const pairs = res.data.result.list.filter(p => p.quoteCoin === "USDT").map(p => p.symbol);
        
        console.log(`\n--- Scan ${new Date().toLocaleTimeString()} (${pairs.length} coppie) ---`);
        const messages = [];

        for (let i = 0; i < pairs.length; i += MAX_CONCURRENT) {
            const batch = pairs.slice(i, i + MAX_CONCURRENT);
            await Promise.all(batch.map(s => scanSymbol(s, messages)));
            await new Promise(r => setTimeout(r, 350));
        }

        if (messages.length > 0) {
            await sendTelegram(`<b>📊 REPORT ECCEZIONI BYBIT</b>\n\n` + messages.join("\n\n————————\n\n"));
            console.log(`✅ ${messages.length} segnali inviati.`);
        } else {
            console.log("Nessuna eccezione trovata.");
        }
    } catch (e) { console.log("Errore:", e.message); }
}

(async () => {
    console.log("🚀 Scanner Ratio + Funding avviato...");
    while (true) {
        await scanner();
        await new Promise(r => setTimeout(r, SCAN_INTERVAL));
    }
})();
