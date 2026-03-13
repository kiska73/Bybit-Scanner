const axios = require('axios');

// ==========================================================================
// 🎯 SNIPER ELITE v33.4 - ALL-IN-ONE COMPACT (Bybit + Binance)
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SCAN_INTERVAL = 1000 * 60 * 50; 
const MIN_FUNDING_THRESHOLD = 0.0001; 
const SQUEEZE_THRESHOLD = 1.0; 

const BASE_BINANCE = "https://fapi.binance.com";
const BASE_BYBIT = "https://api.bybit.com";

const MANUAL_SUPPLY = { 'PIPPIN': 1000000000, 'PNUT': 1000000000, 'ACT': 1000000000 };

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
                    const [topHist, globHist, bybitOIRes, bybitWhaleRes] = await Promise.all([
                        axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(() => null),
                        axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(() => null),
                        axios.get(`${BASE_BYBIT}/v5/market/open-interest`, { params: { category: 'linear', symbol: symbol, intervalTime: '1h' } }).catch(() => null),
                        axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol: symbol, period: '1h', limit: 1 } }).catch(() => null)
                    ]);

                    if (!topHist?.data || !globHist?.data) return;

                    const curWhaleB = parseFloat(topHist.data[topHist.data.length - 1].longShortRatio);
                    const curRetailB = parseFloat(globHist.data[globHist.data.length - 1].longShortRatio);
                    
                    let side = "";
                    if (curWhaleB > 1.2 && curRetailB < 0.8) side = "LONG";
                    else if (curWhaleB < 0.8 && curRetailB > 1.2) side = "SHORT";
                    else if (curWhaleB > 1.1 && curRetailB > 1.1) side = "LONG";
                    else if (curWhaleB < 0.9 && curRetailB < 0.9) side = "SHORT";

                    if (side !== "") {
                        const funding = fundingMap[symbol] ?? 0;
                        if ((side === "LONG" && funding <= -MIN_FUNDING_THRESHOLD) || (side === "SHORT" && funding >= MIN_FUNDING_THRESHOLD)) {
                            
                            // 1. WHALES BYBIT (Dato integrato)
                            let whaleBybit = "N.D.";
                            if (bybitWhaleRes?.data?.result?.list?.[0]) {
                                const bRatio = parseFloat(bybitWhaleRes.data.result.list[0].buySellRatio);
                                const isAligned = (side === "LONG" && bRatio > 1.0) || (side === "SHORT" && bRatio < 1.0);
                                whaleBybit = `<b>${bRatio.toFixed(2)}:1</b> ${isAligned ? "✅" : "❌"}`;
                            }

                            // 2. SQUEEZE POTENTIAL
                            let oiInfo = "";
                            let supply = MANUAL_SUPPLY[asset] || 0;
                            if (supply === 0) {
                                const sRes = await axios.get(`https://www.binance.com/bapi/composite/v1/public/marketing/tradingPair/detail?symbol=${asset.toLowerCase()}`).catch(() => null);
                                supply = parseFloat(sRes?.data?.data?.[0]?.circulatingSupply) || 0;
                            }

                            if (bybitOIRes?.data?.result?.list?.[0] && supply > 0) {
                                const oiUsd = parseFloat(bybitOIRes.data.result.list[0].openInterest) * currentPrice;
                                const mcUsd = supply * currentPrice;
                                const ratio = (oiUsd / mcUsd) * 100;
                                const fuel = (side === "LONG") ? (ratio * (1/(1+curRetailB))) : (ratio * (curRetailB/(1+curRetailB)));
                                oiInfo = `\n📊 <b>OI/MC Bybit:</b> <code>${ratio.toFixed(2)}%</code>\n` +
                                         `🔥 <b>Squeeze.:</b> <code>${fuel.toFixed(2)}%</code> ${fuel >= SQUEEZE_THRESHOLD ? "✅" : "❌"}`;
                            }

                            // MESSAGGIO UNICO COMPATTO
                            const msg = `<b>${side === "LONG" ? "🚀" : "🩸"} SEGNALE ${side}</b>\n` +
                                         `#${symbol} @ ${currentPrice}\n\n` +
                                         `🐋 <b>Whales Bybit:</b> ${whaleBybit}\n` +
                                         `💸 <b>Funding:</b> <code>${(funding*100).toFixed(4)}%</code> ⚡` +
                                         oiInfo;

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
