const axios = require('axios');

// ==========================================================================
// 🎯 SNIPER ELITE v32.9 - BYBIT DATA INTEGRATION
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
const MIN_FUNDING_THRESHOLD = 0.0001; 

const BASE_BINANCE = "https://fapi.binance.com";
const BASE_BYBIT = "https://api.bybit.com"; // API Bybit per Open Interest

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

                try {
                    // Chiamate parallele: Percentili da Binance, OI da Bybit
                    const [topHist, globHist, bybitOIRes] = await Promise.all([
                        axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: PERIOD, limit: LIMIT } }).catch(() => null),
                        axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: PERIOD, limit: LIMIT } }).catch(() => null),
                        axios.get(`${BASE_BYBIT}/v5/market/open-interest`, { params: { category: 'linear', symbol: symbol, intervalTime: '1h' } }).catch(() => null)
                    ]);

                    if (!topHist?.data || !globHist?.data) return;

                    const whalePerc = calculatePercentile(parseFloat(topHist.data[topHist.data.length - 1].longShortRatio), topHist.data);
                    const retailPerc = calculatePercentile(parseFloat(globHist.data[globHist.data.length - 1].longShortRatio), globHist.data);

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
                            let oiInfo = "📊 OI Bybit: <i>Non trovato</i>";
                            
                            if (bybitOIRes?.data?.result?.list?.[0]) {
                                const oiVal = parseFloat(bybitOIRes.data.result.list[0].openInterest);
                                const oiUsd = oiVal * parseFloat(t.lastPrice);
                                const oiMln = (oiUsd / 1000000).toFixed(2);
                                
                                // Nota: Per avere OI/MC precisa serve la circulating supply, 
                                // qui ti mostro l'OI in milioni di $ da Bybit, che è il dato reale del tuo screen.
                                oiInfo = `📊 <b>OI Bybit:</b> <code>$${oiMln}M</code>\n` +
                                         `🔥 <b>Squeeze Pot:</b> Alta (Funding Estremo)`;
                            }

                            const msg = `<b>${side === "LONG" ? "🚀" : "🩸"} ${signalType}</b>\n` +
                                         `#${symbol} @ ${t.lastPrice}\n\n` +
                                         `📊 <b>PERCENTILI (Binance):</b>\n` +
                                         `• Whales: <b>${whalePerc.toFixed(1)}%</b>\n` +
                                         `• Retail: <b>${retailPerc.toFixed(1)}%</b>\n\n` +
                                         `💸 <b>FUNDING:</b> <code>${(funding*100).toFixed(4)}%</code> ⚡\n` +
                                         `${oiInfo}`;

                            await sendTelegram(msg);
                        }
                    }
                } catch (e) { }
            }));
            await sleep(3000);
        }
    } catch (e) { }
    scanning = false;
}

scan();
setInterval(scan, SCAN_INTERVAL);
