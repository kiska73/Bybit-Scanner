const axios = require('axios');

// ==========================================
// CONFIGURAZIONE
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

// SOGLIE SENTIMENT (Perpetual)
const SOGLIA_ALTA_BIN    = 90;
const SOGLIA_BASSA_BIN   = 10;
const SOGLIA_BYBIT_LONG  = 80;
const SOGLIA_BYBIT_SHORT = 20;

// SOGLIE MURI (Spot)
const WALL_DOMINANCE_THRESHOLD = 0.35;   // 35% dei primi 20 bucket
const WALL_MIN_VALUE_USD       = 100000;  // minimo $100k
const WALL_DISTANCE_PCT        = 2.5;    // entro 2.5% dal prezzo

const LOOKBACK           = 48;
const MIN_VOL_24H_USDT   = 2000000;
const SCAN_INTERVAL      = 1000 * 60 * 30; 
const REQUEST_DELAY      = 900;     
const CONCURRENCY_LIMIT  = 3;

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";
const SPOT_BINANCE = "https://api.binance.com";

let PAIRS = [];
let BINANCE_SYMBOLS = new Set();
let isScanning = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==========================================
// FUNZIONE DI RAGGRUPPAMENTO (NUOVA - FIX MURI)
// ==========================================
function aggregateLevels(levels, currentPrice) {
    const aggregated = new Map();

    // Precisioni dinamiche in base al prezzo (più realistico possibile)
    let decimals;
    if      (currentPrice < 0.001) decimals = 8;
    else if (currentPrice < 0.01)  decimals = 6;
    else if (currentPrice < 0.1)   decimals = 5;
    else if (currentPrice < 1)     decimals = 4;
    else if (currentPrice < 10)    decimals = 3;
    else if (currentPrice < 100)   decimals = 2;
    else if (currentPrice < 1000)  decimals = 1;
    else                           decimals = 0;

    const factor = Math.pow(10, decimals);

    levels.forEach(([pStr, qStr]) => {
        let p = parseFloat(pStr);
        let q = parseFloat(qStr);
        if (isNaN(p) || isNaN(q) || q <= 0) return;

        // Arrotondamento al tick più vicino
        const rounded = Math.round(p * factor) / factor;

        aggregated.set(rounded, (aggregated.get(rounded) || 0) + q);
    });

    return aggregated;
}

// ==========================================
// FUNZIONE MURI SPOT CON RAGGRUPPAMENTO
// ==========================================
function findSpotWalls(symbol, rawBids, rawAsks, currentPrice) {
    if (!rawBids || !rawAsks || rawBids.length < 20 || !currentPrice) return [];

    const bidsMap = aggregateLevels(rawBids, currentPrice);
    const asksMap = aggregateLevels(rawAsks, currentPrice);

    // Converti in array ordinati
    const bids = Array.from(bidsMap.entries()).sort((a, b) => b[0] - a[0]); // prezzo alto → basso
    const asks = Array.from(asksMap.entries()).sort((a, b) => a[0] - b[0]); // prezzo basso → alto

    // Volume totale primi 20 bucket
    const topBidVol = bids.slice(0, 20).reduce((sum, [, q]) => sum + (q * currentPrice), 0);
    const topAskVol = asks.slice(0, 20).reduce((sum, [, q]) => sum + (q * currentPrice), 0);

    const walls = [];

    // BUY WALLS
    bids.slice(0, 30).forEach(([p, q]) => {
        const val = p * q;
        const dom = topBidVol > 0 ? val / topBidVol : 0;
        const dist = ((currentPrice - p) / currentPrice) * 100;

        if (val >= WALL_MIN_VALUE_USD && 
            Math.abs(dist) <= WALL_DISTANCE_PCT && 
            dom >= WALL_DOMINANCE_THRESHOLD) {
            
            walls.push(`🟢 <b>BUY WALL</b> @ ${p}\nValore: $${Math.round(val/1000)}k\nDominanza: ${(dom*100).toFixed(0)}%\nDistanza: -${dist.toFixed(2)}%`);
        }
    });

    // SELL WALLS
    asks.slice(0, 30).forEach(([p, q]) => {
        const val = p * q;
        const dom = topAskVol > 0 ? val / topAskVol : 0;
        const dist = ((p - currentPrice) / currentPrice) * 100;

        if (val >= WALL_MIN_VALUE_USD && 
            Math.abs(dist) <= WALL_DISTANCE_PCT && 
            dom >= WALL_DOMINANCE_THRESHOLD) {
            
            walls.push(`🔴 <b>SELL WALL</b> @ ${p}\nValore: $${Math.round(val/1000)}k\nDominanza: ${(dom*100).toFixed(0)}%\nDistanza: +${dist.toFixed(2)}%`);
        }
    });

    return walls;
}

// ==========================================
// FUNZIONI DI SENTIMENT (invariate)
// ==========================================
function getRelativePosition(current, history) {
    const values = history.map(v => parseFloat(v)).filter(v => !isNaN(v));
    if (values.length < 2) return 50;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return max === min ? 50 : ((current - min) / (max - min)) * 100;
}

async function fetchSentimentData(symbol, tickerMap) {
    try {
        const [byRes, bHRes, bTRes] = await Promise.all([
            axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK } }),
            axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: LOOKBACK } }),
            axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: LOOKBACK } })
        ]);

        const hList = bHRes.data, tList = bTRes.data;
        const hCur = hList[hList.length-1].longAccount;
        const tCur = tList[tList.length-1].longAccount;
        
        return {
            symbol,
            hPos: getRelativePosition(hCur, hList.map(x => x.longAccount)),
            tPos: getRelativePosition(tCur, tList.map(x => x.longAccount)),
            hVal: (hCur * 100).toFixed(1),
            tVal: (tCur * 100).toFixed(1),
            bybitVal: (parseFloat(byRes.data.result.list.pop().buyRatio) * 100),
            price: tickerMap.get(symbol).lastPrice,
            funding: (parseFloat(tickerMap.get(symbol).fundingRate || 0) * 100).toFixed(4)
        };
    } catch { return null; }
}

// ==========================================
// CORE LOGIC
// ==========================================
async function runScan() {
    if (isScanning) return;
    isScanning = true;
    console.log(`\n--- Scan Iniziato: ${new Date().toLocaleTimeString()} ---`);

    try {
        const tRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers?category=linear`);
        const tickerMap = new Map(tRes.data.result.list.map(t => [t.symbol, t]));
        
        const candidates = PAIRS.filter(s => 
            tickerMap.has(s) && 
            parseFloat(tickerMap.get(s).turnover24h) >= MIN_VOL_24H_USDT && 
            BINANCE_SYMBOLS.has(s)
        );

        for (let i = 0; i < candidates.length; i += CONCURRENCY_LIMIT) {
            const batch = candidates.slice(i, i + CONCURRENCY_LIMIT);
            
            await Promise.all(batch.map(async (symbol) => {
                const price = parseFloat(tickerMap.get(symbol).lastPrice);

                // 1. SENTIMENT
                const s = await fetchSentimentData(symbol, tickerMap);
                if (s) {
                    let type = "";
                    if (s.hPos >= SOGLIA_ALTA_BIN && s.tPos <= SOGLIA_BASSA_BIN && s.bybitVal >= SOGLIA_BYBIT_LONG) 
                        type = "🚀 LONG SQUEEZE";
                    else if (s.hPos <= SOGLIA_BASSA_BIN && s.tPos >= SOGLIA_ALTA_BIN && s.bybitVal <= SOGLIA_BYBIT_SHORT) 
                        type = "📉 SHORT SQUEEZE";

                    if (type) {
                        const fEmoji = parseFloat(s.funding) > 0 ? "🔴" : "🟢";
                        const msg = `<b>${type} #${symbol}</b>\nPrice: ${s.price}\nRetail: ${s.hVal}% (Pos: ${s.hPos.toFixed(0)}%)\nWhales: ${s.tVal}% (Pos: ${s.tPos.toFixed(0)}%)\nBybit: ${s.bybitVal.toFixed(1)}%\nFunding: ${s.funding}% ${fEmoji}`;
                        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                            chat_id: TELEGRAM_CHAT_ID, 
                            text: msg, 
                            parse_mode: "HTML"
                        }).catch(() => {});
                    }
                }

                // 2. MURI SPOT (ora con raggruppamento!)
                for (const ex of ['binance', 'bybit']) {
                    try {
                        const url = ex === 'binance' 
                            ? `${SPOT_BINANCE}/api/v3/depth?symbol=${symbol}&limit=100` 
                            : `${BASE_BYBIT}/v5/market/orderbook?category=spot&symbol=${symbol}&limit=100`;
                        
                        const res = await axios.get(url);
                        const book = ex === 'binance' ? res.data : res.data.result;
                        
                        const walls = findSpotWalls(symbol, book.bids, book.asks, price);
                        
                        if (walls.length > 0) {
                            const wallMsg = `<b>🐳 WHALE WALL #${symbol} (${ex.toUpperCase()})</b>\n\n${walls.join('\n\n')}`;
                            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                                chat_id: TELEGRAM_CHAT_ID, 
                                text: wallMsg, 
                                parse_mode: 'HTML'
                            }).catch(() => {});
                        }
                    } catch (e) {}
                    await sleep(400);
                }
            }));

            await sleep(REQUEST_DELAY);
        }
    } catch (e) {
        console.error("Errore loop:", e.message);
    }

    isScanning = false;
    console.log("--- Scan Completato ---");
}

// ==========================================
// INIZIALIZZAZIONE
// ==========================================
async function init() {
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/instruments-info?category=linear`);
        PAIRS = res.data.result.list
            .filter(p => p.quoteCoin === "USDT")
            .map(p => p.symbol);
        
        const bInfo = await axios.get(`${BASE_BINANCE}/fapi/v1/exchangeInfo`);
        BINANCE_SYMBOLS = new Set(
            bInfo.data.symbols
                .filter(s => s.quoteAsset === 'USDT')
                .map(s => s.symbol)
        );

        console.log(`✅ Caricate ${PAIRS.length} coppie`);
        runScan();
        setInterval(runScan, SCAN_INTERVAL);
    } catch (e) {
        console.error("Init fallito:", e.message);
    }
}

init();
