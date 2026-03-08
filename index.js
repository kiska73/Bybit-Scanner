const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';
const BASE = "https://api.bybit.com";

const SCAN_INTERVAL = 1000 * 60 * 30; // 30 min
const MAX_CONCURRENT = 10; 

// SOGLIE RICHIESTE
const HIGH = 0.80; 
const LOW  = 0.20; 

async function sendTelegram(msg) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID, text: msg.trim(), parse_mode: "HTML"
        });
    } catch (err) { console.log("❌ Errore Telegram"); }
}

async function getSentiment(symbol) {
    try {
        // 1. DATO MASSA (Indicatore arancione Foto 1000011760)
        const resMassa = await axios.get(`${BASE}/v5/market/account-ratio`, {
            params: { category: "linear", symbol, period: "1h", limit: 1 }
        });
        
        // 2. DATO TOP 100 (Indicatore arancione Foto 1000011761)
        const resTop = await axios.get(`${BASE}/v5/market/top-trader-account-ratio`, {
            params: { category: "linear", symbol, period: "1h", limit: 1 }
        });

        const massa = resMassa.data.result.list?.[0];
        const top = resTop.data.result.list?.[0];

        if (!massa || !top) return null;

        return {
            massaLong: parseFloat(massa.buyRatio), // Es. 0.82
            topLong: parseFloat(top.buyRatio)      // Es. 0.15
        };
    } catch { return null; }
}

async function scanSymbol(symbol, messages) {
    const data = await getSentiment(symbol);
    if (!data) return;

    let type = "";
    let desc = "";

    // LOGICA RICHIESTA
    if (data.topLong > HIGH && data.massaLong > HIGH) {
        type = "🚀 FORTE TREND LONG";
        desc = "Sentiment unanime al rialzo (Top + Massa)";
    } 
    else if (data.topLong < LOW && data.massaLong < LOW) {
        type = "📉 FORTE TREND SHORT";
        desc = "Sentiment unanime al ribasso (Top + Massa)";
    }
    else if (data.topLong > HIGH && data.massaLong < LOW) {
        type = "⚡ SQUEEZE LONG";
        desc = "Le balene comprano, i piccoli vendono. Probabile esplosione UP.";
    }
    else if (data.topLong < LOW && data.massaLong > HIGH) {
        type = "⚠️ SHORT SQUEEZE (DROP)";
        desc = "Le balene vendono, i piccoli comprano. Probabile crollo per liquidare la massa.";
    }

    if (type) {
        messages.push(`
<b>${type}</b>
<b>Coppia:</b> ${symbol}
${desc}
————————————
Top 100 Long: <b>${(data.topLong * 100).toFixed(1)}%</b>
Massa Long: <b>${(data.massaLong * 100).toFixed(1)}%</b>
        `.trim());
    }
}

async function scanner() {
    const res = await axios.get(`${BASE}/v5/market/instruments-info`, { params: { category: "linear" } });
    const pairs = res.data.result.list.filter(p => p.quoteCoin === "USDT").map(p => p.symbol);
    
    console.log(`Analisi di ${pairs.length} coppie...`);
    const messages = [];

    for (let i = 0; i < pairs.length; i += MAX_CONCURRENT) {
        const batch = pairs.slice(i, i + MAX_CONCURRENT);
        await Promise.all(batch.map(s => scanSymbol(s, messages)));
        await new Promise(r => setTimeout(r, 300));
    }

    if (messages.length > 0) {
        await sendTelegram(`<b>📊 REPORT DIVERGENZE BYBIT</b>\n\n` + messages.join("\n\n————————————\n\n"));
    }
}

(async () => {
    while (true) {
        try { await scanner(); } catch (e) {}
        await new Promise(r => setTimeout(r, SCAN_INTERVAL));
    }
})();
