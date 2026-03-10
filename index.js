const axios = require('axios');

// ==========================================
// SNIPER ELITE v15.3 - BATCH SNIPER EDITION
// Focus: Parallel Batching, OB Safety, Balanced Multipliers
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const MIN_VOL_24H_USDT = 3000000; 
const SCAN_INTERVAL = 1000 * 60 * 45; 
const BATCH_SIZE = 4; // Analizziamo 4 monete alla volta (Punto 4)

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";

let BINANCE_SYMBOLS = new Set();
let isScanning = false;
let isBanned = false; 

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function safeApiCall(url, params) {
    if (isBanned) return null;
    try {
        return await axios.get(url, { params, timeout: 6000 });
    } catch (e) {
        if (e.response?.status === 429) {
            const retryAfter = parseInt(e.response.headers['retry-after']) || 60;
            console.error(`⚠️ RATE LIMIT! Pausa per ${retryAfter}s`);
            isBanned = true;
            setTimeout(() => { isBanned = false; }, retryAfter * 1000);
        }
        return null;
    }
}

async function fetchDeepData(symbol, ticker) {
    try {
        let [bybitResp, binGlobalResp, binTopResp, oiResp] = await Promise.all([
            safeApiCall(`${BASE_BYBIT}/v5/market/account-ratio`, { category: 'linear', symbol, period: '1h', limit: 50 }),
            safeApiCall(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { symbol, period: '1h', limit: 50 }),
            safeApiCall(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { symbol, period: '1h', limit: 50 }),
            safeApiCall(`${BASE_BYBIT}/v5/market/open-interest`, { category: 'linear', symbol, intervalTime: '1h', limit: 5 })
        ]);

        if (!bybitResp || !binGlobalResp || !binTopResp || !oiResp) return null;

        const binTop = binTopResp.data || [];
        const binGlobal = binGlobalResp.data || [];
        const oiListRaw = oiResp.data?.result?.list || [];

        if (!binTop.length || !binGlobal.length || !oiListRaw.length) return null;

        // --- CALCOLO SPECINDEX (Funding Multiplier * 30 - Punto 2) ---
        const sortedOi = [...oiListRaw].sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp));
        const newestOi = parseFloat(sortedOi[sortedOi.length - 1].openInterest);
        const oldestOi = parseFloat(sortedOi[0].openInterest);
        const oiPct = ((newestOi - oldestOi) / oldestOi) * 100;
        
        const currentPrice = parseFloat(ticker.lastPrice);
        const fundingRaw = parseFloat(ticker.fundingRate);
        const hourlyVol = (parseFloat(ticker.turnover24h) / 24);
        
        // Formula Bilanciata: (OI_USDT / Vol_Orario) * (1 + |Fund| * 30)
        const specIndex = (newestOi * currentPrice / hourlyVol) * (1 + Math.abs(fundingRaw) * 30);

        // Pre-filtro per risparmiare Orderbook
        if (Math.abs(oiPct) < 1.5 && specIndex < 80) return null;

        // --- ORDERBOOK (Protezione Crash - Punto 1) ---
        const obRes = await safeApiCall(`${BASE_BYBIT}/v5/market/orderbook`, { category: 'linear', symbol, limit: 50 });
        if (!obRes || !obRes.data?.result) return null;

        const bids = obRes.data.result.b || [];
        const asks = obRes.data.result.a || [];

        if (bids.length === 0 || asks.length === 0) return null; // Safe check

        let bidVol = 0, askVol = 0;
        const mid = (parseFloat(bids[0][0]) + parseFloat(asks[0][0])) / 2;

        bids.forEach(lvl => {
            const weight = Math.exp(-(Math.abs(parseFloat(lvl[0]) - mid) / mid) * 40);
            bidVol += parseFloat(lvl[1]) * weight;
        });
        asks.forEach(lvl => {
            const weight = Math.exp(-(Math.abs(parseFloat(lvl[0]) - mid) / mid) * 40);
            askVol += parseFloat(lvl[1]) * weight;
        });

        const whaleLongPct = parseFloat(binTop[binTop.length - 1].longAccount) * 100;
        const retailLongPct = parseFloat(binGlobal[binGlobal.length - 1].longAccount) * 100;

        return {
            symbol, whaleLongPct, retailLongPct, divergenceVal: whaleLongPct - retailLongPct,
            obRatio: askVol > 0 ? bidVol / askVol : 1, 
            oiPct: oiPct.toFixed(2), fundingRaw, oiRaw: oiPct, specIndex: specIndex.toFixed(1), price: currentPrice
        };
    } catch (e) { return null; }
}

async function scan() {
    if (isScanning || isBanned) return;
    isScanning = true;
    console.log("🚀 Scansione v15.3 avviata...");
    
    try {
        const tickersRes = await safeApiCall(`${BASE_BYBIT}/v5/market/tickers`, { category: 'linear' });
        if (!tickersRes) { isScanning = false; return; }

        const candidates = (tickersRes.data?.result?.list || []).filter(t => 
            BINANCE_SYMBOLS.has(t.symbol) && parseFloat(t.turnover24h) >= MIN_VOL_24H_USDT
        );

        // --- ELABORAZIONE A BATCH (Punto 4) ---
        for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
            if (isBanned) break;

            const batch = candidates.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(t => fetchDeepData(t.symbol, t)));

            for (const data of results) {
                if (!data) continue;

                let score = 0;
                if (Math.abs(data.divergenceVal) > 8) score += 4;
                if (data.obRatio > 1.6 || data.obRatio < 0.6) score += 3;
                if (data.specIndex > 100) score += 2;
                if (Math.abs(data.fundingRaw) >= 0.0015) score += 1;

                if (score >= 6) {
                    let type = "📊 ANALISI SNIPER"; let emoji = "📊";
                    if (data.oiRaw < -2.5 && data.divergenceVal > 8) { type = "🟢 SHORT SQUEEZE"; emoji = "🧨🚀"; }
                    else if (data.oiRaw < -2.5 && data.divergenceVal < -8) { type = "🔴 LONG SQUEEZE"; emoji = "🧨🩸"; }

                    const text = `<b>${emoji} ${type}</b>\n#${data.symbol} @ ${data.price}\n\n⭐ Score: ${score}/10\n⚡ Spec Index: ${data.specIndex}%\n📖 Book Ratio: ${data.obRatio.toFixed(2)}\n🐋 Div: ${data.divergenceVal.toFixed(1)}%\n📊 OI: ${data.oiPct}%`;
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }).catch(()=>{});
                }
            }
            await sleep(600); // Pausa tra i batch per non saturare Bybit
        }
    } catch (err) {}
    finally { isScanning = false; console.log("✅ Fine scansione."); }
}

async function initialize() {
    try {
        const binInfo = await axios.get(`${BASE_BINANCE}/fapi/v1/exchangeInfo`);
        BINANCE_SYMBOLS = new Set(binInfo.data.symbols.filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT').map(s => s.symbol));
        scan(); setInterval(scan, SCAN_INTERVAL);
        console.log("Sniper v15.3 Quant Sniper Online. Batching attivo.");
    } catch (e) {}
}
initialize();
