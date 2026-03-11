const axios = require('axios');

// ==========================================================================
// 🎯 SNIPER ELITE v17.0 - THE FINAL CORE (Percentile 90/10 + Quant Quality)
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SCAN_INTERVAL = 1000 * 60 * 30; // Scansione ogni 30 minuti
const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";

let sentSignals = {}; // Memoria per evitare spam (4 ore di cooldown)

// --- FUNZIONE FULCRO: Percentile Statistica su 500 periodi ---
function calculatePercentile(current, history) {
    const values = history.map(h => parseFloat(h.longAccount));
    const countBelow = values.filter(v => v < current).length;
    return (countBelow / values.length) * 100;
}

async function scan() {
    console.log("🚀 Sniper in postazione... Scansione 500h avviata.");
    try {
        // 1. Prendi i ticker da Bybit (Volume > 2M)
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' } });
        const symbols = tickersRes.data.result.list.filter(t => parseFloat(t.turnover24h) > 2000000);

        for (const t of symbols) {
            const symbol = t.symbol;

            // 2. Recupero Dati Storici (500h) e Sentiment
            const [topHist, globHist, bybitRatioResp, oiResp] = await Promise.all([
                axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(()=>null),
                axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(()=>null),
                axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: 1 } }).catch(()=>null),
                axios.get(`${BASE_BYBIT}/v5/market/open-interest`, { params: { category: 'linear', symbol, intervalTime: '1h', limit: 4 } }).catch(()=>null)
            ]);

            if (!topHist?.data?.length || !globHist?.data?.length || !bybitRatioResp?.data?.result?.list?.[0]) continue;

            // --- ANALISI BINANCE ---
            const curWhale = parseFloat(topHist.data[topHist.data.length - 1].longAccount);
            const curRetail = parseFloat(globHist.data[globHist.data.length - 1].longAccount);
            
            const whalePerc = calculatePercentile(curWhale, topHist.data);
            const retailPerc = calculatePercentile(curRetail, globHist.data);
            const binDiv = (curWhale * 100) - (curRetail * 100);

            // --- ANALISI BYBIT ---
            const bybitLongPct = parseFloat(bybitRatioResp.data.result.list[0].buyRatio) * 100;
            const funding = parseFloat(t.fundingRate);
            
            // --- ANALISI OI ---
            let oiChangePct = 0;
            if (oiResp?.data?.result?.list?.length > 1) {
                const oiList = oiResp.data.result.list;
                const latestOi = parseFloat(oiList[0].openInterest);
                const prevOi = parseFloat(oiList[oiList.length - 1].openInterest);
                oiChangePct = ((latestOi - prevOi) / prevOi) * 100;
            }

            // ==================================================================
            // 🚨 LOGICA TRIGGER (Percentilla 90/10 + Div > 10% + Bybit Align)
            // ==================================================================
            const isLong = whalePerc > 90 && binDiv > 10 && bybitLongPct > 51;
            const isShort = whalePerc < 10 && binDiv < -10 && bybitLongPct < 49;

            if (isLong || isShort) {
                // Cooldown: non ripetere la stessa coin per 4 ore
                const now = Date.now();
                if (sentSignals[symbol] && (now - sentSignals[symbol]) < 1000 * 60 * 60 * 4) continue;

                // --- CALCOLO SCORE QUALITÀ (5-10) ---
                let score = 6;
                if (Math.abs(oiChangePct) > 3) score += 2; // OI in spinta
                if (isLong && funding < 0) score += 2;      // Squeeze Long (paga per shortare)
                if (isShort && funding > 0.0005) score += 2; // Squeeze Short (paga per longare)

                sentSignals[symbol] = now; // Salva in memoria
                const side = isLong ? "LONG" : "SHORT";
                const emoji = isLong ? "🚀" : "🩸";

                const text = `<b>${emoji} CARICO ESPLOSIVO ${side}</b>\n` +
                             `#${symbol} @ ${t.lastPrice}\n\n` +
                             `⭐ <b>SCORE QUALITÀ: ${score}/10</b>\n\n` +
                             `📊 <b>PERCENTILLA (Storico 500h):</b>\n` +
                             `• Whales: <code>${whalePerc.toFixed(1)}%</code> ${whalePerc > 90 || whalePerc < 10 ? '🎯' : ''}\n` +
                             `• Retail: <code>${retailPerc.toFixed(1)}%</code>\n\n` +
                             `👥 <b>VALORI ATTUALI (Binance):</b>\n` +
                             `• Whales: <code>${(curWhale * 100).toFixed(1)}% Long</code>\n` +
                             `• Retail: <code>${(curRetail * 100).toFixed(1)}% Long</code>\n` +
                             `• Divergenza: <b>${binDiv > 0 ? '+' : ''}${binDiv.toFixed(1)}%</b>\n\n` +
                             `🔥 <b>DATI QUANT:</b>\n` +
                             `• Bybit Sentiment: <code>${bybitLongPct.toFixed(1)}% Long</code>\n` +
                             `• OI Change (4h): <code>${oiChangePct > 0 ? '📈' : '📉'} ${oiChangePct.toFixed(2)}%</code>\n` +
                             `• Funding Rate: <code>${(funding * 100).toFixed(4)}%</code>\n\n` +
                             `✅ <b>CONFERMA CROSS-EXCHANGE OK</b>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { 
                    chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" 
                }).catch(()=>{});
            }
        }
    } catch (e) { console.error("Errore Scan:", e.message); }
    console.log("✅ Scan completato.");
}

setInterval(scan, SCAN_INTERVAL);
scan();
