const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const BASE = "https://api.bybit.com";
const SCAN_INTERVAL = 1000 * 60 * 30; // 30 minuti
const MAX_CONCURRENT = 10; 

// SOGLIE DEFINITE DA TE
const THRESHOLD_HIGH = 0.80; // 80%
const THRESHOLD_LOW  = 0.20; // 20%

async function sendTelegram(msg) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: msg.trim(),
            parse_mode: "HTML"
        });
    } catch (err) {
        console.log("❌ Errore Telegram:", err.message);
    }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getPairs() {
    try {
        const res = await axios.get(`${BASE}/v5/market/instruments-info`, { params: { category: "linear" } });
        return res.data.result.list
            .filter(p => p.quoteCoin === "USDT" && p.status === "Trading")
            .map(p => p.symbol);
    } catch (err) { return []; }
}

async function getSentiment(symbol) {
    try {
        // 1. Ratio Holders (Account Ratio)
        const holderRes = await axios.get(`${BASE}/v5/market/account-ratio`, {
            params: { category: "linear", symbol, period: "1h", limit: 1 }
        });
        
        // 2. Ratio Top/Volume (Taker Buy Sell Ratio)
        const topRes = await axios.get(`${BASE}/v5/market/taker-buy-sell-ratio`, {
            params: { category: "linear", symbol, period: "1h", limit: 1 }
        });

        const holderData = holderRes.data.result.list?.[0];
        const topData = topRes.data.result.list?.[0];

        if (!holderData || !topData) return null;

        return {
            holderLong: parseFloat(holderData.buyRatio), // Es: 0.75
            topLong: parseFloat(topData.buyRatio)      // Es: 0.25
        };
    } catch { return null; }
}

function detectSignal(symbol, hLong, tLong) {
    // hLong e tLong sono valori tra 0 e 1 (es. 0.85 = 85%)

    // 1. FORTE TREND LONG (Tutti e due > 80%)
    if (hLong > THRESHOLD_HIGH && tLong > THRESHOLD_HIGH) {
        return { type: "🚀 FORTE TREND LONG", desc: "Tutti stanno comprando (Massa + Top)" };
    }

    // 2. FORTE TREND SHORT (Tutti e due < 20%)
    if (hLong < THRESHOLD_LOW && tLong < THRESHOLD_LOW) {
        return { type: "📉 FORTE TREND SHORT", desc: "Tutti stanno vendendo (Massa + Top)" };
    }

    // 3. LONG SQUEEZE (Top > 80% e Holders < 20%)
    // Le balene comprano, i piccoli vendono -> i piccoli vengono "squeezati" verso l'alto
    if (tLong > THRESHOLD_HIGH && hLong < THRESHOLD_LOW) {
        return { type: "⚡ SQUEEZE LONG", desc: "Top Traders comprano contro Massa Short" };
    }

    // 4. SHORT SQUEEZE (Top < 20% e Holders > 80%)
    // Le balene vendono, i piccoli comprano -> i piccoli vengono "squeezati" verso il basso
    if (tLong < THRESHOLD_LOW && hLong > THRESHOLD_HIGH) {
        return { type: "⚠️ SQUEEZE SHORT", desc: "Top Traders vendono contro Massa Long" };
    }

    return null;
}

async function scanSymbol(symbol, messages) {
    const data = await getSentiment(symbol);
    if (!data) return;

    const signal = detectSignal(symbol, data.holderLong, data.topLong);
    if (signal) {
        messages.push(`
<b>${signal.type}</b>
<b>Coppia:</b> ${symbol}
<b>Info:</b> ${signal.desc}
————————————
Massa (Holders): <b>${(data.holderLong * 100).toFixed(1)}% Long</b>
Grandi (Top): <b>${(data.topLong * 100).toFixed(1)}% Long</b>
        `.trim());
    }
}

async function scanner() {
    const now = new Date().toLocaleString("it-IT");
    console.log(`\n--- Inizio Scan: ${now} ---`);

    const pairs = await getPairs();
    const messages = [];

    for (let i = 0; i < pairs.length; i += MAX_CONCURRENT) {
        const batch = pairs.slice(i, i + MAX_CONCURRENT);
        await Promise.all(batch.map(s => scanSymbol(s, messages)));
        await delay(200); 
    }

    if (messages.length > 0) {
        // Telegram ha un limite di caratteri, dividiamo se troppi segnali
        const finalMsg = `<b>📊 Sentiment Report – ${now}</b>\n\n` + messages.join("\n\n");
        await sendTelegram(finalMsg);
        console.log(`✅ Inviati ${messages.length} segnali.`);
    } else {
        console.log("Nessun segnale trovato.");
    }
}

(async () => {
    console.log("🚀 Scanner Ratio Avviato...");
    while (true) {
        try {
            await scanner();
        } catch (err) {
            console.error("Errore:", err.message);
        }
        await delay(SCAN_INTERVAL);
    }
})();
