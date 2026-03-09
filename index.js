const axios = require('axios');

// ==========================================
// CONFIGURAZIONE
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

// Soglie Percentile (0-100) basate su Min-Max 30gg
const SOGLIA_ALTA = 92; 
const SOGLIA_BASSA = 8;

const LOOKBACK = 720; // 30 giorni (24h * 30)
const MIN_VOL_24H_USDT = 2000000;
const SCAN_INTERVAL = 1000 * 60 * 50; // 50 min

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";

let PAIRS = [];
let BINANCE_SYMBOLS = new Set();
let isScanning = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==========================================
// FUNZIONE CORE: MIN-MAX NORMALIZATION (0-100)
// ==========================================
function getRelativePosition(current, history) {
    const values = history.map(v => parseFloat(v)).filter(v => !isNaN(v));
    if (values.length < 24) return 50; 
    
    const min = Math.min(...values);
    const max = Math.max(...values);
    
    if (max === min) return 50;
    // Calcola la posizione attuale in 100 parti tra minimo e massimo
    return Math.max(0, Math.min(100, ((current - min) / (max - min)) * 100));
}

// ==========================================
// FETCH E ANALISI STORICA
// ==========================================
async function fetchSentimentData(symbol, tickerMap) {
    try {
        const [bybitRes, binGlobalRes, binTopRes] = await Promise.all([
            axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, {
                params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK },
                timeout: 10000
            }),
            axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, {
                params: { symbol, period: '1h', limit: 500 },
                timeout: 10000
            }),
            axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, {
                params: { symbol, period: '1h', limit: 500 },
                timeout: 10000
            })
        ]);

        const bybitList = bybitRes.data?.result?.list || [];
        const binGlobal = binGlobalRes.data || [];
        const binTop    = binTopRes.data || [];

        if (bybitList.length < 10 || binGlobal.length < 10) return null;

        // 1. BYBIT RETAIL: Min-Max 30gg
        const bybitHist = bybitList.map(x => parseFloat(x.buyRatio || 0));
        const bybitPos = getRelativePosition(bybitHist[bybitHist.length - 1], bybitHist);

        // 2. BINANCE RETAIL: Min-Max 30gg
        const binRetailHist = binGlobal.map(x => parseFloat(x.longAccount || 0));
        const binRetailPos = getRelativePosition(binRetailHist[binRetailHist.length - 1], binRetailHist);

        // 3. BINANCE WHALES: Min-Max 30gg
        const binWhaleHist = binTop.map(x => parseFloat(x.longAccount || 0));
        const binWhalePos = getRelativePosition(binWhaleHist[binWhaleHist.length - 1], binWhaleHist);

        const ticker = tickerMap.get(symbol);
        return {
            symbol,
            bybitPos, bybitVal: (bybitHist[bybitHist.length - 1] * 100).toFixed(1),
            binRetailPos, binRetailVal: (binRetailHist[binRetailHist.length - 1] * 100).toFixed(1),
            binWhalePos, binWhaleVal: (binWhaleHist[binWhaleHist.length - 1] * 100).toFixed(1),
            price: ticker ? parseFloat(ticker.lastPrice || 0) : 0,
            funding: ticker ? (parseFloat(ticker.fundingRate || 0) * 100).toFixed(4) : '0.0000'
        };
    } catch (err) { return null; }
}

// ==========================================
// SCANNER E LOGICA SEGNALI
// ==========================================
async function scan() {
    if (isScanning) return;
    isScanning = true;
    console.log(`\n--- AVVIO SCAN: ${new Date().toLocaleTimeString()} ---`);

    try {
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' } });
        const tickerMap = new Map(tickersRes.data.result.list.map(t => [t.symbol, t]));
        
        const candidates = PAIRS.filter(s => {
            const t = tickerMap.get(s);
            return t && parseFloat(t.turnover24h) >= MIN_VOL_24H_USDT && (BINANCE_SYMBOLS.size === 0 || BINANCE_SYMBOLS.has(s));
        });

        for (const symbol of candidates) {
            const data = await fetchSentimentData(symbol, tickerMap);
            if (!data) continue;

            let type = "", emoji = "", subtitle = "";

            // LOGICA TRIGGER: Basata esclusivamente sulle posizioni relative (0-100)
            if (data.binRetailPos >= SOGLIA_ALTA && data.binWhalePos <= SOGLIA_BASSA) {
                type = "LONG – SQUEEZE DIVERGENZA";
                emoji = "🚀⚡";
                subtitle = "Whales SHORT vs Retail LONG";
            } else if (data.binRetailPos <= SOGLIA_BASSA && data.binWhalePos >= SOGLIA_ALTA) {
                type = "SHORT – SQUEEZE DIVERGENZA";
                emoji = "📉⚠️";
                subtitle = "Whales LONG vs Retail SHORT";
            } else if (data.binRetailPos >= SOGLIA_ALTA && data.bybitPos >= SOGLIA_ALTA) {
                type = "LONG – OVERCROWDED";
                emoji = "🚀🔥";
                subtitle = "Sentiment unanime Long";
            } else if (data.binRetailPos <= SOGLIA_BASSA && data.bybitPos <= SOGLIA_BASSA) {
                type = "SHORT – OVERCROWDED";
                emoji = "📉❄️";
                subtitle = "Sentiment unanime Short";
            }

            if (type) {
                // Calcolo somiglianza tra i due exchange (Retail)
                const similarity = (100 - Math.abs(data.binRetailPos - data.bybitPos)).toFixed(0);
                
                const text = `
<b>${emoji} ${type}</b>
#${data.symbol} @ ${data.price}
${subtitle}

<b>CONFLUENZA EXCHANGE:</b> ${similarity}%
----------------------------------
<b>BINANCE:</b>
Retail: <b>${data.binRetailVal}%</b> (Pos: ${data.binRetailPos.toFixed(0)}%)
Whales: <b>${data.binWhaleVal}%</b> (Pos: ${data.binWhalePos.toFixed(0)}%)

<b>BYBIT:</b>
Retail: <b>${data.bybitVal}%</b> (Pos: ${data.bybitPos.toFixed(0)}%)

<b>FUNDING:</b> <b>${data.funding}%</b>
                `.trim();

                console.log(`[!] SEGNALE INVIATO: ${symbol}`);
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML"
                }).catch(() => {});
                await sleep(500);
            }
        }
    } catch (err) { console.error("Errore Scan:", err.message); }
    finally { isScanning = false; console.log("--- SCAN COMPLETATO ---"); }
}

// ==========================================
// INIZIALIZZAZIONE
// ==========================================
async function loadBinanceSymbols() {
    try {
        const binInfo = await axios.get(`${BASE_BINANCE}/fapi/v1/exchangeInfo`);
        BINANCE_SYMBOLS = new Set(binInfo.data.symbols.filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT').map(s => s.symbol));
    } catch (e) {}
}

async function initialize() {
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/instruments-info`, { params: { category: "linear" } });
        PAIRS = res.data.result.list.filter(p => p.quoteCoin === "USDT" && p.status === "Trading").map(p => p.symbol);
        
        await loadBinanceSymbols();
        setInterval(loadBinanceSymbols, 1000 * 60 * 60 * 12);
        
        scan();
        setInterval(scan, SCAN_INTERVAL);
    } catch (e) { console.error("Inizializzazione fallita"); }
}

initialize();
