const axios = require('axios');

// ==========================================
// CONFIGURAZIONE 
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SOGLIA_ALTA  = 80;  // Vicino al soffitto del grafico (90-100%)
const SOGLIA_BASSA = 20;  // Vicino al pavimento del grafico (0-10%)
const LOOKBACK     = 48;  // Ore di storico per definire il range arancione
const MIN_VOL_2M   = 2000000; // Solo coppie con Volume 24h > 2 Milioni $

const SCAN_INTERVAL = 1000 * 60 * 30; // 30 Minuti
// ==========================================

const BASE = "https://api.bybit.com";

// Utility per attendere (evita Rate Limit)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getPosition(current, history) {
    const values = history.map(v => parseFloat(v));
    const max = Math.max(...values);
    const min = Math.min(...values);
    if (max === min) return 50;
    return ((current - min) / (max - min)) * 100;
}

async function getSignal(symbol) {
    try {
        // Chiamate parallele con timeout per non restare appesi
        const [resM, resT, resTick] = await Promise.all([
            axios.get(`${BASE}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK }, timeout: 5000 }),
            axios.get(`${BASE}/v5/market/top-trader-account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK }, timeout: 5000 }),
            axios.get(`${BASE}/v5/market/tickers`, { params: { category: 'linear', symbol }, timeout: 5000 })
        ]);

        const ticker = resTick.data.result?.list?.[0];
        if (!ticker) return null;

        const vol24h = parseFloat(ticker.turnover24h);
        if (vol24h < MIN_VOL_2M) return null;

        const mData = resM.data.result?.list;
        const tData = resT.data.result?.list;
        if (!mData?.length || !tData?.length) return null;

        const currentM = parseFloat(mData[0].accountRatio);
        const currentT = parseFloat(tData[0].topTraderAccountRatio);

        return {
            symbol,
            price: parseFloat(ticker.lastPrice),
            fund: parseFloat(ticker.fundingRate) * 100,
            vol24h,
            posM: getPosition(currentM, mData.map(x => x.accountRatio)),
            posT: getPosition(currentT, tData.map(x => x.topTraderAccountRatio)),
            currentM,
            currentT
        };
    } catch (err) {
        // Logga l'errore sulla singola moneta senza stoppare tutto
        console.error(`⚠️ Errore su ${symbol}: ${err.message}`);
        return null;
    }
}

async function scan() {
    try {
        const res = await axios.get(`${BASE}/v5/market/instruments-info`, { params: { category: "linear" } });
        const pairs = res.data.result.list.filter(p => p.quoteCoin === "USDT").map(p => p.symbol);
        
        console.log(`\n--- [${new Date().toLocaleTimeString()}] Analisi ${pairs.length} coppie ---`);
        let messages = [];

        // Processo a piccoli gruppi (batch)
        for (let i = 0; i < pairs.length; i += 5) {
            const batch = pairs.slice(i, i + 5);
            const results = await Promise.all(batch.map(s => getSignal(s)));
            
            for (const data of results) {
                if (!data) continue;

                let type = "";
                if (data.posT >= SOGLIA_ALTA && data.posM <= SOGLIA_BASSA) type = "⚡ SQUEEZE LONG (BULLISH)";
                else if (data.posT <= SOGLIA_BASSA && data.posM >= SOGLIA_ALTA) type = "⚠️ SHORT SQUEEZE (BEARISH)";
                else if (data.posT >= SOGLIA_ALTA && data.posM >= SOGLIA_ALTA) type = "🚀 ECCESSO LONG UNANIME";
                else if (data.posT <= SOGLIA_BASSA && data.posM <= SOGLIA_BASSA) type = "📉 ECCESSO SHORT UNANIME";

                if (type) {
                    messages.push(`
<b>${type}</b>
<b>Coppia:</b> ${data.symbol}
<b>Prezzo:</b> ${data.price}
————————————
🟡 Pos. Top 100: <b>${data.posT.toFixed(0)}%</b> (Rat: ${data.currentT.toFixed(2)})
🟠 Pos. Massa: <b>${data.posM.toFixed(0)}%</b> (Rat: ${data.currentM.toFixed(2)})
💰 Funding: <b>${data.fund.toFixed(4)}%</b> ${data.fund < 0 ? "🟢" : "🔴"}
📊 Vol 24h: <b>$${(data.vol24h / 1000000).toFixed(2)}M</b>
                    `.trim());
                }
            }
            // Piccolo respiro per le API di Bybit
            await sleep(200);
        }

        if (messages.length > 0) {
            // Invio messaggi a blocchi (Telegram ha un limite di caratteri per messaggio)
            for (let i = 0; i < messages.length; i += 5) {
                const chunk = messages.slice(i, i + 5).join("\n\n——————\n\n");
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID, text: `<b>📊 REPORT RATIO</b>\n\n${chunk}`, parse_mode: "HTML"
                });
            }
            console.log(`✅ ${messages.length} segnali inviati.`);
        }
    } catch (globalErr) {
        console.error("❌ ERRORE CRITICO SCANNER:", globalErr.message);
    }
}

// Avvio con gestione errore iniziale
console.log("🚀 Radar Blindato avviato...");
scan();
setInterval(scan, SCAN_INTERVAL);
