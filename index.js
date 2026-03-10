const axios = require('axios');

// ==========================================
// SNIPER ELITE v11 - TRUTH DETECTOR EDITION
// Focus: Rilevazione Trappole e Divergenze
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const MIN_VOL_24H_USDT = 3000000; 
const SCAN_INTERVAL = 1000 * 60 * 50; 

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";

let BINANCE_SYMBOLS = new Set();
let isScanning = false;
let scanCount = 0;
const sentimentCache = {};
const CACHE_TTL = 1000 * 60 * 60 * 3; 

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getRelativePosition(current, history) {
    if (!history || history.length < 24) return 50;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < history.length; i++) {
        const v = history[i];
        if (v < min) min = v; if (v > max) max = v;
    }
    if (max === min) return 50;
    return Math.max(0, Math.min(100, ((current - min) / (max - min)) * 100));
}

async function fetchDeepData(symbol, ticker) {
    try {
        let bybitList, binGlobal, binTop, oiRes, klineRes;
        const isValidCache = sentimentCache[symbol] && (Date.now() - sentimentCache[symbol].timestamp < CACHE_TTL);
        const useCache = (scanCount % 3 !== 0) && isValidCache;

        if (useCache) {
            bybitList = sentimentCache[symbol].bybitList;
            binGlobal = sentimentCache[symbol].binGlobal;
            binTop    = sentimentCache[symbol].binTop;
            [oiRes, klineRes] = await Promise.all([
                axios.get(`${BASE_BYBIT}/v5/market/open-interest`, { params: { category: 'linear', symbol, intervalTime: '1h', limit: 5 } }),
                axios.get(`${BASE_BYBIT}/v5/market/kline`, { params: { category: 'linear', symbol, interval: '60', limit: 5 } })
            ]);
        } else {
            let [bybitResp, binGlobalResp, binTopResp, oiResp, klineResp] = await Promise.all([
                axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: 500 } }),
                axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: 500 } }),
                axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: 500 } }),
                axios.get(`${BASE_BYBIT}/v5/market/open-interest`, { params: { category: 'linear', symbol, intervalTime: '1h', limit: 5 } }),
                axios.get(`${BASE_BYBIT}/v5/market/kline`, { params: { category: 'linear', symbol, interval: '60', limit: 5 } })
            ]);
            bybitList = bybitResp.data?.result?.list || [];
            binGlobal = binGlobalResp.data || [];
            binTop    = binTopResp.data || [];
            oiRes = oiResp; klineRes = klineResp;
            if (bybitList.length && binGlobal.length && binTop.length) {
                sentimentCache[symbol] = { bybitList, binGlobal, binTop, timestamp: Date.now() };
            }
        }

        const binWhaleRatio = parseFloat(binTop[binTop.length - 1].longAccount) * 100;
        const binWhalePos = getRelativePosition(parseFloat(binTop[binTop.length - 1].longAccount), binTop.map(x => parseFloat(x.longAccount)));
        const bybitPos = getRelativePosition(parseFloat(bybitList[0].buyRatio), bybitList.map(x => parseFloat(x.buyRatio)));

        const klines = klineRes?.data?.result?.list || [];
        const oiList = oiRes?.data?.result?.list || [];
        const currentPrice = parseFloat(klines[0][4]); 
        const pricePct = ((currentPrice - parseFloat(klines[klines.length-1][4])) / parseFloat(klines[klines.length-1][4])) * 100;
        const oiPct = ((parseFloat(oiList[0].openInterest) - parseFloat(oiList[oiList.length-1].openInterest)) / parseFloat(oiList[oiList.length-1].openInterest)) * 100;

        return {
            symbol, bybitPos, binWhalePos, binWhaleRatio,
            oiPct: oiPct.toFixed(2), pricePct: pricePct.toFixed(2),
            price: currentPrice, funding: (parseFloat(ticker.fundingRate) * 100).toFixed(4),
            fundingRaw: parseFloat(ticker.fundingRate), oiRaw: oiPct, priceRaw: pricePct
        };
    } catch (e) { return null; }
}

async function scan() {
    if (isScanning) return;
    isScanning = true;
    try {
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' } });
        const candidates = (tickersRes.data?.result?.list || []).filter(t => 
            BINANCE_SYMBOLS.has(t.symbol) && parseFloat(t.turnover24h) >= MIN_VOL_24H_USDT
        );

        for (let i = 0; i < candidates.length; i++) {
            const data = await fetchDeepData(candidates[i].symbol, candidates[i]);
            await sleep(150);
            if (!data) continue;

            let score = 0;
            if (Math.abs(data.fundingRaw) >= 0.0015) score += 3; 
            if (data.binWhalePos >= 90 || data.binWhalePos <= 10) score += 3; 
            if (Math.abs(data.oiRaw) >= 2.5) score += 2; 
            if (Math.abs(data.priceRaw) >= 1.0) score += 2;
            score = Math.min(10, score);

            if (score <= 6) continue;

            let type = ""; let emoji = "🎯"; let alertStatus = "✅ CONFERMATO";
            let finalMsg = "";

            // --- LOGICA DIVERGENZA (LA FINTA) ---
            const isWhaleLong = data.binWhaleRatio > 50;
            const priceIsFalling = data.priceRaw < -0.3;
            const priceIsRising = data.priceRaw > 0.3;

            if (isWhaleLong && priceIsFalling) {
                alertStatus = "⚠️ DIVERGENZA: BULL TRAP?";
                type = "🔴 POSSIBILE TRAPPOLA PER LONG";
                emoji = "🪤";
                finalMsg = "Le Balene caricano Long ma il prezzo cade. Possibile caccia agli stop!";
            } else if (!isWhaleLong && priceIsRising) {
                alertStatus = "⚠️ DIVERGENZA: BEAR TRAP?";
                type = "🟢 POSSIBILE TRAPPOLA PER SHORT";
                emoji = "🪤";
                finalMsg = "Le Balene caricano Short ma il prezzo sale. Possibile Short Squeeze in arrivo!";
            } else {
                // --- SEGNALI STANDARD SE PREZZO E SENTIMENT SONO ALLINEATI ---
                if (data.oiRaw < -3.5) {
                    type = data.priceRaw > 0 ? "🟢 BULLISH SQUEEZE" : "🔴 BEARISH SQUEEZE";
                    emoji = "🧨";
                    finalMsg = "Liquidazioni in corso. Segui il trend veloce!";
                } else if (data.fundingRaw < -0.0015) {
                    type = "🟢 SHORT SQUEEZE (Innesco)";
                    emoji = "🔥";
                    finalMsg = "Funding negativo estremo. Gli shortisti pagano caro.";
                } else if (data.binWhalePos > 92) {
                    type = "🟢 WHALE PUMP (Alta Confidenza)";
                    emoji = "🐋";
                    finalMsg = "Allineamento Balene massimo. Forza confermata.";
                }
            }

            if (!type) continue;

            const text = `<b>${emoji} ${type}</b>
#${data.symbol} @ ${data.price}

🔥 <b>Score: ${score}/10</b>
📢 <b>Stato: ${alertStatus}</b>

📊 <b>DATA 4H</b>
OI: <code>${data.oiPct}%</code> | Fund: <code>${data.funding}%</code>
Price: <code>${data.pricePct}%</code>

👥 <b>SENTIMENT WHALES</b>
Binance: ${data.binWhaleRatio.toFixed(1)}% (Pos: ${data.binWhalePos.toFixed(0)}%)
Bybit Top 100: ${data.bybitPos.toFixed(0)}%

<i>${finalMsg}</i>`.trim();

            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }).catch(() => {});
            await sleep(2000);
        }
    } catch (err) {}
    finally { isScanning = false; scanCount++; }
}

async function initialize() {
    try {
        const binInfo = await axios.get(`${BASE_BINANCE}/fapi/v1/exchangeInfo`);
        BINANCE_SYMBOLS = new Set(binInfo.data.symbols.filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT').map(s => s.symbol));
        console.log("Sniper Elite v11 - Truth Detector Online. Pronto a scovare le trappole.");
        scan(); setInterval(scan, SCAN_INTERVAL);
    } catch (e) {}
}
initialize();
