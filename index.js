const axios = require('axios');

// ==========================================
// CONFIGURAZIONE ULTIMATE FAST & SAFE
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SOGLIA_ALTA_BIN = 95; 
const SOGLIA_BASSA_BIN = 5;
const SOGLIA_BYBIT_LONG = 80;
const SOGLIA_BYBIT_SHORT = 20;

const LOOKBACK = 48; 
const MIN_VOL_2M = 2000000;
const SCAN_INTERVAL = 1000 * 60 * 30; // 30 minuti

// Fix: Concurrency prudente per evitare 429 (Rate Limit)
const CONCURRENCY_LIMIT = 8; 

const BASE_BYBIT = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";

let PAIRS = [];
let isScanning = false; // Protezione Race Condition
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==========================================
// LOGICA DI CALCOLO
// ==========================================

function getPosition(current, history) {
    const values = history.map(v => parseFloat(v));
    const max = Math.max(...values);
    const min = Math.min(...values);
    if (max === min) return 50;
    return Math.max(0, Math.min(100, ((current - min) / (max - min)) * 100));
}

async function fetchFullData(symbol, tickerMap) {
    try {
        // Chiamate parallele per la singola moneta
        const [resBybit, resBinH, resBinT] = await Promise.all([
            axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK }, timeout: 7000 }),
            axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: LOOKBACK }, timeout: 7000 }),
            axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: LOOKBACK }, timeout: 7000 })
        ]);

        const bList = resBybit.data?.result?.list || [];
        const hData = resBinH.data || [];
        const tData = resBinT.data || [];

        if (bList.length < 5 || hData.length < 5 || tData.length < 5) return null;

        // Bybit data (ordine corretto)
        const latestBybit = bList[bList.length - 1];
        const currentBybitRatio = parseFloat(latestBybit.buyRatio || 0) * 100;
        const ticker = tickerMap.get(symbol);

        // Binance data (più recente allo 0)
        const hHist = hData.map(x => parseFloat(x.longAccount || 0));
        const tHist = tData.map(x => parseFloat(x.longAccount || 0));

        return {
            symbol,
            hPos: getPosition(hHist[0], hHist),
            tPos: getPosition(tHist[0], tHist),
            hVal: (hHist[0] * 100).toFixed(1),
            tVal: (tHist[0] * 100).toFixed(1),
            bybitVal: currentBybitRatio,
            fund: ticker ? (parseFloat(ticker.fundingRate || 0) * 100).toFixed(4) : '0.0000',
            price: ticker ? parseFloat(ticker.lastPrice || 0) : 0
        };
    } catch (e) {
        return null;
    }
}

// ==========================================
// CORE SCANNER
// ==========================================

async function scan() {
    if (isScanning) {
        console.log("⚠️ Scan già attivo, salto...");
        return;
    }
    
    isScanning = true;
    const startTime = Date.now();

    try {
        const tickRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' }, timeout: 10000 });
        const tickerMap = new Map(tickRes.data.result.list.map(t => [t.symbol, t]));
        
        const targetPairs = PAIRS.filter(s => {
            const t = tickerMap.get(s);
            return t && parseFloat(t.turnover24h || 0) >= MIN_VOL_2M;
        });

        console.log(`🚀 Scan veloce avviato su ${targetPairs.length} coppie (Batch: ${CONCURRENCY_LIMIT})`);

        let messages = [];
        
        for (let i = 0; i < targetPairs.length; i += CONCURRENCY_LIMIT) {
            const batch = targetPairs.slice(i, i + CONCURRENCY_LIMIT);
            const results = await Promise.all(batch.map(s => fetchFullData(s, tickerMap)));

            results.forEach(res => {
                if (!res) return;

                let type = "";
                if (res.hPos >= SOGLIA_ALTA_BIN && res.tPos <= SOGLIA_BASSA_BIN && res.bybitVal >= SOGLIA_BYBIT_LONG) {
                    type = "⚡ SQUEEZE LONG (Divergenza)";
                } else if (res.hPos <= SOGLIA_BASSA_BIN && res.tPos >= SOGLIA_ALTA_BIN && res.bybitVal <= SOGLIA_BYBIT_SHORT) {
                    type = "⚠️ SHORT SQUEEZE (Divergenza)";
                } else if (res.hPos >= SOGLIA_ALTA_BIN && res.tPos >= SOGLIA_ALTA_BIN && res.bybitVal >= SOGLIA_BYBIT_LONG) {
                    type = "🚀 ECCESSO LONG UNANIME";
                } else if (res.hPos <= SOGLIA_BASSA_BIN && res.tPos <= SOGLIA_BASSA_BIN && res.bybitVal <= SOGLIA_BYBIT_SHORT) {
                    type = "📉 ECCESSO SHORT UNANIME";
                }

                if (type) {
                    // Fix: Protezione crash su prezzo undefined/null
                    const priceStr = res.price ? res.price.toFixed(4) : "N/A";
                    
                    messages.push(`
<b>${type}</b>
<b>#${res.symbol}</b> @ ${priceStr}
————————————
Binance Holder Pos: <b>${res.hPos.toFixed(0)}%</b>
Binance Top Pos: <b>${res.tPos.toFixed(0)}%</b>
Bybit Retail: <b>${res.bybitVal.toFixed(1)}%</b>
💰 Funding: <b>${res.fund}%</b> ${parseFloat(res.fund) > 0 ? '🔴' : '🟢'}
                    `.trim());
                }
            });
            
            await sleep(400); // Pausa per rientrare nei rate limit
        }

        if (messages.length > 0) {
            for (let j = 0; j < messages.length; j += 4) {
                const chunk = messages.slice(j, j + 4).join("\n\n—————\n\n");
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: `<b>📊 REPORT FAST 95/5</b>\n\n${chunk}`,
                    parse_mode: "HTML"
                }, { timeout: 10000 }).catch(() => {});
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✅ Scan completato in ${duration}s. Segnali: ${messages.length}`);

    } catch (e) {
        console.error("❌ Errore Scan:", e.message);
    } finally {
        isScanning = false; // Rilascio lock obbligatorio
    }
}

async function init() {
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/instruments-info`, { params: { category: "linear" } });
        PAIRS = res.data.result.list.filter(p => p.quoteCoin === "USDT" && p.status === "Trading").map(p => p.symbol);
        console.log(`🚀 Radar Fast Inizializzato. ${PAIRS.length} coppie.`);
        scan();
        setInterval(scan, SCAN_INTERVAL);
    } catch (e) {
        console.error("❌ Init fallito");
    }
}

init();
