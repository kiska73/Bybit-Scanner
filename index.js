const axios = require('axios');

// ==========================================================================
// 🎯 SNIPER ELITE v32.8 - VISUAL OI/MC EDITION
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
const MIN_FUNDING_THRESHOLD = 0.0001; // Rimesso a 0.01% per vedere più segnali

const BASE_BINANCE = "https://fapi.binance.com";
const BASE_BINANCE_WEB = "https://www.binance.com";
const BATCH_SIZE = 3;      
const BATCH_DELAY = 3000;  

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

        for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
            const chunk = symbols.slice(i, i + BATCH_SIZE);

            await Promise.all(chunk.map(async (t) => {
                const symbol = t.symbol;
                const asset = symbol.replace('USDT', '');
                const currentPrice = parseFloat(t.lastPrice);

                try {
                    const [topHist, globHist, oiRes, supplyRes] = await Promise.all([
                        axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: PERIOD, limit: LIMIT } }).catch(() => null),
                        axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: PERIOD, limit: LIMIT } }).catch(() => null),
                        axios.get(`${BASE_BINANCE}/fapi/v1/openInterest`, { params: { symbol } }).catch(() => null),
                        axios.get(`${BASE_BINANCE_WEB}/bapi/composite/v1/public/marketing/tradingPair/detail?symbol=${asset.toLowerCase()}`).catch(() => null)
                    ]);

                    if (!topHist?.data || topHist.data.length < MIN_LIFE || !globHist?.data || globHist.data.length < MIN_LIFE) return;

                    const curWhaleRatio = parseFloat(topHist.data[topHist.data.length - 1].longShortRatio);
                    const curRetailRatio = parseFloat(globHist.data[globHist.data.length - 1].longShortRatio);
                    const whalePerc = calculatePercentile(curWhaleRatio, topHist.data);
                    const retailPerc = calculatePercentile(curRetailRatio, globHist.data);

                    let signalType = "";
                    let side = "";

                    if (whalePerc > P_HIGH && retailPerc < P_LOW) { signalType = "DIVERGENZA LONG"; side = "LONG"; }
                    else if (whalePerc < P_LOW && retailPerc > P_HIGH) { signalType = "DIVERGENZA SHORT"; side = "SHORT"; }
                    else if (whalePerc > P_HIGH && retailPerc > P_HIGH) { signalType = "CONCORDANZA LONG"; side = "LONG"; }
                    else if (whalePerc < P_LOW && retailPerc < P_LOW) { signalType = "CONCORDANZA SHORT"; side = "SHORT"; }

                    if (signalType !== "") {
                        const funding = fundingMap[symbol] ?? 0;
                        const isLongFavorable = (side === "LONG" && funding <= -MIN_FUNDING_THRESHOLD);
                        const isShortFavorable = (side === "SHORT" && funding >= MIN_FUNDING_THRESHOLD);

                        if (isLongFavorable || isShortFavorable) {
                            let oiText = "⚠️ <i>Dati Supply non disponibili</i>";
                            
                            if (oiRes?.data && supplyRes?.data?.data?.[0]) {
                                const cs = parseFloat(supplyRes.data.data[0].circulatingSupply) || 0;
                                const oiUsd = parseFloat(oiRes.data.openInterest) * currentPrice;
                                const mcUsd = cs * currentPrice;

                                if (mcUsd > 0) {
                                    const oiMcRatio = (oiUsd / mcUsd) * 100;
                                    const retailShortProp = 1 / (1 + curRetailRatio);
                                    const retailLongProp = curRetailRatio / (1 + curRetailRatio);
                                    
                                    // Squeeze potenziale: quanto OI è "intrappolato" contro di noi
                                    const fuelMc = (side === "LONG") 
                                        ? (oiUsd * retailShortProp / mcUsd) * 100 
                                        : (oiUsd * retailLongProp / mcUsd) * 100;

                                    // Spunta: se fuelMc > 0.5% è Verde, altrimenti Rossa
                                    const statusEmoji = fuelMc >= 0.5 ? "✅" : "❌";
                                    
                                    oiText = `📊 <b>OI/MC Totale:</b> <code>${oiMcRatio.toFixed(2)}%</code>\n` +
                                             `🔥 <b>Squeeze Pot.:</b> <code>${fuelMc.toFixed(2)}%</code> ${statusEmoji}`;
                                }
                            }

                            const msg = `<b>${side === "LONG" ? "🚀" : "🩸"} ${signalType}</b>\n` +
                                         `#${symbol} @ ${currentPrice}\n\n` +
                                         `📊 <b>PERCENTILI:</b>\n` +
                                         `• Whales: <b>${whalePerc.toFixed(1)}%</b>\n` +
                                         `• Retail: <b>${retailPerc.toFixed(1)}%</b>\n\n` +
                                         `💸 <b>FUNDING:</b> <code>${(funding*100).toFixed(4)}%</code> ⚡\n` +
                                         `${oiText}`;

                            await sendTelegram(msg);
                        }
                    }
                } catch (e) { /* Skip moneta */ }
            }));
            if (i + BATCH_SIZE < symbols.length) await sleep(BATCH_DELAY);
        }
        console.log(`✅ Scan Terminato.`);
    } catch (e) { console.error("🔴 Errore:", e.message); }
    scanning = false;
}

scan();
setInterval(scan, SCAN_INTERVAL);
