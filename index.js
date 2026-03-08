const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';
const BASE = "https://api.bybit.com";

const SCAN_INTERVAL    = 1000 * 60 * 30; // 30 minuti
const MAX_CONCURRENT   = 10;
const MIN_VOLUME_USDT  = 2_000_000;      // soglia minima turnover 24h in USDT

// SOGLIE ECCEZIONI (linea arancione)
const HIGH = 3.0;
const LOW  = 0.5;

async function sendTelegram(msg) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: msg.trim(),
            parse_mode: "HTML"
        });
    } catch (err) {
        console.log("❌ Errore invio Telegram:", err.message);
    }
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

        // 3. Ticker (funding rate + altre info se servono dopo)
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
    } catch (err) {
        // console.log(`Errore getData ${symbol}:`, err.message);
        return null;
    }
}

async function scanSymbol(symbol, messages) {
    const data = await getData(symbol);
    if (!data) return;

    let signal = "";
    let emoji = "";

    // LOGICA DIVERGENZE / ECCEZIONI
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
🟠 Ratio Massa:   <b>${data.mRatio.toFixed(2)}</b>
💰 Funding:       <b>${data.funding.toFixed(4)}%</b> ${fundingEmoji}
        `.trim());
    }
}

async function scanner() {
    try {
        // 1. Ottieni tutti gli strumenti linear
        const resInstruments = await axios.get(`${BASE}/v5/market/instruments-info`, {
            params: { category: "linear" }
        });

        // 2. Ottieni tutti i tickers in UNA sola chiamata (molto più efficiente)
        const resTickers = await axios.get(`${BASE}/v5/market/tickers`, {
            params: { category: "linear" }
        });

        if (!resTickers.data.result?.list) {
            throw new Error("Nessun ticker ricevuto");
        }

        // Mappa symbol → turnover24h (in USDT)
        const tickerMap = new Map();
        resTickers.data.result.list.forEach(t => {
            tickerMap.set(t.symbol, parseFloat(t.turnover24h || 0));
        });

        // Filtra solo le coppie USDT attive con volume sufficiente
        const pairs = resInstruments.data.result.list
            .filter(p => 
                p.quoteCoin === "USDT" &&
                p.status === "Trading" &&
                tickerMap.has(p.symbol) &&
                tickerMap.get(p.symbol) >= MIN_VOLUME_USDT
            )
            .map(p => p.symbol)
            .sort(); // ordine alfabetico per consistenza

        console.log(
            `\n--- Scan ${new Date().toLocaleString()} --- ` +
            `(${pairs.length} coppie con vol ≥ ${MIN_VOLUME_USDT.toLocaleString()} USDT 24h)`
        );

        const messages = [];

        // Elaborazione a batch per non sovraccaricare rate limit
        for (let i = 0; i < pairs.length; i += MAX_CONCURRENT) {
            const batch = pairs.slice(i, i + MAX_CONCURRENT);
            await Promise.all(batch.map(symbol => scanSymbol(symbol, messages)));
            await new Promise(r => setTimeout(r, 350)); // piccolo delay tra batch
        }

        if (messages.length > 0) {
            const header = `<b>📊 REPORT ECCEZIONI BYBIT</b>  (${new Date().toLocaleTimeString()})\n\n`;
            await sendTelegram(header + messages.join("\n\n————————\n\n"));
            console.log(`✅ ${messages.length} segnali inviati su Telegram`);
        } else {
            console.log("Nessuna eccezione rilevata oggi.");
        }

    } catch (e) {
        console.error("Errore durante lo scan:", e.message);
    }
}

// Avvio infinito
(async () => {
    console.log("🚀 Scanner Bybit Ratio + Funding + Volume Filter avviato...");
    console.log(`Soglia minima volume 24h: ${MIN_VOLUME_USDT.toLocaleString()} USDT`);
    console.log(`Intervallo scan: ${SCAN_INTERVAL / 60000} minuti`);

    while (true) {
        await scanner();
        await new Promise(r => setTimeout(r, SCAN_INTERVAL));
    }
})();
