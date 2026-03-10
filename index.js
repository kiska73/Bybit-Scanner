const axios = require('axios');

// ==========================================
// CONFIGURAZIONE V9.7 - ELITE SNIPER (SCORE > 5)
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SOGLIA_ALTA = 90;   
const SOGLIA_BASSA = 10;  
const MIN_VOL_24H_USDT = 3000000; // Alzato a 3M per filtrare monete troppo sottili
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

            let type = ""; let emoji = "🎯"; let finalMsg = "";
            let score = 0;

            // --- CALCOLO SCORE PREVENTIVO ---
            if (Math.abs(data.fundingRaw) >= 0.0015) score += 3;
            if (data.binWhalePos >= 90 || data.binWhalePos <= 10) score += 3;
            if (Math.abs(data.oiRaw) >= 3.5) score += 2;
            if (Math.abs(data.priceRaw) >= 1.2) score += 2;
            score = Math.min(10, score);

            // --- FILTRO DI QUALITÀ: SOLO SCORE > 5 ---
            if (score < 5) continue;

            // --- LOGICA SEGNALI RESTRITTIVA ---
            
            // 1. SQUEEZE (Liquidazioni pesanti)
            if (data.oiRaw < -4.0 && Math.abs(data.priceRaw) > 1.0) {
                const dir = data.priceRaw > 0 ? "🟢 BULLISH" : "🔴 BEARISH";
                type = `${dir} SQUEEZE (Liquidazioni)`;
                emoji = "🧨";
                finalMsg = "L'OI sta crollando bruscamente: qualcuno è saltato in aria!";
            }
            // 2. SHORT SQUEEZE INNESCO
            else if (data.fundingRaw < -0.0015 && data.priceRaw > 0.8 && data.binWhaleRatio > 50) {
                type = "🟢 SHORT SQUEEZE (Innesco)";
                emoji = "⚠️🔥";
                finalMsg = "Funding negativo e balene Long. Gli shortisti sono in trappola!";
            }
            // 3. LONG TRAP
            else if (data.fundingRaw > 0.0015 && data.priceRaw < -0.8 && data.binWhaleRatio < 50) {
                type = "🔴 LONG TRAP (Pericolo)";
                emoji = "⚠️📉";
                finalMsg = "Long intrappolati mentre le balene spingono short.";
            }
            // 4. WHALE POWER
            else if (data.binWhalePos > 92 && data.bybitPos > 55 && data.oiRaw > 1.0) {
                type = "🟢 WHALE PUMP (Alta confidenza)";
                emoji = "🐋🚀";
                finalMsg = "Massimo carico balene su entrambi gli exchange.";
            }

            if (!type) continue;

            const text = `<b>${emoji} SEGNALE: ${type}</b>
#${data.symbol} @ ${data.price}

🔥 <b>Score: ${score}/10 ${score >= 8 ? "🔥" : ""}</b>

📊 <b>4H DATA</b>
OI: <code>${data.oiPct}%</code> | Fund: <code>${data.funding}%</code>
Price: <code>${data.pricePct}%</code>

👥 <b>SENTIMENT</b>
Binance Whales: ${data.binWhaleRatio.toFixed(1)}% (Pos: ${data.binWhalePos.toFixed(0)}%)
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
        console.log("Sniper Elite v9.7 - Filtro Qualità Attivo (Score > 5)");
        scan(); setInterval(scan, SCAN_INTERVAL);
    } catch (e) {}
}
initialize();
