const axios = require('axios');

// ==========================================
// CONFIGURAZIONE
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SOGLIA_ALTA_BIN    = 90;
const SOGLIA_BASSA_BIN   = 10;
const SOGLIA_BYBIT_LONG  = 80;
const SOGLIA_BYBIT_SHORT = 20;

const LOOKBACK           = 48;
const MIN_VOL_24H_USDT   = 2000000;
const SCAN_INTERVAL      = 1000 * 60 * 30; // Ogni 30 min (Loop principale)
const REQUEST_DELAY      = 600;            // Ritardo tra richieste per evitare ban 418

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com"; // Per sentiment (Futures)
const SPOT_BINANCE = "https://api.binance.com";  // Per muri (Spot)

let PAIRS = [];
let BINANCE_SYMBOLS = new Set();
let isScanning = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==========================================
// FUNZIONI HELPER
// ==========================================
function getRelativePosition(current, history) {
    const values = history.map(v => parseFloat(v)).filter(v => !isNaN(v));
    if (values.length < 2) return 50;
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (max === min) return 50;
    return Math.max(0, Math.min(100, ((current - min) / (max - min)) * 100));
}

// ==========================================
// CARICAMENTO SIMBOLI BINANCE
// ==========================================
async function loadBinanceSymbols() {
    try {
        const binInfo = await axios.get(`${BASE_BINANCE}/fapi/v1/exchangeInfo`, { timeout: 15000 });
        BINANCE_SYMBOLS = new Set(
            binInfo.data.symbols
                .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
                .map(s => s.symbol)
        );
        console.log(`Cache Binance: ${BINANCE_SYMBOLS.size} perpetual USDT`);
    } catch (err) {
        console.error("Errore refresh cache Binance (418?):", err.message);
    }
}

// ==========================================
// LOGICA SENTIMENT (PERPETUAL)
// ==========================================
async function fetchSentimentData(symbol, tickerMap) {
    try {
        const [bybitRes, binHolderRes, binTopRes] = await Promise.all([
            axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, {
                params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK },
                timeout: 10000
            }),
            axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, {
                params: { symbol, period: '1h', limit: LOOKBACK },
                timeout: 10000
            }),
            axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, {
                params: { symbol, period: '1h', limit: LOOKBACK },
                timeout: 10000
            })
        ]);

        const bybitList = bybitRes.data?.result?.list || [];
        const binHolder = binHolderRes.data || [];
        const binTop    = binTopRes.data || [];

        if (bybitList.length < 5 || binHolder.length < 5 || binTop.length < 5) return null;

        const latestBybit = bybitList[bybitList.length - 1];
        const bybitLongPct = (parseFloat(latestBybit.buyRatio || 0) * 100).toFixed(1);

        const binHolderLongs = binHolder.map(x => parseFloat(x.longAccount || 0));
        const binTopLongs    = binTop.map(x => parseFloat(x.longAccount || 0));

        const currentBinHolder = binHolderLongs[binHolderLongs.length - 1];
        const currentBinTop    = binTopLongs[binTopLongs.length - 1];

        const binHolderPos = getRelativePosition(currentBinHolder, binHolderLongs);
        const binTopPos    = getRelativePosition(currentBinTop, binTopLongs);

        const ticker = tickerMap.get(symbol);
        const fundingVal = ticker ? (parseFloat(ticker.fundingRate || 0) * 100).toFixed(4) : '0.0000';

        // Score calcolato per priorità alert
        const score = Math.abs(parseFloat(bybitLongPct) - (currentBinTop * 100)) + Math.abs(binHolderPos - binTopPos);

        return {
            symbol, binHolderPos, binTopPos,
            binHolderVal: (currentBinHolder * 100).toFixed(1),
            binTopVal: (currentBinTop * 100).toFixed(1),
            bybitVal: bybitLongPct,
            funding: fundingVal,
            price: ticker ? parseFloat(ticker.lastPrice || 0) : 0,
            score
        };
    } catch (err) { return null; }
}

// ==========================================
// LOGICA MURI (SPOT)
// ==========================================
async function fetchBook(symbol, exchange) {
    try {
        const url = exchange === 'binance' 
            ? `${SPOT_BINANCE}/api/v3/depth?symbol=${symbol}&limit=50`
            : `${BASE_BYBIT}/v5/market/orderbook?category=spot&symbol=${symbol}&limit=50`;
        
        const res = await axios.get(url, { timeout: 8000 });
        const data = exchange === 'binance' ? res.data : res.data.result;
        return { bids: data.bids, asks: data.asks };
    } catch { return null; }
}

function findWalls(bids, asks) {
    if (!bids || !asks || bids.length === 0 || asks.length === 0) return [];
    const avgBid = bids.reduce((a, b) => a + parseFloat(b[1]), 0) / bids.length;
    const avgAsk = asks.reduce((a, b) => a + parseFloat(b[1]), 0) / asks.length;
    
    const walls = [];
    // Un muro è definito se la size è > 10 volte la media dell'altro lato (pressione)
    bids.slice(0, 20).forEach(b => { if (parseFloat(b[1]) > avgAsk * 12) walls.push({ side: 'BUY WALL', price: b[0], size: b[1] }); });
    asks.slice(0, 20).forEach(a => { if (parseFloat(a[1]) > avgBid * 12) walls.push({ side: 'SELL WALL', price: a[0], size: a[1] }); });
    return walls;
}

// ==========================================
// LOOP PRINCIPALE (SEQUENZIALE)
// ==========================================
async function runScanner() {
    if (isScanning) return;
    isScanning = true;
    console.log(`--- Inizio Scan: ${new Date().toLocaleTimeString()} ---`);

    try {
        // 1. Prendi Ticker Bybit per filtrare Volume
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers?category=linear`);
        const tickerMap = new Map(tickersRes.data.result.list.map(t => [t.symbol, t]));

        const candidates = PAIRS.filter(s => {
            const t = tickerMap.get(s);
            return t && parseFloat(t.turnover24h) >= MIN_VOL_24H_USDT && BINANCE_SYMBOLS.has(s);
        });

        console.log(`Coppie filtrate per volume: ${candidates.length}`);

        // 2. ANALISI SENTIMENT
        let signals = [];
        for (const symbol of candidates) {
            const data = await fetchSentimentData(symbol, tickerMap);
            if (data) {
                let type = "";
                if (data.binHolderPos >= SOGLIA_ALTA_BIN && data.binTopPos <= SOGLIA_BASSA_BIN) type = "🚀 LONG SQUEEZE";
                else if (data.binHolderPos <= SOGLIA_BASSA_BIN && data.binTopPos >= SOGLIA_ALTA_BIN) type = "📉 SHORT SQUEEZE";

                if (type) {
                    signals.push(`<b>${type} #${symbol}</b>\nPrice: ${data.price}\nRetail: ${data.binHolderVal}% (Pos: ${data.binHolderPos.toFixed(0)}%)\nWhales: ${data.binTopVal}% (Pos: ${data.binTopPos.toFixed(0)}%)\nBybit: ${data.bybitVal}%\nFunding: ${data.funding}%`);
                }
            }
            await sleep(REQUEST_DELAY); // Evita ban 418
        }

        if (signals.length > 0) {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID, text: `<b>📊 SENTIMENT ALERT</b>\n\n${signals.join('\n\n')}`, parse_mode: 'HTML'
            }).catch(() => {});
        }

        // 3. ANALISI MURI (Solo su coppie con volume)
        console.log("Inizio scansione muri...");
        for (const symbol of candidates.slice(0, 50)) { // Limitiamo ai top 50 per volume per non metterci ore
            for (const ex of ['binance', 'bybit']) {
                const book = await fetchBook(symbol, ex);
                const walls = findWalls(book?.bids, book?.asks);
                
                if (walls.length > 0) {
                    const wallMsg = walls.map(w => `<b>${w.side}</b> @ ${w.price} (Size: ${parseFloat(w.size).toFixed(1)})`).join('\n');
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: `<b>🚧 WALL ALERT #${symbol} (${ex.toUpperCase()})</b>\n${wallMsg}`,
                        parse_mode: 'HTML'
                    }).catch(() => {});
                }
                await sleep(REQUEST_DELAY);
            }
        }

    } catch (err) {
        console.error("Errore nel loop:", err.message);
    } finally {
        isScanning = false;
        console.log("--- Scan Completato ---");
    }
}

// ==========================================
// INIZIALIZZAZIONE
// ==========================================
async function init() {
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/instruments-info?category=linear`);
        PAIRS = res.data.result.list
            .filter(p => p.quoteCoin === "USDT" && p.status === "Trading")
            .map(p => p.symbol);
        
        await loadBinanceSymbols();
        
        // Avvio cicli
        runScanner(); 
        setInterval(runScanner, SCAN_INTERVAL);
        setInterval(loadBinanceSymbols, 1000 * 60 * 60 * 12); // Refresh simboli ogni 12h
    } catch (err) {
        console.error("Init fallito:", err.message);
    }
}

init();
