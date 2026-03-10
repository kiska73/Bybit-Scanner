const axios = require('axios');

// ==========================================================================
// SNIPER ELITE v15.4 - ACTIONABLE QUANT SNIPER
// Focus: Batching, Exponential OB, Funding-Weighted SpecIndex & Narrative
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const MIN_VOL_24H_USDT = 3000000; 
const SCAN_INTERVAL = 1000 * 60 * 45; 
const BATCH_SIZE = 4; // Processa 4 monete in parallelo

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";

let BINANCE_SYMBOLS = new Set();
let isScanning = false;
let isBanned = false; 

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- GESTIONE RATE LIMIT DINAMICA ---
async function safeApiCall(url, params) {
    if (isBanned) return null;
    try {
        return await axios.get(url, { params, timeout: 8000 });
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

// --- ANALISI PROFONDA SINGOLA MONETA ---
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

        // --- 1. OPEN INTEREST & SPEC INDEX (Funding * 30) ---
        const sortedOi = [...oiListRaw].sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp));
        const newestOi = parseFloat(sortedOi[sortedOi.length - 1].openInterest);
        const oldestOi = parseFloat(sortedOi[0].openInterest);
        const oiPct = ((newestOi - oldestOi) / oldestOi) * 100;
        
        const currentPrice = parseFloat(ticker.lastPrice);
        const fundingRaw = parseFloat(ticker.fundingRate);
        const hourlyVol = (parseFloat(ticker.turnover24h) / 24);
        
        // Formula: (OI_USDT / Vol_Orario) * (1 + |Fund| * 30)
        const specIndex = (newestOi * currentPrice / hourlyVol) * (1 + Math.abs(fundingRaw) * 30);

        // --- 2. PRE-FILTRO (Salva-API) ---
        if (Math.abs(oiPct) < 1.5 && specIndex < 80) return null;

        // --- 3. ORDERBOOK EXPONENTIAL DECAY ---
        const obRes = await safeApiCall(`${BASE_BYBIT}/v5/market/orderbook`, { category: 'linear', symbol, limit: 50 });
        if (!obRes || !obRes.data?.result) return null;

        const bids = obRes.data.result.b || [];
        const asks = obRes.data.result.a || [];
        if (!bids.length || !asks.length) return null;

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

// --- CICLO DI SCANSIONE ---
async function scan() {
    if (isScanning || isBanned) return;
    isScanning = true;
    console.log(`[${new Date().toLocaleTimeString()}] Scansione avviata...`);
    
    try {
        const tickersRes = await safeApiCall(`${BASE_BYBIT}/v5/market/tickers`, { category: 'linear' });
        if (!tickersRes) { isScanning = false; return; }

        const candidates = (tickersRes.data?.result?.list || []).filter(t => 
            BINANCE_SYMBOLS.has(t.symbol) && parseFloat(t.turnover24h) >= MIN_VOL_24H_USDT
        );

        for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
            if (isBanned) break;

            const batch = candidates.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(t => fetchDeepData(t.symbol, t)));

            for (const data of results) {
                if (!data) continue;

                // --- CALCOLO SCORE PESATO ---
                let score = 0;
                if (Math.abs(data.divergenceVal) > 8) score += 4;
                if (data.obRatio > 1.6 || data.obRatio < 0.6) score += 3;
                if (data.specIndex > 100) score += 2;
                if (Math.abs(data.fundingRaw) >= 0.0015) score += 1;

                if (score >= 6) {
                    let title = ""; let emoji = ""; let desc = "";
                    const isSqueezing = data.oiRaw < -2.5;
                    const whaleBullish = data.divergenceVal > 8;
                    const whaleBearish = data.divergenceVal < -8;
                    const bookSupportsBuy = data.obRatio > 1.4;
                    const bookSupportsSell = data.obRatio < 0.7;

                    // --- LOGICA NARRATIVA ---
                    if (isSqueezing) {
                        if (whaleBullish && bookSupportsBuy) {
                            title = "🟢 SQUEEZE + CONTINUAZIONE RIBA";
                            emoji = "🚀🔥";
                            desc = "Retail short saltati. Whales e Book spingono ancora. Il trend ha benzina.";
                        } else if (whaleBullish && bookSupportsSell) {
                            title = "🟡 SQUEEZE REVERSE (Target Raggiunto)";
                            emoji = "⚠️🔄";
                            desc = "Squeeze finito, ma il book è saturo di vendite. Possibile storno o fakeout.";
                        } else if (whaleBearish && bookSupportsSell) {
                            title = "🔴 SQUEEZE + CONTINUAZIONE RIBASSO";
                            emoji = "🩸📉";
                            desc = "Retail long liquidati. Le balene pressano ancora in Ask. Non comprare il dip.";
                        } else if (whaleBearish && bookSupportsBuy) {
                            title = "🔵 SQUEEZE REVERSE (Muro Buy)";
                            emoji = "🛒✅";
                            desc = "Liquidazioni long terminate. Il book ha creato un muro in Bid. Rimbalzo probabile.";
                        }
                    } else if (data.oiRaw > 3 && Math.abs(data.divergenceVal) > 10) {
                        title = "💣 CARICO ESPLOSIVO (Pre-Squeeze)";
                        emoji = "🧨";
                        desc = `Divergenza enorme (${data.divergenceVal.toFixed(1)}%). Si sta caricando una molla violenta.`;
                    }

                    if (!title) continue;

                    const text = `<b>${emoji} ${title}</b>\n#${data.symbol} @ ${data.price}\n\n⭐ <b>Score: ${score}/10</b>\n⚡ <b>Quant Spec: ${data.specIndex}%</b>\n\n📝 <b>ANALISI:</b>\n<i>${desc}</i>\n\n👥 <b>DETTAGLI:</b>\n• Div: <code>${Math.abs(data.divergenceVal).toFixed(1)}% ${data.divergenceVal > 0 ? 'Bull' : 'Bear'}</code>\n• Book Ratio: <code>${data.obRatio.toFixed(2)}</code>\n• OI Change: <code>${data.oiPct}%</code>`;
                    
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }).catch(()=>{});
                }
            }
            await sleep(700); 
        }
    } catch (err) { console.error("Errore scan:", err.message); }
    finally { isScanning = false; }
}

async function initialize() {
    try {
        const binInfo = await axios.get(`${BASE_BINANCE}/fapi/v1/exchangeInfo`);
        BINANCE_SYMBOLS = new Set(binInfo.data.symbols.filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT').map(s => s.symbol));
        console.log("Sniper v15.4 Online. Modalità Batch-Quant attiva.");
        scan(); setInterval(scan, SCAN_INTERVAL);
    } catch (e) { console.error("Errore inizializzazione:", e.message); }
}

initialize();
