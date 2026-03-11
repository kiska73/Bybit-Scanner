const axios = require('axios');

// ==========================================================================
// SNIPER ELITE v16.3 - THE LEGEND (Percentile 92/8 + Bybit Alignment)
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SCAN_INTERVAL = 1000 * 60 * 45; 
const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";

// Funzione per calcolare la Percentile su 500 ore
function calculatePercentile(current, history) {
    const values = history.map(h => parseFloat(h.longAccount));
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max === min) return 50; 
    return ((current - min) / (max - min)) * 100;
}

async function scan() {
    console.log("🚀 Analisi Percentile 500h in corso...");
    try {
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' } });
        const symbols = tickersRes.data.result.list.filter(t => parseFloat(t.turnover24h) > 5000000);

        for (const t of symbols) {
            const symbol = t.symbol;

            // 1. Scarico Storico 500 ore da Binance per Whale e Retail
            const [topHist, globHist, bybitRatioResp] = await Promise.all([
                axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(()=>null),
                axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(()=>null),
                axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: 1 } }).catch(()=>null)
            ]);

            if (!topHist?.data || !globHist?.data || !bybitRatioResp?.data?.result?.list?.[0]) continue;

            // Dati attuali
            const currentWhale = parseFloat(topHist.data[topHist.data.length - 1].longAccount);
            const currentRetail = parseFloat(globHist.data[globHist.data.length - 1].longAccount);
            
            // Calcolo Percentile
            const whalePerc = calculatePercentile(currentWhale, topHist.data);
            const retailPerc = calculatePercentile(currentRetail, globHist.data);

            const whaleLongPct = currentWhale * 100;
            const retailLongPct = currentRetail * 100;
            const binDiv = whaleLongPct - retailLongPct;

            const bybitRatio = parseFloat(bybitRatioResp.data.result.list[0].buyRatio);
            const bybitLongPct = (bybitRatio * 100);

            // --- FILTRO SUPREMO: PERCENTILE 92/8 + ALLINEAMENTO ---
            const isWhaleExtreme = whalePerc > 92 || whalePerc < 8;
            const isAligned = (binDiv > 0 && bybitRatio > 0.51) || (binDiv < 0 && bybitRatio < 0.49);

            if (isWhaleExtreme && isAligned && Math.abs(binDiv) > 12) {
                
                const side = binDiv > 0 ? "LONG" : "SHORT";
                const directionEmoji = binDiv > 0 ? "📈" : "📉";
                const condition = whalePerc > 92 ? "ACCUMULO MASSIMO" : "DISTRIBUZIONE MASSIMA";

                const text = `<b>🧨 💣 CARICO ESPLOSIVO ${directionEmoji}</b>\n#${symbol} @ ${t.lastPrice}\n\n` +
                             `📝 <b>ANALISI 500H:</b>\n<i>Situazione di ${condition}. La percentile delle balene è al <b>${whalePerc.toFixed(1)}%</b>. Binance e Bybit sono allineati per un movimento ${side}.</i>\n\n` +
                             `🐳 <b>WHALE (Bin):</b> <code>${whaleLongPct.toFixed(1)}%</code> (Perc: ${whalePerc.toFixed(1)}%)\n` +
                             `👥 <b>RETAIL (Bin):</b> <code>${retailLongPct.toFixed(1)}%</code>\n` +
                             `📊 <b>BYBIT LONG:</b> <code>${bybitLongPct.toFixed(1)}%</code>\n\n` +
                             `✅ <b>CONFERMA CROSS-EXCHANGE OK</b>\n` +
                             `💸 <b>FUNDING:</b> <code>${(parseFloat(t.fundingRate)*100).toFixed(3)}%</code>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { 
                    chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" 
                }).catch(()=>{});
            }
        }
    } catch (e) { console.error("Errore:", e.message); }
    console.log("✅ Ciclo Percentile completato.");
}

setInterval(scan, SCAN_INTERVAL);
scan();
