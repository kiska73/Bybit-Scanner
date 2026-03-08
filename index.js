const axios = require('axios');

// ==========================================
// CONFIGURAZIONE PARAMETRI (CAMBIA QUI)
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SCAN_INTERVAL = 1000 * 60 * 30; // 30 minuti tra ogni scan
const LOOKBACK      = 48;             // Ore di storico da analizzare (per definire Max/Min)

// SOGLIE DI SENSIBILITÀ (Percentuale rispetto al range 48h)
// Se metti 90 e 10 è molto rigido (solo picchi estremi)
// Se metti 75 e 25 è più morbido (beccchi il movimento prima)
const SOGLIA_ALTA = 80; 
const SOGLIA_BASSA = 20; 
// ==========================================

const BASE = "https://api.bybit.com";

function getPositionPercent(current, history) {
    const values = history.map(v => parseFloat(v));
    const max = Math.max(...values);
    const min = Math.min(...values);
    if (max === min) return 50;
    return ((current - min) / (max - min)) * 100;
}

async function getSignal(symbol) {
    try {
        const resM = await axios.get(`${BASE}/v5/market/account-ratio`, {
            params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK }
        });
        const resT = await axios.get(`${BASE}/v5/market/top-trader-account-ratio`, {
            params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK }
        });
        const resTick = await axios.get(`${BASE}/v5/market/tickers`, { params: { category: 'linear', symbol } });

        const listM = resM.data.result.list;
        const listT = resT.data.result.list;
        const ticker = resTick.data.result.list?.[0];

        if (!listM?.length || !listT?.length || !ticker) return null;

        const currM = parseFloat(listM[0].accountRatio);
        const currT = parseFloat(listT[0].topTraderAccountRatio);

        return {
            symbol,
            mPos: getPositionPercent(currM, listM.map(x => x.accountRatio)),
            tPos: getPositionPercent(currT, listT.map(x => x.topTraderAccountRatio)),
            mRatio: currM,
            tRatio: currT,
            funding: parseFloat(ticker.fundingRate) * 100
        };
    } catch { return null; }
}

async function scanner() {
    try {
        const res = await axios.get(`${BASE}/v5/market/instruments-info`, { params: { category: "linear" } });
        const pairs = res.data.result.list.filter(p => p.quoteCoin === "USDT").map(p => p.symbol);
        
        console.log(`\n--- Avvio Scan (${new Date().toLocaleTimeString()}) ---`);
        let messages = [];

        for (let i = 0; i < pairs.length; i += 10) {
            const batch = pairs.slice(i, i + 10);
            await Promise.all(batch.map(async (s) => {
                const data = await getSignal(s);
                if (!data) return;

                let type = "";
                // Utilizzo delle variabili di configurazione
                if (data.tPos >= SOGLIA_ALTA && data.mPos <= SOGLIA_BASSA) {
                    type = "⚡ SQUEEZE LONG (BULLISH)";
                } else if (data.tPos <= SOGLIA_BASSA && data.mPos >= SOGLIA_ALTA) {
                    type = "⚠️ SHORT SQUEEZE (BEARISH)";
                } else if (data.tPos >= SOGLIA_ALTA && data.mPos >= SOGLIA_ALTA) {
                    type = "🚀 ECCESSO LONG (TUTTI)";
                } else if (data.tPos <= SOGLIA_BASSA && data.mPos <= SOGLIA_BASSA) {
                    type = "📉 ECCESSO SHORT (TUTTI)";
                }

                if (type) {
                    messages.push(`
<b>${type}</b>
<b>Coppia:</b> ${data.symbol}
————————————
🟡 Posizione Top 100: <b>${data.tPos.toFixed(0)}%</b>
🟠 Posizione Massa: <b>${data.mPos.toFixed(0)}%</b>
💰 Funding: <b>${data.funding.toFixed(4)}%</b>
                    `.trim());
                }
            }));
            await new Promise(r => setTimeout(r, 400));
        }

        if (messages.length > 0) {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID, 
                text: `<b>📊 REPORT ECCEZIONI (Soglia ${SOGLIA_ALTA}/${SOGLIA_BASSA}%)</b>\n\n` + messages.join("\n\n——————\n\n"), 
                parse_mode: "HTML"
            });
            console.log(`✅ Inviati ${messages.length} segnali.`);
        } else {
            console.log("Nessuna eccezione trovata con le soglie attuali.");
        }
    } catch (e) { console.log("Errore:", e.message); }
}

(async () => {
    console.log("🚀 Scanner configurabile avviato...");
    while (true) {
        await scanner();
        await new Promise(r => setTimeout(r, SCAN_INTERVAL));
    }
})();
