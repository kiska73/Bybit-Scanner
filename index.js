const axios = require('axios');

// ==========================================
// CONFIGURAZIONE
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

// SOGLIE SENTIMENT
const SOGLIA_ALTA_BIN    = 90;
const SOGLIA_BASSA_BIN   = 10;
const SOGLIA_BYBIT_LONG  = 80;
const SOGLIA_BYBIT_SHORT = 20;

// SOGLIE MURI (FILTRI ANTI-PANICO)
const MIN_WALL_VALUE_USDT = 200000; // Solo muri sopra i 200k $
const WALL_DISTANCE_PCT   = 2.0;    // Solo muri entro il 2% dal prezzo
const WALL_MULTIPLIER     = 20;     // Deve essere 20x rispetto alla media

const LOOKBACK           = 48;
const MIN_VOL_24H_USDT   = 5000000; // Alzato a 5M per filtrare solo coin liquide
const SCAN_INTERVAL      = 1000 * 60 * 30; 
const REQUEST_DELAY      = 800;     // Più lento per sicurezza 418

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";
const SPOT_BINANCE = "https://api.binance.com";

let PAIRS = [];
let BINANCE_SYMBOLS = new Set();
let isScanning = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==========================================
// LOGICA FILTRO MURI
// ==========================================
function findWalls(bids, asks, currentPrice) {
    if (!bids || !asks || !currentPrice) return [];
    
    const avgBid = bids.slice(0, 50).reduce((a, b) => a + parseFloat(b[1]), 0) / 50;
    const avgAsk = asks.slice(0, 50).reduce((a, b) => a + parseFloat(a[1]), 0) / 50;
    
    const walls = [];

    // BIDS (Supporti)
    bids.slice(0, 40).forEach(b => {
        const price = parseFloat(b[0]);
        const size = parseFloat(b[1]);
        const valueUSDT = price * size;
        const dist = ((currentPrice - price) / currentPrice) * 100;

        if (valueUSDT > MIN_WALL_VALUE_USDT && dist <= WALL_DISTANCE_PCT && size > avgAsk * WALL_MULTIPLIER) {
            walls.push({ side: '🟢 BIG BUY WALL', price, valueUSDT, dist: dist.toFixed(2) });
        }
    });

    // ASKS (Resistenze)
    asks.slice(0, 40).forEach(a => {
        const price = parseFloat(a[0]);
        const size = parseFloat(a[1]);
        const valueUSDT = price * size;
        const dist = ((price - currentPrice) / currentPrice) * 100;

        if (valueUSDT > MIN_WALL_VALUE_USDT && dist <= WALL_DISTANCE_PCT && size > avgBid * WALL_MULTIPLIER) {
            walls.push({ side: '🔴 BIG SELL WALL', price, valueUSDT, dist: dist.toFixed(2) });
        }
    });

    return walls;
}

// ... (Le altre funzioni Helper rimangono le stesse) ...
async function loadBinanceSymbols() {
    try {
        const binInfo = await axios.get(`${BASE_BINANCE}/fapi/v1/exchangeInfo`);
        BINANCE_SYMBOLS = new Set(binInfo.data.symbols.filter(s => s.quoteAsset === 'USDT').map(s => s.symbol));
    } catch (e) { console.error("Errore Cache Binance"); }
}

async function fetchBook(symbol, ex) {
    try {
        const url = ex === 'binance' ? `${SPOT_BINANCE}/api/v3/depth?symbol=${symbol}&limit=100` : `${BASE_BYBIT}/v5/market/orderbook?category=spot&symbol=${symbol}&limit=100`;
        const res = await axios.get(url);
        return ex === 'binance' ? res.data : res.data.result;
    } catch { return null; }
}

async function fetchSentimentData(symbol, tickerMap) {
    try {
        const [bybitRes, binHolderRes, binTopRes] = await Promise.all([
            axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK } }),
            axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: LOOKBACK } }),
            axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: LOOKBACK } })
        ]);
        const bybitVal = (parseFloat(bybitRes.data.result.list.pop().buyRatio) * 100).toFixed(1);
        const holder = binHolderRes.data;
        const top = binTopRes.data;
        const hPos = getRelativePosition(holder[holder.length-1].longAccount, holder.map(x=>x.longAccount));
        const tPos = getRelativePosition(top[top.length-1].longAccount, top.map(x=>x.longAccount));
        return { symbol, hPos, tPos, hVal: (holder[holder.length-1].longAccount*100).toFixed(1), tVal: (top[top.length-1].longAccount*100).toFixed(1), bybitVal, price: tickerMap.get(symbol).lastPrice };
    } catch { return null; }
}

function getRelativePosition(c, h) {
    const min = Math.min(...h); const max = Math.max(...h);
    return max === min ? 50 : ((c - min) / (max - min)) * 100;
}

// ==========================================
// LOOP PRINCIPALE
// ==========================================
async function runScanner() {
    if (isScanning) return;
    isScanning = true;
    
    try {
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers?category=linear`);
        const tickerMap = new Map(tickersRes.data.result.list.map(t => [t.symbol, t]));
        const candidates = PAIRS.filter(s => tickerMap.has(s) && parseFloat(tickerMap.get(s).turnover24h) >= MIN_VOL_24H_USDT && BINANCE_SYMBOLS.has(s));

        console.log(`Analisi su ${candidates.length} coppie...`);

        for (const symbol of candidates) {
            const ticker = tickerMap.get(symbol);
            const price = parseFloat(ticker.lastPrice);

            // 1. SENTIMENT
            const s = await fetchSentimentData(symbol, tickerMap);
            if (s && ((s.hPos >= SOGLIA_ALTA_BIN && s.tPos <= SOGLIA_BASSA_BIN) || (s.hPos <= SOGLIA_BASSA_BIN && s.tPos >= SOGLIA_ALTA_BIN))) {
                const msg = `<b>📊 SENTIMENT ALERT #${symbol}</b>\nPrice: ${s.price}\nRetail: ${s.hVal}% (Pos ${s.hPos.toFixed(0)}%)\nWhales: ${s.tVal}% (Pos ${s.tPos.toFixed(0)}%)`;
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' }).catch(()=>{});
            }

            // 2. MURI (Solo se la coin è "calda" o ha volumi)
            for (const ex of ['binance', 'bybit']) {
                const book = await fetchBook(symbol, ex);
                const walls = findWalls(book?.bids, book?.asks, price);
                if (walls.length > 0) {
                    const wallText = walls.map(w => `${w.side} @ ${w.price} ($${Math.round(w.valueUSDT/1000)}k) - Dist: ${w.dist}%`).join('\n');
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { 
                        chat_id: TELEGRAM_CHAT_ID, 
                        text: `<b>🐳 WHALE WALL #${symbol} (${ex.toUpperCase()})</b>\n${wallText}`, 
                        parse_mode: 'HTML' 
                    }).catch(()=>{});
                }
                await sleep(REQUEST_DELAY);
            }
        }
    } catch (e) { console.error("Errore Loop"); }
    isScanning = false;
}

async function init() {
    const res = await axios.get(`${BASE_BYBIT}/v5/market/instruments-info?category=linear`);
    PAIRS = res.data.result.list.filter(p => p.quoteCoin === "USDT").map(p => p.symbol);
    await loadBinanceSymbols();
    runScanner();
    setInterval(runScanner, SCAN_INTERVAL);
}

init();
