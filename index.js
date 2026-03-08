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

function getPosition(current, history) {
    const values = history.map(v => parseFloat(v));
    const max = Math.max(...values);
    const min = Math.min(...values);
    if (max === min) return 50;
    return ((current - min) / (max - min)) * 100;
}

async function scan() {
    try {
        const res = await axios.get(`${BASE}/v5/market/instruments-info`, { params: { category: "linear" } });
        const pairs = res.data.result.list.filter(p => p.quoteCoin === "USDT").map(p => p.symbol);
        
        console.log(`\n--- [${new Date().toLocaleTimeString()}] Analisi ${pairs.length} coppie ---`);
        let messages = [];

        for (let i = 0; i < pairs.length; i += 10) {
            const batch = pairs.slice(i, i + 10);
            await Promise.all(batch.map(async (symbol) => {
                try {
                    const [resM, resT, resTick] = await Promise.all([
                        axios.get(`${BASE}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK } }),
                        axios.get(`${BASE}/v5/market/top-trader-account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK } }),
                        axios.get(`${BASE}/v5/market/tickers`, { params: { category: 'linear', symbol } })
                    ]);

                    const ticker = resTick.data.result.list[0];
                    const vol24h = parseFloat(ticker.turnover24h);
                    const price  = parseFloat(ticker.lastPrice);
                    const fund   = parseFloat(ticker.fundingRate) * 100;

                    // Filtro Volume 2M
                    if (vol24h < MIN_VOL_2M) return;

                    const mData = resM.data.result.list;
                    const tData = resT.data.result.list;
                    if (!mData?.length || !tData?.length) return;

                    const currentM = parseFloat(mData[0].accountRatio);
                    const currentT = parseFloat(tData[0].topTraderAccountRatio);

                    const posM = getPosition(currentM, mData.map(x => x.accountRatio));
                    const posT = getPosition(currentT, tData.map(x => x.topTraderAccountRatio));

                    let type = "";
                    if (posT >= SOGLIA_ALTA && posM <= SOGLIA_BASSA) {
                        type = "⚡ SQUEEZE LONG (BULLISH)";
                    } else if (posT <= SOGLIA_BASSA && posM >= SOGLIA_ALTA) {
                        type = "⚠️ SHORT SQUEEZE (BEARISH)";
                    } else if (posT >= SOGLIA_ALTA && posM >= SOGLIA_ALTA) {
                        type = "🚀 ECCESSO LONG UNANIME";
                    } else if (posT <= SOGLIA_BASSA && posM <= SOGLIA_BASSA) {
                        type = "📉 ECCESSO SHORT UNANIME";
                    }

                    if (type) {
                        // Emoji per il funding: verde se negativo (ottimo per long), rosso se positivo
                        const fEmoji = fund < 0 ? "🟢" : "🔴";
                        
                        messages.push(`
<b>${type}</b>
<b>Coppia:</b> ${symbol}
<b>Prezzo:</b> ${price}
————————————
🟡 Pos. Top 100: <b>${posT.toFixed(0)}%</b> (Ratio: ${currentT.toFixed(2)})
🟠 Pos. Massa: <b>${posM.toFixed(0)}%</b> (Ratio: ${currentM.toFixed(2)})
💰 Funding: <b>${fund.toFixed(4)}%</b> ${fEmoji}
📊 Vol 24h: <b>$${(vol24h / 1000000).toFixed(2)}M</b>
                        `.trim());
                    }
                } catch (e) {}
            }));
            await new Promise(r => setTimeout(r, 400));
        }

        if (messages.length > 0) {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID, 
                text: `<b>📊 REPORT RATIO & FUNDING</b>\n\n` + messages.join("\n\n——————\n\n"), 
                parse_mode: "HTML"
            });
            console.log(`✅ ${messages.length} segnali inviati.`);
        }
    } catch (e) { console.log("Errore:", e.message); }
}

setInterval(scan, SCAN_INTERVAL);
scan();
