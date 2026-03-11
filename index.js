const axios = require('axios');

// ==========================================================================
// 🎯 SNIPER ELITE v18.1 - HARD LIMIT (Percentilla 90/10 & Editable Params)
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

// --- PARAMETRI MODIFICABILI (Il Fulcro) ---
const P_HIGH  = 90;   // Soglia Massima (Whale o Retail carichi)
const P_LOW   = 10;   // Soglia Minima (Whale o Retail scarichi)
const DIV_MIN = 15;   // Divergenza Netta minima tra i due (%)
const VOL_MIN = 2000000; // Volume minimo 24h (Bybit)
const SCAN_INTERVAL = 1000 * 60 * 30; // 30 minuti

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";

let sentSignals = {}; 

function calculatePercentile(current, history) {
    const values = history.map(h => parseFloat(h.longAccount));
    const countBelow = values.filter(v => v < current).length;
    return (countBelow / values.length) * 100;
}

async function scan() {
    console.log(`🚀 Scan avviato... Filtri: >${P_HIGH}% e <${P_LOW}%`);
    try {
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' } });
        const symbols = tickersRes.data.result.list.filter(t => parseFloat(t.turnover24h) > VOL_MIN);

        for (const t of symbols) {
            const symbol = t.symbol;

            const [topHist, globHist, bybitRatioResp, oiResp] = await Promise.all([
                axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(()=>null),
                axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(()=>null),
                axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: 1 } }).catch(()=>null),
                axios.get(`${BASE_BYBIT}/v5/market/open-interest`, { params: { category: 'linear', symbol, intervalTime: '1h', limit: 4 } }).catch(()=>null)
            ]);

            if (!topHist?.data?.length || !globHist?.data?.length || !bybitRatioResp?.data?.result?.list?.[0]) continue;

            const curWhale = parseFloat(topHist.data[topHist.data.length - 1].longAccount);
            const curRetail = parseFloat(globHist.data[globHist.data.length - 1].longAccount);
            const whalePerc = calculatePercentile(curWhale, topHist.data);
            const retailPerc = calculatePercentile(curRetail, globHist.data);
            const binDiv = (curWhale * 100) - (curRetail * 100);

            const bybitLongPct = parseFloat(bybitRatioResp.data.result.list[0].buyRatio) * 100;
            const funding = parseFloat(t.fundingRate);
            
            let oiChangePct = 0;
            if (oiResp?.data?.result?.list?.length > 1) {
                const latestOi = parseFloat(oiResp.data.result.list[0].openInterest);
                const prevOi = parseFloat(oiResp.data.result.list[oiResp.data.result.list.length-1].openInterest);
                oiChangePct = ((latestOi - prevOi) / prevOi) * 100;
            }

            // ==================================================================
            // 🚨 LOGICA RIGIDA 90/10
            // ==================================================================
            let signalType = "";
            let side = "";

            // 1. DIVERGENZE (Whale vs Retail)
            if (whalePerc > P_HIGH && retailPerc < P_LOW && binDiv > DIV_MIN) { 
                signalType = "DIVERGENZA LONG (Whale Accumula)"; side = "LONG"; 
            }
            else if (whalePerc < P_LOW && retailPerc > P_HIGH && binDiv < -DIV_MIN) { 
                signalType = "DIVERGENZA SHORT (Whale Distribuisce)"; side = "SHORT"; 
            }
            // 2. ESTREMI (Tutti dalla stessa parte)
            else if (whalePerc < P_LOW && retailPerc < P_LOW) { 
                signalType = "ESTREMO PANICO (Potenziale Reversal)"; side = "LONG"; 
            }
            else if (whalePerc > P_HIGH && retailPerc > P_HIGH) { 
                signalType = "ESTREMO EUFORIA (Potenziale Reversal)"; side = "SHORT"; 
            }

            if (signalType !== "") {
                const bybitConfirms = (side === "LONG" && bybitLongPct > 50) || (side === "SHORT" && bybitLongPct < 50);
                if (!bybitConfirms) continue;

                const now = Date.now();
                if (sentSignals[symbol] && (now - sentSignals[symbol]) < 1000 * 60 * 60 * 4) continue;

                let score = 5;
                if (Math.abs(oiChangePct) > 2) score += 2;
                if (side === "LONG" && funding < 0) score += 3;
                if (side === "SHORT" && funding > 0.0005) score += 3;

                sentSignals[symbol] = now;
                const emoji = side === "LONG" ? "🚀" : "🩸";

                const text = `<b>${emoji} ${signalType}</b>\n` +
                             `#${symbol} @ ${t.lastPrice}\n\n` +
                             `⭐ <b>SCORE: ${score}/10</b>\n\n` +
                             `📊 <b>PERCENTILLA (500h):</b>\n` +
                             `• Whale: <b>${whalePerc.toFixed(1)}%</b>\n` +
                             `• Retail: <b>${retailPerc.toFixed(1)}%</b>\n\n` +
                             `👥 <b>VALORI ATTUALI:</b>\n` +
                             `• Whales: <code>${(curWhale * 100).toFixed(1)}%</code>\n` +
                             `• Retail: <code>${(curRetail * 100).toFixed(1)}%</code>\n` +
                             `• Divergenza: <b>${binDiv.toFixed(1)}%</b>\n\n` +
                             `🔥 <b>DATI QUANT:</b>\n` +
                             `• OI Change: <code>${oiChangePct.toFixed(2)}%</code>\n` +
                             `• Bybit Sentiment: <code>${bybitLongPct.toFixed(1)}% Long</code>\n` +
                             `• Funding: <code>${(funding * 100).toFixed(4)}%</code>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { 
                    chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" 
                }).catch(()=>{});
            }
        }
    } catch (e) { console.error("Errore:", e.message); }
}

setInterval(scan, SCAN_INTERVAL);
scan();
