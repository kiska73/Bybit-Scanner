const axios = require('axios');

// ==========================================
// CONFIGURAZIONE
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

// Soglie per la Posizione Relativa (0-100%) basata sullo storico 30gg
const SOGLIA_ALTA_POS = 85; 
const SOGLIA_BASSA_POS = 15;

// Soglie per i Valori Assoluti (quelli che chiedevi >80% o <20%)
const SOGLIA_VAL_ALTA = 75; // Bybit usa spesso 0.7-0.8 come estremo
const SOGLIA_VAL_BASSA = 25;

const LOOKBACK = 720; // 30 giorni (24h * 30)
const MIN_VOL_24H_USDT = 2000000;
const SCAN_INTERVAL = 1000 * 60 * 30; // 30 minuti

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";

let PAIRS = [];
let BINANCE_SYMBOLS = new Set();
let isScanning = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==========================================
// FUNZIONI HELPER
// ==========================================

function getRelativePosition(current, history) {
    const values = history.map(v => parseFloat(v)).filter(v => !isNaN(v));
    if (values.length < 10) return 50; 
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max === min) return 50;
    return Math.max(0, Math.min(100, ((current - min) / (max - min)) * 100));
}

// ==========================================
// FETCH DATI E LOG ANALISI
// ==========================================

async function fetchSentimentData(symbol, tickerMap) {
    try {
        const [bybitRes, binHolderRes, binTopRes] = await Promise.all([
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
        const binHolder = binHolderRes.data || [];
        const binTop    = binTopRes.data || [];

        if (bybitList.length < 10 || binHolder.length < 10) return null;

        // --- BYBIT ANALISI ---
        const bybitHistory = bybitList.map(x => parseFloat(x.buyRatio || 0));
        const currentBybit = bybitHistory[bybitHistory.length - 1];
        const bybitPos = getRelativePosition(currentBybit, bybitHistory);
        const bybitVal = (currentBybit * 100);

        // --- BINANCE RETAIL ANALISI ---
        const binHolderHistory = binHolder.map(x => parseFloat(x.longAccount || 0));
        const currentBinHolder = binHolderHistory[binHolderHistory.length - 1];
        const binHolderPos = getRelativePosition(currentBinHolder, binHolderHistory);
        const binHolderVal = (currentBinHolder * 100);

        // --- BINANCE TOP ANALISI ---
        const binTopHistory = binTop.map(x => parseFloat(x.longAccount || 0));
        const currentBinTop = binTopHistory[binTopHistory.length - 1];
        const binTopPos = getRelativePosition(currentBinTop, binTopHistory);
        const binTopVal = (currentBinTop * 100);

        const ticker = tickerMap.get(symbol);
        const funding = ticker ? (parseFloat(ticker.fundingRate || 0) * 100).toFixed(4) : '0.0000';
        const price = ticker ? parseFloat(ticker.lastPrice || 0) : 0;

        // Score per ordinamento
        const score = Math.abs(binHolderPos - binTopPos) + Math.max(bybitPos, 100-bybitPos);

        return {
            symbol, bybitVal, bybitPos, binHolderVal, binHolderPos,
            binTopVal, binTopPos, price, funding, score
        };
    } catch (err) { return null; }
}

// ==========================================
// SCANNER CON I 4 TIPI DI MESSAGGI
// ==========================================

async function scan() {
    if (isScanning) return;
    isScanning = true;
    console.log(`\n--- SCAN IN CORSO: ${new Date().toLocaleTimeString()} ---`);

    try {
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' } });
        const tickerMap = new Map(tickersRes.data.result.list.map(t => [t.symbol, t]));

        const candidates = PAIRS.filter(s => {
            const t = tickerMap.get(s);
            return t && parseFloat(t.turnover24h) >= MIN_VOL_24H_USDT && (BINANCE_SYMBOLS.size === 0 || BINANCE_SYMBOLS.has(s));
        });

        let signals = [];

        for (const symbol of candidates) {
            const res = await fetchSentimentData(symbol, tickerMap);
            if (!res) continue;

            let title = "", emoji = "", subtitle = "";

            // 1. LONG SQUEEZE DIVERGENZA (Whales Short vs Retail Long)
            if (res.binHolderPos >= SOGLIA_ALTA_POS && res.binTopPos <= SOGLIA_BASSA_POS && res.bybitVal >= SOGLIA_VAL_ALTA) {
                title = "LONG – SQUEEZE DIVERGENZA";
                emoji = "🚀⚡";
                subtitle = "Whales SHORT vs Retail LONG estremi";
            }
            // 2. SHORT SQUEEZE DIVERGENZA (Whales Long vs Retail Short)
            else if (res.binHolderPos <= SOGLIA_BASSA_POS && res.binTopPos >= SOGLIA_ALTA_POS && res.bybitVal <= SOGLIA_VAL_BASSA) {
                title = "SHORT – SQUEEZE DIVERGENZA";
                emoji = "📉⚠️";
                subtitle = "Whales LONG vs Retail SHORT estremi";
            }
            // 3. LONG OVERCROWDED (Tutti Long)
            else if (res.binHolderPos >= SOGLIA_ALTA_POS && res.binTopPos >= SOGLIA_ALTA_POS && res.bybitVal >= SOGLIA_VAL_ALTA) {
                title = "LONG – OVERCROWDED";
                emoji = "🚀🔥";
                subtitle = "Sentiment unanime Long (Rischio Correzione)";
            }
            // 4. SHORT OVERCROWDED (Tutti Short)
            else if (res.binHolderPos <= SOGLIA_BASSA_POS && res.binTopPos <= SOGLIA_BASSA_POS && res.bybitVal <= SOGLIA_VAL_BASSA) {
                title = "SHORT – OVERCROWDED";
                emoji = "📉❄️";
                subtitle = "Sentiment unanime Short (Rischio Rimbalzo)";
            }

            if (title) {
                console.log(`[!] TROVATO: ${symbol} -> ${title}`);
                const fundingSign = parseFloat(res.funding) > 0 ? '🔴 longs pagano' : '🟢 shorts pagano';
                signals.push({
                    score: res.score,
                    text: `
<b>${emoji} ${title}</b>
#${res.symbol} @ ${res.price}
${subtitle}

Bin Retail: <b>${res.binHolderVal.toFixed(1)}%</b> (Pos ${res.binHolderPos.toFixed(0)}%)
Bin Top: <b>${res.binTopVal.toFixed(1)}%</b> (Pos ${res.binTopPos.toFixed(0)}%)
Bybit Retail: <b>${res.bybitVal.toFixed(1)}%</b> (Pos ${res.bybitPos.toFixed(0)}%)
Funding: <b>${res.funding}%</b> ${fundingSign}
                    `.trim()
                });
            }
        }

        signals.sort((a, b) => b.score - a.score);

        for (const sig of signals) {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID, text: sig.text, parse_mode: "HTML"
            }).catch(() => {});
            await sleep(500);
        }
        console.log(`--- SCAN FINITO: ${signals.length} SEGNALI ---\n`);
    } catch (err) { console.error("Errore:", err.message); }
    finally { isScanning = false; }
}

// Inserire qui le funzioni initialize() e loadBinanceSymbols() del codice precedente...
// [ESATTAMENTE COME PRIMA]
async function loadBinanceSymbols() {
    try {
        const binInfo = await axios.get(`${BASE_BINANCE}/fapi/v1/exchangeInfo`);
        BINANCE_SYMBOLS = new Set(binInfo.data.symbols.filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT').map(s => s.symbol));
    } catch (err) {}
}

async function initialize() {
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/instruments-info`, { params: { category: "linear" } });
        PAIRS = res.data.result.list.filter(p => p.quoteCoin === "USDT" && p.status === "Trading").map(p => p.symbol);
        await loadBinanceSymbols();
        setInterval(loadBinanceSymbols, 1000 * 60 * 60 * 12);
        scan();
        setInterval(scan, SCAN_INTERVAL);
    } catch (err) {}
}
initialize();
