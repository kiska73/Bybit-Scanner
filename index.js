const axios = require('axios');

// ==========================================
// CONFIGURAZIONE
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SOGLIA_ALTA = 90;   // Modificata su tua richiesta
const SOGLIA_BASSA = 10;  // Modificata su tua richiesta
const LOOKBACK = 500; 
const MIN_VOL_24H_USDT = 2000000;
const SCAN_INTERVAL = 1000 * 60 * 50; 

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";

let BINANCE_SYMBOLS = new Set();
let isScanning = false;

// Variabili di Cache
let scanCount = 0;
const sentimentCache = {};
const CACHE_TTL = 1000 * 60 * 60 * 3; // 3 ore

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==========================================
// FUNZIONI MATEMATICHE
// ==========================================
function getRelativePosition(current, history) {
    if (!history || history.length < 24) return 50;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < history.length; i++) {
        const v = history[i];
        if (v < min) min = v; 
        if (v > max) max = v;
    }
    if (max === min) return 50;
    return Math.max(0, Math.min(100, ((current - min) / (max - min)) * 100));
}

// ==========================================
// FETCH DATI CON SMART CACHE
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
                axios.get(`${BASE_BYBIT}/v5/market/open-interest`, { params: { category: 'linear', symbol, intervalTime: '1h', limit: 5 }, timeout: 5000 }).catch(() => ({data:null})),
                axios.get(`${BASE_BYBIT}/v5/market/kline`, { params: { category: 'linear', symbol, interval: '60', limit: 5 }, timeout: 5000 }).catch(() => ({data:null}))
            ]);
        } else {
            let [bybitResp, binGlobalResp, binTopResp, oiResp, klineResp] = await Promise.all([
                axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK }, timeout: 5000 }).catch(() => ({data:null})),
                axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: 500 }, timeout: 5000 }).catch(() => ({data:null})),
                axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: 500 }, timeout: 5000 }).catch(() => ({data:null})),
                axios.get(`${BASE_BYBIT}/v5/market/open-interest`, { params: { category: 'linear', symbol, intervalTime: '1h', limit: 5 }, timeout: 5000 }).catch(() => ({data:null})),
                axios.get(`${BASE_BYBIT}/v5/market/kline`, { params: { category: 'linear', symbol, interval: '60', limit: 5 }, timeout: 5000 }).catch(() => ({data:null}))
            ]);

            bybitList = bybitResp.data?.result?.list || [];
            binGlobal = binGlobalResp.data || [];
            binTop    = binTopResp.data || [];
            oiRes = oiResp;
            klineRes = klineResp;

            if (bybitList.length && binGlobal.length && binTop.length) {
                sentimentCache[symbol] = { 
                    bybitList, binGlobal, binTop, 
                    timestamp: Date.now() 
                };
            }
        }

        const oiList = oiRes?.data?.result?.list || [];
        const klines = klineRes?.data?.result?.list || [];

        if (!bybitList.length || !binGlobal.length || !binTop.length || klines.length < 5 || oiList.length < 5) return null;

        const currentPrice = parseFloat(klines[0][4]); 
        const oldPrice = parseFloat(klines[klines.length - 1][4]); 
        const pricePct = ((currentPrice - oldPrice) / oldPrice) * 100;

        const currentOI = parseFloat(oiList[0].openInterest);
        const oldOI = parseFloat(oiList[oiList.length - 1].openInterest);
        const oiPct = ((currentOI - oldOI) / oldOI) * 100;

        const bybitPos = getRelativePosition(parseFloat(bybitList[0].buyRatio), bybitList.map(x => parseFloat(x.buyRatio)));
        const binRetailPos = getRelativePosition(parseFloat(binGlobal[binGlobal.length-1].longAccount), binGlobal.map(x => parseFloat(x.longAccount)));
        const binWhalePos = getRelativePosition(parseFloat(binTop[binTop.length-1].longAccount), binTop.map(x => parseFloat(x.longAccount)));

        const fundingRaw = parseFloat(ticker.fundingRate);

        return {
            symbol, bybitPos, binRetailPos, binWhalePos, 
            oiPct: oiPct.toFixed(2), 
            pricePct: pricePct.toFixed(2),
            price: currentPrice,
            funding: (fundingRaw * 100).toFixed(4),
            fundingRaw,
            oiRaw: oiPct,
            priceRaw: pricePct
        };
    } catch (e) { return null; }
}

// ==========================================
// SCANNER PRINCIPALE V8 – GOD MODE
// ==========================================
async function scan() {
    if (isScanning) return;
    isScanning = true;
    
    const isCacheUpdate = (scanCount % 3 === 0);
    console.log(`\n--- [${new Date().toLocaleTimeString()}] SCAN #${scanCount} | CACHE: ${isCacheUpdate ? "AGGIORNAMENTO" : "ATTIVA"} ---`);

    try {
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' } });
        const allTickers = tickersRes.data?.result?.list || [];

        const candidates = allTickers.filter(t => {
            const fund = Math.abs(parseFloat(t.fundingRate));
            return BINANCE_SYMBOLS.has(t.symbol) && 
                   parseFloat(t.turnover24h) >= MIN_VOL_24H_USDT && 
                   fund >= 0.0001; 
        });

        console.log(`Mercati analizzati: ${candidates.length}`);

        for (let i = 0; i < candidates.length; i++) {
            const data = await fetchDeepData(candidates[i].symbol, candidates[i]);
            await sleep(isCacheUpdate ? 1000 : 150);

            if (!data) continue;

            let type = "";
            let emoji = "🎯";
            let finalMsg = "";

            // --- MATRICE SEGNALI (NOMENCLATURA CHIARA) ---
            
            // 1. PUMP WHALE (Whales cariche + OI crescente)
            if (data.binWhalePos >= 97 && data.oiRaw > 1) { 
                type = "POSSIBILE PUMP (Whale Accumulation)"; 
                emoji = "🐋💎"; 
                finalMsg = "💥 Le balene stanno caricando pesantemente."; 
            }
            // 2. LONG TRAP (Long intrappolati: prezzo giù, OI su, funding alto)
            else if (data.fundingRaw > 0.0003 && data.priceRaw < -0.8 && data.oiRaw > 2) { 
                type = "LONG TRAP (Possibile Crollo)"; 
                emoji = "⚠️🚨"; 
                finalMsg = "💥 Long intrappolati: possibile cascata di liquidazioni."; 
            }
            // 3. SHORT SQUEEZE GIÀ PARTITO (Funding alto, OI scende, Prezzo esplode)
            else if (data.fundingRaw > 0.0003 && data.oiRaw < -3 && data.priceRaw > 1) { 
                type = "SHORT SQUEEZE (Liquidazioni in Corso)"; 
                emoji = "🚀🔥"; 
                finalMsg = "💥 Gli Short stanno esplodendo ora!"; 
            }
            // 4. SHORT SQUEEZE INNESCO (KITE CASE: Funding negativo, prezzo sale, OI sale)
            else if (data.fundingRaw < -0.0003 && data.priceRaw > 0.8 && data.oiRaw > 2) { 
                type = "SHORT SQUEEZE (Innesco imminente)"; 
                emoji = "⚠️🚀"; 
                finalMsg = "💥 Short bloccati sotto pressione: pronti a saltare."; 
            }
            // 5. TRUE SQUEEZE (Crollo OI verticale)
            else if (data.oiRaw < -8 && Math.abs(data.priceRaw) > 2) { 
                type = "SQUEEZE VIOLENTO (Liquidazioni Massa)"; 
                emoji = "🧨"; 
                finalMsg = "💥 Movimento guidato da chiusure forzate (Stop Loss)."; 
            }
            // 6. ACCUMULO WHALE / DISTRIBUZIONE (Divergenza Sentiment)
            else if (data.binRetailPos >= SOGLIA_ALTA && data.binWhalePos <= SOGLIA_BASSA) { 
                type = "DISTRIBUZIONE (Whales Short / Retail Long)"; 
                emoji = "⚡"; 
                finalMsg = "💥 Possibile inversione: le balene stanno scaricando."; 
            }
            else if (data.binRetailPos <= SOGLIA_BASSA && data.binWhalePos >= SOGLIA_ALTA) { 
                type = "ACCUMULO (Whales Long / Retail Short)"; 
                emoji = "💎⚡"; 
                finalMsg = "💥 Possibile pump: le balene stanno accumulando."; 
            }

            if (!type) continue;

            // --- CALCOLO SCORE (0-10) ---
            let score = 0;
            if (Math.abs(data.fundingRaw) >= 0.0003) score += 2;
            if (Math.abs(data.oiRaw) >= 2) score += 2;
            if (Math.abs(data.priceRaw) >= 1) score += 2;
            if (data.binWhalePos >= 90 || data.binWhalePos <= 10) score += 2;
            if (data.binRetailPos >= 90 || data.binRetailPos <= 10) score += 2;
            score = Math.min(10, score);
            const scoreEmoji = score >= 8 ? "🔥" : score >= 6 ? "🟡" : "⚪";

            // --- INVIO TELEGRAM ---
            const text = `
<b>${emoji} SEGNALE: ${type}</b>
#${data.symbol} @ ${data.price}

🔥 <b>Score: ${score}/10 ${scoreEmoji}</b>

📊 <b>4H DATA</b>
Prezzo → <code>${data.pricePct}%</code>
Open Int. → <code>${data.oiPct}%</code>
Funding → <code>${data.funding}%</code>

👥 <b>SENTIMENT (Pos. Storica)</b>
Retail → ${data.binRetailPos.toFixed(0)}%
Whales → ${data.binWhalePos.toFixed(0)}%
Bybit → ${data.bybitPos.toFixed(0)}%

<i>${finalMsg}</i>
            `.trim();

            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }).catch(() => {});
            await sleep(2000);
        }

    } catch (err) { console.error("Errore Scan:", err.message); }
    finally { 
        isScanning = false; 
        scanCount++; 
        console.log("--- SCAN COMPLETATO ---"); 
    }
}

// ==========================================
// INIZIALIZZAZIONE
// ==========================================
async function initialize() {
    try {
        const binInfo = await axios.get(`${BASE_BINANCE}/fapi/v1/exchangeInfo`);
        BINANCE_SYMBOLS = new Set(binInfo.data.symbols.filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT').map(s => s.symbol));
        console.log("Sistema Quant v8 (Soglie 90/10) Online. Caccia aperta!");
        scan();
        setInterval(scan, SCAN_INTERVAL);
    } catch (e) { console.error("Init Error:", e.message); }
}

initialize();
