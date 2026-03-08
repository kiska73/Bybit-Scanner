const axios = require('axios');

// ==========================================
// CONFIGURAZIONE
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

// SOGLIE SENTIMENT (Divergenze Retail vs Whales)
const SOGLIA_ALTA_BIN    = 90;
const SOGLIA_BASSA_BIN   = 10;

// SOGLIE MURI (Solo Balene Vere)
const MIN_WALL_VALUE_USDT = 200000; // Solo muri sopra i 200.000$
const WALL_DISTANCE_PCT   = 2.0;    // Solo muri entro il 2% dal prezzo attuale
const WALL_MULTIPLIER     = 20;     // Deve essere 20 volte la media del lato opposto

const LOOKBACK           = 48;
const MIN_VOL_24H_USDT   = 5000000; // Solo coin con almeno 5M di volume
const SCAN_INTERVAL      = 1000 * 60 * 30; // Loop ogni 30 minuti
const REQUEST_DELAY      = 800;     // Ritardo tra richieste per evitare ban 418

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com"; // Per sentiment
const SPOT_BINANCE = "https://api.binance.com";  // Per muri spot

let PAIRS = [];
let BINANCE_SYMBOLS = new Set();
let isScanning = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==========================================
// FUNZIONI DI CALCOLO E FILTRO
// ==========================================

function getRelativePosition(current, history) {
    const values = history.map(v => parseFloat(v)).filter(v => !isNaN(v));
    if (values.length < 2) return 50;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return max === min ? 50 : ((current - min) / (max - min)) * 100;
}

/**
 * Trova i muri (Wall) analizzando profondità del book e medie contrapposte
 */
function findWalls(bids, asks, currentPrice) {
    if (!bids || !asks || bids.length < 50 || asks.length < 50 || !currentPrice) return [];
    
    // FIX: Calcolo corretto della media (sum è l'accumulatore, x è l'elemento [prezzo, quantità])
    const avgBid = bids.slice(0, 50).reduce((sum, x) => sum + parseFloat(x[1]), 0) / 50;
    const avgAsk = asks.slice(0, 50).reduce((sum, x) => sum + parseFloat(x[1]), 0) / 50;
    
    const walls = [];

    // Analisi BIDS (Supporti)
    bids.slice(0, 40).forEach(b => {
        const price = parseFloat(b[0]);
        const qty = parseFloat(b[1]);
        const valueUSDT = price * qty;
        const dist = ((currentPrice - price) / currentPrice) * 100;

        if (valueUSDT > MIN_WALL_VALUE_USDT && dist <= WALL_DISTANCE_PCT && qty > avgAsk * WALL_MULTIPLIER) {
            walls.push({ side: '🟢 BIG BUY WALL', price, valueUSDT, dist: dist.toFixed(2) });
        }
    });

    // Analisi ASKS (Resistenze)
    asks.slice(0, 40).forEach(a => {
        const price = parseFloat(a[0]);
        const qty = parseFloat(a[1]);
        const valueUSDT = price * qty;
        const dist = ((price - currentPrice) / currentPrice) * 100;

        if (valueUSDT > MIN_WALL_VALUE_USDT && dist <= WALL_DISTANCE_PCT && qty > avgBid * WALL_MULTIPLIER) {
            walls.push({ side: '🔴 BIG SELL WALL', price, valueUSDT, dist: dist.toFixed(2) });
        }
    });

    return walls;
}

// ==========================================
// CHIAMATE API
// ==========================================

async function loadBinanceSymbols() {
    try {
        const res = await axios.get(`${BASE_BINANCE}/fapi/v1/exchangeInfo`);
        BINANCE_SYMBOLS = new Set(res.data.symbols.filter(s => s.quoteAsset === 'USDT').map(s => s.symbol));
        console.log(`Cache Binance aggiornata: ${BINANCE_SYMBOLS.size} simboli.`);
    } catch (e) { console.error("Errore caricamento simboli Binance."); }
}

async function fetchBook(symbol, exchange) {
    try {
        const url = exchange === 'binance' 
            ? `${SPOT_BINANCE}/api/v3/depth?symbol=${symbol}&limit=100`
            : `${BASE_BYBIT}/v5/market/orderbook?category=spot&symbol=${symbol}&limit=100`;
        const res = await axios.get(url, { timeout: 8000 });
        return exchange === 'binance' ? res.data : res.data.result;
    } catch { return null; }
}

async function fetchSentimentData(symbol, tickerMap) {
    try {
        const [bybitRes, binHolderRes, binTopRes] = await Promise.all([
            axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK } }),
            axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: LOOKBACK } }),
            axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: LOOKBACK } })
        ]);

        const holder = binHolderRes.data;
        const top = binTopRes.data;
        const currentHolder = holder[holder.length - 1].longAccount;
        const currentTop = top[top.length - 1].longAccount;

        return {
            symbol,
            hPos: getRelativePosition(currentHolder, holder.map(x => x.longAccount)),
            tPos: getRelativePosition(currentTop, top.map(x => x.longAccount)),
            hVal: (currentHolder * 100).toFixed(1),
            tVal: (currentTop * 100).toFixed(1),
            price: tickerMap.get(symbol).lastPrice
        };
    } catch { return null; }
}

// ==========================================
// LOOP LOGIC
// ==========================================

async function runScanner() {
    if (isScanning) return;
    isScanning = true;
    console.log(`\n🚀 SCAN AVVIATO: ${new Date().toLocaleTimeString()}`);

    try {
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers?category=linear`);
        const tickerMap = new Map(tickersRes.data.result.list.map(t => [t.symbol, t]));

        const candidates = PAIRS.filter(s => 
            tickerMap.has(s) && 
            parseFloat(tickerMap.get(s).turnover24h) >= MIN_VOL_24H_USDT && 
            BINANCE_SYMBOLS.has(s)
        );

        for (const symbol of candidates) {
            const ticker = tickerMap.get(symbol);
            const price = parseFloat(ticker.lastPrice);

            // 1. CONTROLLO SENTIMENT
            const s = await fetchSentimentData(symbol, tickerMap);
            if (s) {
                let alertMsg = "";
                if (s.hPos >= SOGLIA_ALTA_BIN && s.tPos <= SOGLIA_BASSA_BIN) alertMsg = "🚀 LONG SQUEEZE POTENTIAL";
                else if (s.hPos <= SOGLIA_BASSA_BIN && s.tPos >= SOGLIA_ALTA_BIN) alertMsg = "📉 SHORT SQUEEZE POTENTIAL";

                if (alertMsg) {
                    const msg = `<b>${alertMsg} #${symbol}</b>\nPrice: ${s.price}\nRetail Pos: ${s.hPos.toFixed(0)}% (${s.hVal}%)\nWhales Pos: ${s.tPos.toFixed(0)}% (${s.tVal}%)`;
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' }).catch(()=>{});
                }
            }

            // 2. CONTROLLO MURI (Whales)
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
                await sleep(REQUEST_DELAY); // Rispetto dei limiti API
            }
        }
    } catch (e) {
        console.error("Errore generico nel loop:", e.message);
    } finally {
        isScanning = false;
        console.log(`✅ SCAN COMPLETATO`);
    }
}

// ==========================================
// AVVIO
// ==========================================

async function init() {
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/instruments-info?category=linear`);
        PAIRS = res.data.result.list.filter(p => p.quoteCoin === "USDT" && p.status === "Trading").map(p => p.symbol);
        
        await loadBinanceSymbols();
        
        // Primo avvio e poi timer
        runScanner();
        setInterval(runScanner, SCAN_INTERVAL);
        setInterval(loadBinanceSymbols, 1000 * 60 * 60 * 12); // Aggiorna simboli ogni 12 ore
    } catch (err) {
        console.error("Inizializzazione fallita:", err.message);
    }
}

init();
