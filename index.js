const axios = require('axios');

// ==========================================
// CONFIGURAZIONE
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SOGLIA_ALTA_BIN    = 95;
const SOGLIA_BASSA_BIN   = 5;
const SOGLIA_BYBIT_LONG  = 85;
const SOGLIA_BYBIT_SHORT = 15;

const LOOKBACK           = 48;
const MIN_VOL_24H_USDT   = 2000000;
const SCAN_INTERVAL      = 1000 * 60 * 30; // 30 min
const REQUEST_DELAY      = 850;
const CONCURRENCY_LIMIT  = 4;

const WALL_DISTANCE_PCT        = 2.0;
const WALL_DOMINANCE_THRESHOLD = 0.5;
const WALL_MIN_VALUE_USD       = 50000;

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";
const SPOT_BINANCE = "https://api.binance.com";

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
    const min = Math.min(...values);
    const max = Math.max(...values);
    return max === min ? 50 : ((current - min) / (max - min)) * 100;
}

// ==========================================
// RICERCA MURI SPOT
// ==========================================
function findWallsSpot(bids, asks, currentPrice) {
    if (!bids || !asks || bids.length < 10 || !currentPrice) return [];

    const totalBidQty = bids.reduce((sum, x) => sum + parseFloat(x[1]), 0);
    const totalAskQty = asks.reduce((sum, x) => sum + parseFloat(x[1]), 0);
    const walls = [];

    bids.slice(0, 50).forEach(b => {
        const p = parseFloat(b[0]), q = parseFloat(b[1]), val = p * q;
        const d = ((currentPrice - p) / currentPrice) * 100;
        if (val >= WALL_MIN_VALUE_USD && d <= WALL_DISTANCE_PCT && q / totalBidQty >= WALL_DOMINANCE_THRESHOLD) {
            walls.push(`🟢 BUY WALL @ ${p.toFixed(4)} ($${Math.round(val/1000)}k) - ${(q/totalBidQty*100).toFixed(0)}% del book`);
        }
    });

    asks.slice(0, 50).forEach(a => {
        const p = parseFloat(a[0]), q = parseFloat(a[1]), val = p * q;
        const d = ((p - currentPrice) / currentPrice) * 100;
        if (val >= WALL_MIN_VALUE_USD && d <= WALL_DISTANCE_PCT && q / totalAskQty >= WALL_DOMINANCE_THRESHOLD) {
            walls.push(`🔴 SELL WALL @ ${p.toFixed(4)} ($${Math.round(val/1000)}k) - ${(q/totalAskQty*100).toFixed(0)}% del book`);
        }
    });

    return walls;
}

// ==========================================
// CARICAMENTO SIMBOLI BINANCE PERPETUAL
// ==========================================
async function loadBinanceSymbols() {
    try {
        const info = await axios.get(`${BASE_BINANCE}/fapi/v1/exchangeInfo`, { timeout: 15000 });
        BINANCE_SYMBOLS = new Set(
            info.data.symbols
                .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
                .map(s => s.symbol)
        );
        console.log(`Binance perpetual USDT aggiornati: ${BINANCE_SYMBOLS.size}`);
    } catch (err) {
        console.warn("Errore refresh cache Binance:", err.message);
    }
}

// ==========================================
// FETCH SENTIMENT PERPETUAL
// ==========================================
async function fetchSentimentData(symbol, tickerMap) {
    try {
        const [bybitRes, binHolderRes, binTopRes] = await Promise.all([
            axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK }, timeout: 12000 }),
            axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: LOOKBACK }, timeout: 12000 }),
            axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: LOOKBACK }, timeout: 12000 })
        ]);

        const bybitList = bybitRes.data?.result?.list || [];
        const binHolder = binHolderRes.data || [];
        const binTop    = binTopRes.data || [];
        if (bybitList.length < 5 || binHolder.length < 5 || binTop.length < 5) return null;

        const latestBybit = bybitList[bybitList.length-1];
        const bybitVal = parseFloat(latestBybit.buyRatio || 0) * 100;

        const binHolderLongs = binHolder.map(x => parseFloat(x.longAccount || 0));
        const binTopLongs = binTop.map(x => parseFloat(x.longAccount || 0));

        const currentBinHolder = binHolderLongs[binHolderLongs.length-1] || 0;
        const currentBinTop    = binTopLongs[binTopLongs.length-1] || 0;

        const binHolderPos = getRelativePosition(currentBinHolder, binHolderLongs);
        const binTopPos    = getRelativePosition(currentBinTop, binTopLongs);

        const ticker = tickerMap.get(symbol);
        const funding = ticker ? (parseFloat(ticker.fundingRate || 0) * 100).toFixed(4) : '0.0000';
        const price   = ticker ? parseFloat(ticker.lastPrice || 0) : 0;

        return { symbol, binHolderPos, binTopPos, binHolderVal: (currentBinHolder*100).toFixed(1), binTopVal: (currentBinTop*100).toFixed(1), bybitVal, funding, price };
    } catch (err) {
        return null;
    }
}

// ==========================================
// SCANNER PRINCIPALE
// ==========================================
async function scan() {
    if (isScanning) return;
    isScanning = true;
    const start = Date.now();

    try {
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' }, timeout: 20000 });
        const tickerMap = new Map(tickersRes.data.result.list.map(t => [t.symbol, t]));

        const candidates = PAIRS.filter(s => {
            const t = tickerMap.get(s);
            return t && parseFloat(t.turnover24h || 0) >= MIN_VOL_24H_USDT && (BINANCE_SYMBOLS.size === 0 || BINANCE_SYMBOLS.has(s));
        });

        console.log(`Scan → ${candidates.length} coppie qualificate`);

        for (let i = 0; i < candidates.length; i += CONCURRENCY_LIMIT) {
            const batch = candidates.slice(i, i + CONCURRENCY_LIMIT);
            const results = await Promise.all(batch.map(s => fetchSentimentData(s, tickerMap)));

            for (const res of results) {
                if (!res) continue;
                let title="", emoji="", subtitle="";
                const byVal = parseFloat(res.bybitVal);
                const bhPos = res.binHolderPos;
                const btPos = res.binTopPos;

                // DIVERGENZE LONG/SHORT
                if (bhPos >= SOGLIA_ALTA_BIN && btPos <= SOGLIA_BASSA_BIN && byVal >= SOGLIA_BYBIT_LONG) {
                    title = "LONG – SQUEEZE DIVERGENZA"; emoji="🚀⚡"; subtitle="Whales SHORT vs Retail LONG estremi";
                } else if (bhPos <= SOGLIA_BASSA_BIN && btPos >= SOGLIA_ALTA_BIN && byVal <= SOGLIA_BYBIT_SHORT) {
                    title = "SHORT – SQUEEZE DIVERGENZA"; emoji="📉⚠️"; subtitle="Whales LONG vs Retail SHORT estremi";
                }

                if (title) {
                    const fundingSign = parseFloat(res.funding) > 0 ? '🔴 longs pagano' : '🟢 shorts pagano';
                    const msg = `<b>${emoji} ${title}</b>\n#${res.symbol} @ ${res.price.toFixed(4)}\n${subtitle}\nBin Retail: <b>${res.binHolderVal}%</b> (Pos ${bhPos.toFixed(0)}%)\nBin Top: <b>${res.binTopVal}%</b> (Pos ${btPos.toFixed(0)}%)\nBybit Retail: <b>${res.bybitVal.toFixed(1)}%</b>\nFunding: <b>${res.funding}%</b> ${fundingSign}`;

                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID,
                        text: msg,
                        parse_mode: "HTML"
                    }).catch(()=>{});
                }

                // ==============================
                // RICERCA MURI SPOT
                // ==============================
                for (const ex of ['binance','bybit']) {
                    try {
                        const url = ex==='binance'
                            ? `${SPOT_BINANCE}/api/v3/depth?symbol=${res.symbol}&limit=100`
                            : `${BASE_BYBIT}/v5/market/orderbook?category=spot&symbol=${res.symbol}&limit=100`;

                        const obRes = await axios.get(url, { timeout: 15000 });
                        const book = ex==='binance' ? obRes.data : obRes.data.result;

                        const walls = findWallsSpot(book.bids, book.asks, res.price);
                        if (walls.length > 0) {
                            const wallMsg = `<b>🐳 WHALE WALL #${res.symbol} (${ex.toUpperCase()})</b>\n${walls.join('\n')}`;
                            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                                chat_id: TELEGRAM_CHAT_ID,
                                text: wallMsg,
                                parse_mode: 'HTML'
                            }).catch(()=>{});
                        }
                    } catch(err){ console.warn(`Errore spot ${res.symbol} ${ex}:`, err.message); }
                    await sleep(REQUEST_DELAY);
                }
            }
            await sleep(600);
        }

        console.log(`Scan completato (${((Date.now()-start)/1000).toFixed(1)}s)`);
    } catch (err) {
        console.error("Errore scan:", err.message);
    } finally { isScanning = false; }
}

// ==========================================
// INIZIALIZZAZIONE
// ==========================================
async function initialize() {
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/instruments-info`, { params:{category:'linear'}, timeout:20000 });
        PAIRS = res.data.result.list.filter(p => p.quoteCoin==='USDT' && p.status==='Trading').map(p => p.symbol);
        console.log(`Caricate ${PAIRS.length} coppie USDT Bybit`);

        await loadBinanceSymbols();
        setInterval(loadBinanceSymbols, 1000*60*60*12); // refresh ogni 12h

        await scan();
        setInterval(scan, SCAN_INTERVAL);
    } catch(err) {
        console.error("Inizializzazione fallita:", err.message);
    }
}

initialize();
