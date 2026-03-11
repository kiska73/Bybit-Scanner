const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

// CONFIGURAZIONE RIGIDA
const P_HIGH  = 90;   
const P_LOW   = 10;   
const VOL_MIN = 2000000; 

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";
let sentSignals = {}; 

function calculatePercentile(current, history) {
    const values = history.map(h => parseFloat(h.longAccount));
    const countBelow = values.filter(v => v < current).length;
    return (countBelow / values.length) * 100;
}

async function scan() {
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
            const bybitLongPct = parseFloat(bybitRatioResp.data.result.list[0].buyRatio) * 100;

            // --- FILTRO SUPREMO 90/10 ---
            let signalType = "";
            let side = "";

            if (whalePerc > P_HIGH && retailPerc < P_LOW) { signalType = "DIVERGENZA LONG"; side = "LONG"; }
            else if (whalePerc < P_LOW && retailPerc > P_HIGH) { signalType = "DIVERGENZA SHORT"; side = "SHORT"; }
            else if (whalePerc < P_LOW && retailPerc < P_LOW) { signalType = "ESTREMO PANICO"; side = "LONG"; }
            else if (whalePerc > P_HIGH && retailPerc > P_HIGH) { signalType = "ESTREMO EUFORIA"; side = "SHORT"; }

            if (signalType !== "") {
                // Bybit deve essere d'accordo
                if ((side === "LONG" && bybitLongPct < 50) || (side === "SHORT" && bybitLongPct > 50)) continue;

                const now = Date.now();
                if (sentSignals[symbol] && (now - sentSignals[symbol]) < 1000 * 60 * 60 * 4) continue;
                sentSignals[symbol] = now;

                const text = `<b>🎯 ${signalType}</b>\n#${symbol}\n\n` +
                             `📊 <b>PERCENTILLA (OBBLIGATORIA):</b>\n` +
                             `• Whale: <b>${whalePerc.toFixed(1)}%</b>\n` +
                             `• Retail: <b>${retailPerc.toFixed(1)}%</b>\n\n` +
                             `✅ <b>SEGNALE VALIDATO 90/10</b>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }).catch(()=>{});
            }
        }
    } catch (e) { console.error(e.message); }
}

setInterval(scan, 1000 * 60 * 30);
scan();
