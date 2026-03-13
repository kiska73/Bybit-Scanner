const axios = require('axios');

// ==========================================================================
// 🎯 SNIPER ELITE v34.2 - BINANCE DATA ONLY (Ultra Reliable)
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SCAN_INTERVAL = 1000 * 60 * 50; 
const MIN_FUNDING_THRESHOLD = 0.0001; 
const SQUEEZE_THRESHOLD = 1.0; 

const BASE_BINANCE = "https://fapi.binance.com";
const MANUAL_SUPPLY = { 'PIPPIN': 1000000000, 'PNUT': 1000000000, 'ACT': 1000000000, 'RIVER': 1000000000 };

let scanning = false;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
            .filter(t => parseFloat(t.quoteVolume) > 10000000 && t.symbol.endsWith('USDT'))
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
                    // Recupero Dati Binance (Top Traders & Open Interest)
                    const [topHist, globHist, oiRes] = await Promise.all([
                        axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(() => null),
                        axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(() => null),
                        axios.get(`${BASE_BINANCE}/fapi/v1/openInterest`, { params: { symbol } }).catch(() => null)
                    ]);

                    if (!topHist?.data || !globHist?.data || !oiRes?.data) return;

                    const latestWhaleRatio = parseFloat(topHist.data[topHist.data.length - 1].longShortRatio);
                    const retailRatioB = parseFloat(globHist.data[globHist.data.length - 1].longShortRatio);
                    
                    const whalePerc = ((topHist.data.filter(h => parseFloat(h.longShortRatio) <= latestWhaleRatio).length) / topHist.data.length) * 100;
                    const retailPerc = ((globHist.data.filter(h => parseFloat(h.longShortRatio) <= retailRatioB).length) / globHist.data.length) * 100;

                    let signalType = ""; let side = "";
                    if (whalePerc > 90 && retailPerc < 10) { signalType = "DIVERGENZA LONG"; side = "LONG"; }
                    else if (whalePerc < 10 && retailPerc > 90) { signalType = "DIVERGENZA SHORT"; side = "SHORT"; }
                    else if (whalePerc > 90 && retailPerc > 90) { signalType = "CONCORDANZA LONG"; side = "LONG"; }
                    else if (whalePerc < 10 && retailPerc < 10) { signalType = "CONCORDANZA SHORT"; side = "SHORT"; }

                    if (side !== "") {
                        const funding = fundingMap[symbol] ?? 0;
                        if ((side === "LONG" && funding <= -MIN_FUNDING_THRESHOLD) || (side === "SHORT" && funding >= MIN_FUNDING_THRESHOLD)) {
                            
                            // Replicazione Whale Signal (Binance Top Traders)
                            const whaleLine = `🐋 <b>Whales Binance:</b> <code>${latestWhaleRatio.toFixed(2)}:1</code> ${((side === "LONG" && latestWhaleRatio > 1) || (side === "SHORT" && latestWhaleRatio < 1)) ? "✅" : "❌"}\n`;

                            // Calcolo Squeeze su Binance
                            let extraInfo = "";
                            let supply = MANUAL_SUPPLY[asset] || 0;
                            if (supply === 0) {
                                const sRes = await axios.get(`https://www.binance.com/bapi/composite/v1/public/marketing/tradingPair/detail?symbol=${asset.toLowerCase()}`).catch(() => null);
                                supply = parseFloat(sRes?.data?.data?.[0]?.circulatingSupply) || 0;
                            }

                            if (supply > 0) {
                                const oiUsd = parseFloat(oiRes.data.openInterest) * currentPrice;
                                const ratio = (oiUsd / (supply * currentPrice)) * 100;
                                const fuel = (side === "LONG") ? (ratio * (1/(1+retailRatioB))) : (ratio * (retailRatioB/(1+retailRatioB)));
                                extraInfo = `📊 <b>OI/MC:</b> <code>${ratio.toFixed(2)}%</code>\n` +
                                            `🔥 <b>Squeeze:</b> <code>${fuel.toFixed(2)}%</code> ${fuel >= SQUEEZE_THRESHOLD ? "✅" : "❌"}`;
                            }

                            const msg = `<b>${side === "LONG" ? "🚀" : "🩸"} ${signalType}</b>\n` +
                                         `#${symbol} @ ${currentPrice}\n\n` +
                                         `📊 <b>PERCENTILI (Binance):</b>\n` +
                                         `• Whales: <b>${whalePerc.toFixed(1)}%</b>\n` +
                                         `• Retail: <b>${retailPerc.toFixed(1)}%</b>\n\n` +
                                         `💸 <b>FUNDING:</b> <code>${(funding*100).toFixed(4)}%</code> ⚡\n` +
                                         whaleLine + extraInfo;

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
