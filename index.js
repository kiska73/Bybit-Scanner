const axios = require('axios');

// ==========================================
// CONFIGURAZIONE SNIPER ELITE V9.2
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SOGLIA_ALTA = 90;   
const SOGLIA_BASSA = 10;  
const LOOKBACK = 500; 
const MIN_VOL_24H_USDT = 2000000;
const SCAN_INTERVAL = 1000 * 60 * 50; 

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";

let BINANCE_SYMBOLS = new Set();
let isScanning = false;

// Cache Smart
let scanCount = 0;
const sentimentCache = {};
const CACHE_TTL = 1000 * 60 * 60 * 3; 

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==========================================
// LOGICA MATEMATICA
// ==========================================
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

// ==========================================
// FETCH DATI COMPLETO
// ==========================================
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
                axios.get(`${BASE_BYBIT}/v5/market/open-interest`, { params: { category: 'linear', symbol, intervalTime: '1h', limit: 5 } }).catch(() => ({data:null})),
                axios.get(`${BASE_BYBIT}/v5/market/kline`, { params: { category: 'linear', symbol, interval: '60', limit: 5 } }).catch(() => ({data:null}))
            ]);
        } else {
            let [bybitResp, binGlobalResp, binTopResp, oiResp, klineResp] = await Promise.all([
                axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK } }).catch(() => ({data:null})),
                axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(() => ({data:null})),
                axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(() => ({data:null})),
                axios.get(`${BASE_BYBIT}/v5/market/open-interest`, { params: { category: 'linear', symbol, intervalTime: '1h', limit: 5 } }).catch(() => ({data:null})),
                axios.get(`${BASE_BYBIT}/v5/market/kline`, { params: { category: 'linear', symbol, interval: '60', limit: 5 } }).catch(() => ({data:null}))
            ]);
            bybitList = bybitResp.data?.result?.list || [];
            binGlobal = binGlobalResp.data || [];
            binTop    = binTopResp.data || [];
            oiRes = oiResp; klineRes = klineResp;
            if (bybitList.length && binGlobal.length && binTop.length) {
                sentimentCache[symbol] = { bybitList, binGlobal, binTop, timestamp: Date.now() };
            }
        }

        const oiList = oiRes?.data?.result?.list || [];
        const klines = klineRes?.data?.result?.list || [];
        if (!bybitList.length || !binGlobal.length || !binTop.length || klines.length < 5 || oiList.length < 5) return null;

        const currentPrice = parseFloat(klines[0][4]); 
        const pricePct = ((currentPrice - parseFloat(klines[klines.length-1][4])) / parseFloat(klines[klines.length-1][4])) * 100;
        const oiPct = ((parseFloat(oiList[0].openInterest) - parseFloat(oiList[oiList.length-1].openInterest)) / parseFloat(oiList[oiList.length-1].openInterest)) * 100;
        
        const bybitPos = getRelativePosition(parseFloat(bybitList[0].buyRatio), bybitList.map(x => parseFloat(x.buyRatio)));
        const binRetailPos = getRelativePosition(parseFloat(binGlobal[binGlobal.length-1].longAccount), binGlobal.map(x => parseFloat(x.longAccount)));
        const binWhalePos = getRelativePosition(parseFloat(binTop[binTop.length-1].longAccount), binTop.map(x => parseFloat(x.longAccount)));

        return {
            symbol, bybitPos, binRetailPos, binWhalePos, 
            oiPct: oiPct.toFixed(2), pricePct: pricePct.toFixed(2),
            price: currentPrice, funding: (parseFloat(ticker.fundingRate) * 100).toFixed(4),
            fundingRaw: parseFloat(ticker.fundingRate), oiRaw: oiPct, priceRaw: pricePct
        };
    } catch (e) { return null; }
}

// ==========================================
// SCANNER V9.2 - CROSS-EXCHANGE (FUND 0.1%)
// ==========================================
async function scan() {
    if (isScanning) return;
    isScanning = true;
    const isCacheUpdate = (scanCount % 3 === 0);
    console.log(`\n--- [${new Date().toLocaleTimeString()}] SCAN #${scanCount} | CACHE: ${isCacheUpdate ? "OFF" : "ON"} ---`);

    try {
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' } });
        const candidates = (tickersRes.data?.result?.list || []).filter(t => 
            BINANCE_SYMBOLS.has(t.symbol) && parseFloat(t.turnover24h) >= MIN_VOL_24H_USDT && Math.abs(parseFloat(t.fundingRate)) >= 0.0001
        );

        console.log(`Mercati analizzati: ${candidates.length}`);

        for (let i = 0; i < candidates.length; i++) {
            const data = await fetchDeepData(candidates[i].symbol, candidates[i]);
            await sleep(isCacheUpdate ? 1000 : 150);
            if (!data) continue;

            let type = ""; let emoji = "🎯"; let finalMsg = "";
            
            const isBullishAligned = data.binWhalePos >= SOGLIA_ALTA && data.bybitPos >= 50;
            const isBearishAligned = data.binWhalePos <= SOGLIA_BASSA && data.bybitPos <= 50;

            // --- MATRICE SEGNALI AGGIORNATA FUNDING 0.1% (0.0010) ---
            
            if (isBullishAligned && data.oiRaw > 1) {
                type = "🟢 POSSIBILE PUMP (Allineamento Whales)";
                emoji = "🐋💎";
                finalMsg = "Whales Binance (>90%) e Bybit (>50%) cariche!";
            }
            else if (data.fundingRaw < -0.0010 && data.priceRaw > 0.8 && isBullishAligned) {
                type = "🟢 SHORT SQUEEZE (Innesco Allineato)";
                emoji = "⚠️🚀";
                finalMsg = "Funding Negativo (-0.1%) e Balene coordinate al rialzo!";
            }
            else if (data.fundingRaw > 0.0010 && data.priceRaw < -0.8 && isBearishAligned) {
                type = "🔴 LONG TRAP (Pericolo Crollo Allineato)";
                emoji = "⚠️🚨";
                finalMsg = "Funding Positivo (+0.1%) e Balene coordinate al ribasso!";
            }
            else if (data.oiRaw < -8 && Math.abs(data.priceRaw) > 2) {
                const dir = data.priceRaw > 0 ? "🟢 BULLISH" : "🔴 BEARISH";
                type = `${dir} SQUEEZE (Liquidazioni Massa)`;
                emoji = "🧨";
                finalMsg = `Liquidazioni di massa verso il ${data.priceRaw > 0 ? 'alto' : 'basso'}.`;
            }
            else if (data.binRetailPos <= SOGLIA_BASSA && isBullishAligned) {
                type = "🟢 ACCUMULO ISTITUZIONALE (Bin+Byb)";
                emoji = "💎⚡";
                finalMsg = "Retail Short, Balene Binance e Bybit coordinate Long.";
            }
            else if (data.binRetailPos >= SOGLIA_ALTA && isBearishAligned) {
                type = "🔴 DISTRIBUZIONE ISTITUZIONALE (Bin+Byb)";
                emoji = "⚡📉";
                finalMsg = "Retail Long, Balene coordinate in uscita o Short.";
            }

            if (!type) continue;

            // Score calculation
            let score = 0;
            if (Math.abs(data.fundingRaw) >= 0.0010) score += 3; // +3 punti per funding caldo
            if (Math.abs(data.fundingRaw) >= 0.0030) score += 1; // +1 extra se arriva a 0.3%
            if (Math.abs(data.oiRaw) >= 2) score += 2;
            if (isBullishAligned || isBearishAligned) score += 2;
            if (Math.abs(data.priceRaw) >= 1) score += 2;
            score = Math.min(10, score);

            const bybitStatus = data.bybitPos > 50 ? "🐂 BULLISH (>50%)" : "🐻 BEARISH (<50%)";
            const text = `<b>${emoji} SEGNALE: ${type}</b>
#${data.symbol} @ ${data.price}

🔥 <b>Score: ${score}/10 ${score >= 8 ? "🔥" : "⚪"}</b>

📊 <b>4H DATA</b>
Prezzo → <code>${data.pricePct}%</code>
OI → <code>${data.oiPct}%</code>
Fund → <code>${data.funding}%</code>

👥 <b>SENTIMENT WHALES</b>
Binance → ${data.binWhalePos.toFixed(0)}%
Bybit Top 100 → ${bybitStatus}

<i>${finalMsg}</i>`.trim();

            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }).catch(() => {});
            await sleep(2000);
        }
    } catch (err) { console.error("Errore Scan:", err.message); }
    finally { isScanning = false; scanCount++; console.log("--- FINE ---"); }
}

async function initialize() {
    try {
        const binInfo = await axios.get(`${BASE_BINANCE}/fapi/v1/exchangeInfo`);
        BINANCE_SYMBOLS = new Set(binInfo.data.symbols.filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT').map(s => s.symbol));
        console.log("-----------------------------------------");
        console.log("SNIPER ELITE v9.2 - FUNDING 0.1%");
        console.log("-----------------------------------------");
        scan(); setInterval(scan, SCAN_INTERVAL);
    } catch (e) { console.error("Init Error"); }
}
initialize();
