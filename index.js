const axios = require('axios');

// ==========================================
// CONFIGURAZIONE
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SOGLIA_ALTA_BIN    = 9;
const SOGLIA_BASSA_BIN   = 5;
const WALL_DISTANCE_PCT  = 2.0;    

// PERCENTUALE DI DOMINANZA: Il muro deve essere almeno il 35% di tutto il book visibile (100 livelli)
const WALL_DOMINANCE_THRESHOLD = 0.5; 

const LOOKBACK           = 48;
const MIN_VOL_24H_USDT   = 3000000; 
const SCAN_INTERVAL      = 1000 * 60 * 30; 
const REQUEST_DELAY      = 850;     

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";
const SPOT_BINANCE = "https://api.binance.com";

let PAIRS = [];
let BINANCE_SYMBOLS = new Set();
let isScanning = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==========================================
// FUNZIONI DI CALCOLO
// ==========================================
function getRelativePosition(current, history) {
    const values = history.map(v => parseFloat(v)).filter(v => !isNaN(v));
    if (values.length < 2) return 50;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return max === min ? 50 : ((current - min) / (max - min)) * 100;
}

function findWalls(symbol, bids, asks, currentPrice) {
    if (!bids || !asks || bids.length < 50 || !currentPrice) return [];

    // Calcoliamo il volume TOTALE visibile nel book (somma di tutte le quantità nei 100 livelli)
    const totalBidQty = bids.reduce((sum, x) => sum + parseFloat(x[1]), 0);
    const totalAskQty = asks.reduce((sum, x) => sum + parseFloat(x[1]), 0);
    
    const walls = [];
    
    // Analisi BIDS (Supporti)
    bids.slice(0, 50).forEach(b => {
        const p = parseFloat(b[0]), q = parseFloat(b[1]), val = p * q, d = ((currentPrice - p) / currentPrice) * 100;
        
        // Un muro è valido se: 
        // 1. È una parte significativa dell'INTERO book (Dominanza)
        // 2. È vicino al prezzo
        if ((q / totalBidQty) > WALL_DOMINANCE_THRESHOLD && d <= WALL_DISTANCE_PCT && val > 50000) {
            walls.push(`🟢 BUY WALL @ ${p} ($${Math.round(val/1000)}k) - ${Math.round((q/totalBidQty)*100)}% del book`);
        }
    });

    // Analisi ASKS (Resistenze)
    asks.slice(0, 50).forEach(a => {
        const p = parseFloat(a[0]), q = parseFloat(a[1]), val = p * q, d = ((p - currentPrice) / currentPrice) * 100;
        
        if ((q / totalAskQty) > WALL_DOMINANCE_THRESHOLD && d <= WALL_DISTANCE_PCT && val > 50000) {
            walls.push(`🔴 SELL WALL @ ${p} ($${Math.round(val/1000)}k) - ${Math.round((q/totalAskQty)*100)}% del book`);
        }
    });
    return walls;
}

// ==========================================
// LOGICA CORE
// ==========================================
async function runScanner() {
    if (isScanning) return;
    isScanning = true;
    console.log(`Scan: ${new Date().toLocaleTimeString()}`);

    try {
        const tRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers?category=linear`);
        const tickerMap = new Map(tRes.data.result.list.map(t => [t.symbol, t]));
        const candidates = PAIRS.filter(s => tickerMap.has(s) && parseFloat(tickerMap.get(s).turnover24h) >= MIN_VOL_24H_USDT && BINANCE_SYMBOLS.has(s));

        for (const symbol of candidates) {
            const ticker = tickerMap.get(symbol);
            const price = parseFloat(ticker.lastPrice);
            const funding = (parseFloat(ticker.fundingRate || 0) * 100).toFixed(4);
            const fEmoji = parseFloat(funding) > 0 ? "🔴" : "🟢";

            // 1. FETCH SENTIMENT (Mantiene il formato richiesto)
            try {
                const [byRes, bHRes, bTRes] = await Promise.all([
                    axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK } }),
                    axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: LOOKBACK } }),
                    axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: LOOKBACK } })
                ]);

                const byVal = (parseFloat(byRes.data.result.list.pop().buyRatio) * 100).toFixed(1);
                const hList = bHRes.data, tList = bTRes.data;
                const hCur = hList[hList.length-1].longAccount, tCur = tList[tList.length-1].longAccount;
                const hPos = getRelativePosition(hCur, hList.map(x=>x.longAccount));
                const tPos = getRelativePosition(tCur, tList.map(x=>x.longAccount));

                let type = "";
                if (hPos >= SOGLIA_ALTA_BIN && tPos <= SOGLIA_BASSA_BIN) type = "🚀 LONG SQUEEZE";
                else if (hPos <= SOGLIA_BASSA_BIN && tPos >= SOGLIA_ALTA_BIN) type = "📉 SHORT SQUEEZE";

                if (type) {
                    const msg = `<b>${type} #${symbol}</b>\nPrice: ${price}\nRetail: ${(hCur*100).toFixed(1)}% (Pos: ${hPos.toFixed(0)}%)\nWhales: ${(tCur*100).toFixed(1)}% (Pos: ${tPos.toFixed(0)}%)\nBybit: ${byVal}%\nFunding: ${funding}% ${fEmoji}`;
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "HTML" }).catch(()=>{});
                }
            } catch (e) {}

            // 2. FETCH MURI (Con soglia di dominanza)
            for (const ex of ['binance', 'bybit']) {
                try {
                    const url = ex === 'binance' ? `${SPOT_BINANCE}/api/v3/depth?symbol=${symbol}&limit=100` : `${BASE_BYBIT}/v5/market/orderbook?category=spot&symbol=${symbol}&limit=100`;
                    const res = await axios.get(url);
                    const book = ex === 'binance' ? res.data : res.data.result;
                    const walls = findWalls(symbol, book.bids, book.asks, price);
                    
                    if (walls.length > 0) {
                        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { 
                            chat_id: TELEGRAM_CHAT_ID, 
                            text: `<b>🐳 WHALE WALL #${symbol} (${ex.toUpperCase()})</b>\n${walls.join('\n')}`, 
                            parse_mode: 'HTML' 
                        }).catch(()=>{});
                    }
                } catch (e) {}
                await sleep(REQUEST_DELAY);
            }
        }
    } catch (e) { console.error("Errore loop"); }
    isScanning = false;
}

async function init() {
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/instruments-info?category=linear`);
        PAIRS = res.data.result.list.filter(p => p.quoteCoin === "USDT" && p.status === "Trading").map(p => p.symbol);
        const bInfo = await axios.get(`${BASE_BINANCE}/fapi/v1/exchangeInfo`);
        BINANCE_SYMBOLS = new Set(bInfo.data.symbols.filter(s => s.quoteAsset === 'USDT').map(s => s.symbol));
        runScanner();
        setInterval(runScanner, SCAN_INTERVAL);
    } catch (e) {}
}

init();
