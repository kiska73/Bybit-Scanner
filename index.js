const axios = require('axios');

// ==========================================================================
// SNIPER ELITE v16.6 - ELITE QUANT (Percentile + OI/MC + Funding Bias)
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SCAN_INTERVAL = 1000 * 60 * 45; 
const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";

function calculatePercentile(current, history) {
    const values = history.map(h => parseFloat(h.longAccount));
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max === min) return 50; 
    return ((current - min) / (max - min)) * 100;
}

async function scan() {
    console.log("🎯 Sniper Elite Quant: Analisi in corso...");
    try {
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' } });
        // Filtriamo per volume minimo 5M per evitare "shitcoin" senza liquidità
        const symbols = tickersRes.data.result.list.filter(t => parseFloat(t.turnover24h) > 5000000);

        for (const t of symbols) {
            const symbol = t.symbol;

            const [topHist, globHist, bybitRatioResp, oiResp, coinInfo] = await Promise.all([
                axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(()=>null),
                axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(()=>null),
                axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: 1 } }).catch(()=>null),
                axios.get(`${BASE_BYBIT}/v5/market/open-interest`, { params: { category: 'linear', symbol, intervalTime: '1h', limit: 4 } }).catch(()=>null),
                axios.get(`${BASE_BYBIT}/v5/market/instruments-info`, { params: { category: 'linear', symbol } }).catch(()=>null)
            ]);

            if (!topHist?.data?.length || !globHist?.data?.length || !bybitRatioResp?.data?.result?.list?.[0] || !oiResp?.data?.result?.list?.length) continue;

            // 1. Dati Binance & Percentile
            const currentWhaleRatio = parseFloat(topHist.data[topHist.data.length - 1].longAccount);
            const currentRetailRatio = parseFloat(globHist.data[globHist.data.length - 1].longAccount);
            const whalePerc = calculatePercentile(currentWhaleRatio, topHist.data);
            
            // 2. Analisi OI & OI/MC (Bybit)
            const oiList = oiResp.data.result.list;
            const currentOiValue = parseFloat(oiList[0].openInterest) * parseFloat(t.lastPrice);
            const prevOi = parseFloat(oiList[oiList.length - 1].openInterest);
            const oiChangePct = ((parseFloat(oiList[0].openInterest) - prevOi) / prevOi) * 100;
            
            // Nota: Market Cap reale è difficile da API per tutte, usiamo il Volume 24h come proxy di liquidità o un ratio OI/Vol
            const oiVolRatio = (currentOiValue / parseFloat(t.turnover24h)) * 100;

            // 3. Dati Bybit Sentiment & Funding
            const bybitLongPct = parseFloat(bybitRatioResp.data.result.list[0].buyRatio) * 100;
            const funding = parseFloat(t.fundingRate);

            // --- TRIGGER LOGIC ---
            const isLongSignal = whalePerc > 92;
            const isShortSignal = whalePerc < 8;
            const bybitConfirms = isLongSignal ? bybitLongPct > 50 : bybitLongPct < 50;

            if ((isLongSignal || isShortSignal) && bybitConfirms) {
                
                // --- CALCOLO SCORE QUALITÀ (Max 10) ---
                let score = 5;
                if (oiChangePct > 2) score += 1;
                if (oiChangePct > 5) score += 1;
                
                // Bonus Funding (Se remano contro il movimento = Squeeze probabile)
                if (isLongSignal && funding < 0) score += 2; // Whales Long + Retail paga per Shortare = 🚀
                if (isShortSignal && funding > 0.0005) score += 2; // Whales Short + Retail paga per Longare = 🩸
                
                // Bonus Tensione (OI/Vol Ratio)
                if (oiVolRatio > 20) score += 1; // Alta leva rispetto agli scambi

                const side = isLongSignal ? "LONG" : "SHORT";
                const emoji = isLongSignal ? "🚀" : "🩸";

                const text = `<b>${emoji} CARICO ESPLOSIVO ${side}</b>\n#${symbol} @ ${t.lastPrice}\n\n` +
                             `⭐ <b>SCORE QUALITÀ: ${score}/10</b>\n` +
                             `📊 <b>PERCENTILE 500H:</b> <code>${whalePerc.toFixed(1)}%</code>\n\n` +
                             `🔥 <b>DATI QUANT:</b>\n` +
                             `• OI Change (4h): <code>${oiChangePct > 0 ? '📈' : '📉'} ${oiChangePct.toFixed(2)}%</code>\n` +
                             `• OI/Vol Ratio: <code>${oiVolRatio.toFixed(1)}%</code>\n` +
                             `• Funding: <code>${(funding * 100).toFixed(4)}%</code>\n\n` +
                             `👥 <b>SENTIMENT:</b>\n` +
                             `• Whales (Bin): <code>${(currentWhaleRatio * 100).toFixed(1)}%</code>\n` +
                             `• Bybit Sentiment: <code>${bybitLongPct.toFixed(1)}% Long</code>\n\n` +
                             `✅ <b>ALLINEAMENTO CROSS-EXCHANGE OK</b>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { 
                    chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" 
                }).catch(()=>{});
            }
        }
    } catch (e) { console.error("Errore:", e.message); }
    console.log("✅ Ciclo Elite completato.");
}

setInterval(scan, SCAN_INTERVAL);
scan();
