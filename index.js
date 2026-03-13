const axios = require('axios');

// ==========================================================================
// 🎯 SNIPER ELITE v36.5 - FULL CHECK (Spunta Funding & Dati Binance)
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SCAN_INTERVAL = 1000 * 60 * 50; 
const MIN_FUNDING_THRESHOLD = 0.0001; 
const SQUEEZE_THRESHOLD = 1.0; 

const BASE_BINANCE = "https://fapi.binance.com";

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

        for (let i = 0; i < symbols.length; i += 3) {
            const chunk = symbols.slice(i, i + 3);

            await Promise.all(chunk.map(async (t) => {
                const symbol = t.symbol;
                const currentPrice = parseFloat(t.lastPrice);
                const quoteVolume = parseFloat(t.quoteVolume);

                try {
                    // Fetch Dati Binance (Top Traders, Global Ratio, OI, Funding specifico)
                    const [topHist, globHist, oiHist, fundRes] = await Promise.all([
                        axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(() => null),
                        axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(() => null),
                        axios.get(`${BASE_BINANCE}/futures/data/openInterestHist`, { params: { symbol, period: '1h', limit: 2 } }).catch(() => null),
                        axios.get(`${BASE_BINANCE}/fapi/v1/fundingRate`, { params: { symbol, limit: 1 } }).catch(() => null)
                    ]);

                    if (!topHist?.data || !globHist?.data || !oiHist?.data) return;

                    const latestWhaleRatio = parseFloat(topHist.data[topHist.data.length - 1].longShortRatio);
                    const latestRetailRatio = parseFloat(globHist.data[globHist.data.length - 1].longShortRatio);
                    
                    // Calcolo Percentili (su 500 ore / circa 20 giorni)
                    const whalePerc = ((topHist.data.filter(h => parseFloat(h.longShortRatio) <= latestWhaleRatio).length) / topHist.data.length) * 100;
                    const retailPerc = ((globHist.data.filter(h => parseFloat(h.longShortRatio) <= latestRetailRatio).length) / globHist.data.length) * 100;

                    let signalType = ""; let side = "";
                    if (whalePerc > 90 && retailPerc < 10) { signalType = "DIVERGENZA LONG"; side = "LONG"; }
                    else if (whalePerc < 10 && retailPerc > 90) { signalType = "DIVERGENZA SHORT"; side = "SHORT"; }
                    else if (whalePerc > 90 && retailPerc > 90) { signalType = "CONCORDANZA LONG"; side = "LONG"; }
                    else if (whalePerc < 10 && retailPerc < 10) { signalType = "CONCORDANZA SHORT"; side = "SHORT"; }

                    if (side !== "") {
                        const funding = fundRes?.data?.[0] ? parseFloat(fundRes.data[0].fundingRate) : 0;
                        
                        // Controllo direzione funding (Favorevole = ricevi interessi)
                        const isFundingOk = (side === "LONG" && funding < 0) || (side === "SHORT" && funding > 0);
                        
                        if ((side === "LONG" && funding <= -MIN_FUNDING_THRESHOLD) || (side === "SHORT" && funding >= MIN_FUNDING_THRESHOLD)) {
                            
                            // Whale Signal Line
                            const whaleLine = `🐋 <b>Whales Binance:</b> <code>${latestWhaleRatio.toFixed(2)}:1</code> ${((side === "LONG" && latestWhaleRatio > 1) || (side === "SHORT" && latestWhaleRatio < 1)) ? "✅" : "❌"}\n`;

                            // OI Trend e Proxy Squeeze
                            const currentOI = parseFloat(oiHist.data[oiHist.data.length - 1].sumOpenInterestValue);
                            const prevOI = parseFloat(oiHist.data[oiHist.data.length - 2].sumOpenInterestValue);
                            const oiChange = ((currentOI - prevOI) / prevOI) * 100;

                            const marketCapProxy = quoteVolume * 20; 
                            const oiMcRatio = (currentOI / marketCapProxy) * 100;
                            const fuel = (side === "LONG") ? (oiMcRatio * (1/(1+latestRetailRatio))) : (oiMcRatio * (latestRetailRatio/(1+latestRetailRatio)));

                            const msg = `<b>${side === "LONG" ? "🚀" : "🩸"} ${signalType}</b>\n` +
                                         `#${symbol} @ ${currentPrice}\n\n` +
                                         `📊 <b>PERCENTILI (Binance):</b>\n` +
                                         `• Whales: <b>${whalePerc.toFixed(1)}%</b>\n` +
                                         `• Retail: <b>${retailPerc.toFixed(1)}%</b>\n\n` +
                                         `📈 <b>OI 1h:</b> <code>${oiChange > 0 ? "+" : ""}${oiChange.toFixed(2)}%</code>\n` +
                                         `💸 <b>FUNDING:</b> <code>${(funding*100).toFixed(4)}%</code> ${isFundingOk ? "✅" : "❌"}\n` +
                                         whaleLine +
                                         `📊 <b>OI/MC Proxy:</b> <code>${oiMcRatio.toFixed(2)}%</code>\n` +
                                         `🔥 <b>Squeeze:</b> <code>${fuel.toFixed(2)}%</code> ${fuel >= SQUEEZE_THRESHOLD ? "✅" : "❌"}`;

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
