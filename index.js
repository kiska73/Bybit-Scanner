const axios = require('axios');

// ==========================================================================
// 🎯 SNIPER ELITE v33.1 - BYBIT OI % CALCULATION (Threshold 1.0)
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const P_HIGH  = 90;
const P_LOW    = 10;
const PERIOD  = '1h';
const LIMIT   = 500;      
const MIN_LIFE = 500;     
const VOL_MIN = 10000000;  
const SCAN_INTERVAL = 1000 * 60 * 50; 
const MIN_FUNDING_THRESHOLD = 0.0001; // 0.01%
const SQUEEZE_THRESHOLD = 1.0; // Parametro richiesto: 1.0 per la spunta verde

const BASE_BINANCE = "https://fapi.binance.com";
const BASE_BYBIT = "https://api.bybit.com";

// Database manuale per monete con API Supply problematica
const MANUAL_SUPPLY = {
    'PIPPIN': 1000000000,
    'PNUT': 1000000000,
    'ACT': 1000000000
};

let scanning = false;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function calculatePercentile(current, history) {
    if (!history || history.length === 0) return 50;
    const values = history.map(h => parseFloat(h.longShortRatio));
    const countBelow = values.filter(v => v <= current).length;
    return (countBelow / values.length) * 100;
}

async function sendTelegram(text) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML"
        });
    } catch (e) { console.error("❌ Telegram Error"); }
}

async function scan() {
    if (scanning) return;
    scanning = true;
    console.log(`🚀 [${new Date().toLocaleTimeString()}] Scan in corso...`);

    try {
        const tickersRes = await axios.get(`${BASE_BINANCE}/fapi/v1/ticker/24hr`);
        const symbols = tickersRes.data
            .filter(t => parseFloat(t.quoteVolume) > VOL_MIN && t.symbol.endsWith('USDT'))
            .sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

        const premiumRes = await axios.get(`${BASE_BINANCE}/fapi/v1/premiumIndex`);
        const fundingMap = {};
        premiumRes.data.forEach(f => { fundingMap[f.symbol] = parseFloat(f.lastFundingRate); });

        for (let i = 0; i < symbols.length; i += 3) {
            const chunk = symbols.slice(i, i + 3);

            await Promise.all(chunk.map(async (t) => {
                const symbol = t.symbol;
                const asset = symbol.replace('USDT', '');
                const currentPrice = parseFloat(t.lastPrice);

                try {
                    const [topHist, globHist, bybitOIRes] = await Promise.all([
                        axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: PERIOD, limit: LIMIT } }).catch(() => null),
                        axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: PERIOD, limit: LIMIT } }).catch(() => null),
                        axios.get(`${BASE_BYBIT}/v5/market/open-interest`, { params: { category: 'linear', symbol: symbol, intervalTime: '1h' } }).catch(() => null)
                    ]);

                    if (!topHist?.data || !globHist?.data) return;

                    const curWhaleRatio = parseFloat(topHist.data[topHist.data.length - 1].longShortRatio);
                    const curRetailRatio = parseFloat(globHist.data[globHist.data.length - 1].longShortRatio);
                    const whalePerc = calculatePercentile(curWhaleRatio, topHist.data);
                    const retailPerc = calculatePercentile(curRetailRatio, globHist.data);

                    let signalType = ""; let side = "";
                    if (whalePerc > P_HIGH && retailPerc < P_LOW) { signalType = "DIVERGENZA LONG"; side = "LONG"; }
                    else if (whalePerc < P_LOW && retailPerc > P_HIGH) { signalType = "DIVERGENZA SHORT"; side = "SHORT"; }
                    else if (whalePerc > P_HIGH && retailPerc > P_HIGH) { signalType = "CONCORDANZA LONG"; side = "LONG"; }
                    else if (whalePerc < P_LOW && retailPerc < P_LOW) { signalType = "CONCORDANZA SHORT"; side = "SHORT"; }

                    if (signalType !== "") {
                        const funding = fundingMap[symbol] ?? 0;
                        const isLongFavorable = (side === "LONG" && funding <= -MIN_FUNDING_THRESHOLD);
                        const isShortFavorable = (side === "SHORT" && funding >= MIN_FUNDING_THRESHOLD);

                        if (isLongFavorable || isShortFavorable) {
                            let oiDisplay = "";
                            
                            // RECUPERO SUPPLY
                            let supply = MANUAL_SUPPLY[asset] || 0;
                            if (supply === 0) {
                                const sRes = await axios.get(`https://www.binance.com/bapi/composite/v1/public/marketing/tradingPair/detail?symbol=${asset.toLowerCase()}`).catch(() => null);
                                supply = parseFloat(sRes?.data?.data?.[0]?.circulatingSupply) || 0;
                            }

                            if (bybitOIRes?.data?.result?.list?.[0] && supply > 0) {
                                const oiRaw = parseFloat(bybitOIRes.data.result.list[0].openInterest);
                                const oiUsd = oiRaw * currentPrice;
                                const mcUsd = supply * currentPrice;
                                const oiMcRatio = (oiUsd / mcUsd) * 100;

                                const retailShortProp = 1 / (1 + curRetailRatio);
                                const fuelMc = (side === "LONG") ? (oiMcRatio * retailShortProp) : (oiMcRatio * (1 - retailShortProp));
                                const statusEmoji = fuelMc >= SQUEEZE_THRESHOLD ? "✅" : "❌";

                                oiDisplay = `📊 <b>OI/MC Bybit:</b> <code>${oiMcRatio.toFixed(2)}%</code>\n` +
                                            `🔥 <b>Squeeze Pot.:</b> <code>${fuelMc.toFixed(2)}%</code> ${statusEmoji}`;
                            } else {
                                const oiUsdFallback = (bybitOIRes?.data?.result?.list?.[0]) ? (parseFloat(bybitOIRes.data.result.list[0].openInterest) * currentPrice / 1000000).toFixed(2) : "??";
                                oiDisplay = `⚠️ <b>OI Bybit:</b> $${oiUsdFallback}M (Supply N.D.)`;
                            }

                            const msg = `<b>${side === "LONG" ? "🚀" : "🩸"} ${signalType}</b>\n` +
                                         `#${symbol} @ ${currentPrice}\n\n` +
                                         `📊 <b>PERCENTILI (Binance):</b>\n` +
                                         `• Whales: <b>${whalePerc.toFixed(1)}%</b>\n` +
                                         `• Retail: <b>${retailPerc.toFixed(1)}%</b>\n\n` +
                                         `💸 <b>FUNDING:</b> <code>${(funding*100).toFixed(4)}%</code> ⚡\n` +
                                         `${oiDisplay}`;

                            await sendTelegram(msg);
                        }
                    }
                } catch (e) { }
            }));
            await sleep(3000);
        }
    } catch (e) { }
    scanning = false;
    console.log("✅ Scan Terminato.");
}

scan();
setInterval(scan, SCAN_INTERVAL);
