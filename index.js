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
const SCAN_INTERVAL      = 1000 * 60 * 30; // 30 min

const CONCURRENCY_LIMIT  = 4;
const REQUEST_TIMEOUT    = 12000;

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
    if (values.length < 2) return 50;

    let min = Infinity, max = -Infinity;
    for (const v of values) {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (max === min) return 50;
    return Math.max(0, Math.min(100, ((current - min) / (max - min)) * 100));
}

// ==========================================
// CARICAMENTO SIMBOLI BINANCE (con refresh periodico)
// ==========================================

async function loadBinanceSymbols() {
    try {
        const binInfo = await axios.get(`${BASE_BINANCE}/fapi/v1/exchangeInfo`, { timeout: 15000 });
        const newSymbols = new Set(
            binInfo.data.symbols
                .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
                .map(s => s.symbol)
        );
        BINANCE_SYMBOLS = newSymbols;
        console.log(`Cache Binance aggiornata: ${BINANCE_SYMBOLS.size} perpetual USDT`);
    } catch (err) {
        console.warn("Errore refresh cache Binance:", err.message);
    }
}

// ==========================================
// FETCH DATI SENTIMENT
// ==========================================

async function fetchSentimentData(symbol, tickerMap) {
    try {
        const [bybitRes, binHolderRes, binTopRes] = await Promise.all([
            axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, {
                params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK },
                timeout: REQUEST_TIMEOUT
            }),
            axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, {
                params: { symbol, period: '1h', limit: LOOKBACK },
                timeout: REQUEST_TIMEOUT
            }),
            axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, {
                params: { symbol, period: '1h', limit: LOOKBACK },
                timeout: REQUEST_TIMEOUT
            })
        ]);

        const bybitList = bybitRes.data?.result?.list || [];
        const binHolder = binHolderRes.data || [];
        const binTop    = binTopRes.data || [];

        if (bybitList.length < 5 || binHolder.length < 5 || binTop.length < 5) return null;

        const latestBybit = bybitList[bybitList.length - 1];
        const rawBybitRatio = parseFloat(latestBybit.buyRatio || 0);
        const bybitLongPct  = (rawBybitRatio * 100).toFixed(1);

        const binHolderLongs = binHolder.map(x => parseFloat(x.longAccount || 0));
        const binTopLongs    = binTop.map(x => parseFloat(x.longAccount || 0));

        const currentBinHolder = binHolderLongs[binHolderLongs.length - 1] || 0;
        const currentBinTop    = binTopLongs[binTopLongs.length - 1] || 0;

        const binHolderPos = getRelativePosition(currentBinHolder, binHolderLongs);
        const binTopPos    = getRelativePosition(currentBinTop, binTopLongs);

        const binHolderVal = (currentBinHolder * 100).toFixed(1);
        const binTopVal    = (currentBinTop * 100).toFixed(1);

        const ticker = tickerMap.get(symbol);
        const fundingVal = ticker ? (parseFloat(ticker.fundingRate || 0) * 100).toFixed(4) : '0.0000';

        // ────────────────────────────────────────────────
        // CALCOLO SCORE per ordinamento segnali (più alto = più rilevante)
        // ────────────────────────────────────────────────
        const divBybitWhales     = Math.abs(parseFloat(bybitLongPct) - parseFloat(binTopVal));
        const divRetailWhales    = Math.abs(binHolderPos - binTopPos);          // aggiunta importante
        const extremism          = Math.max(binHolderPos, 100 - binHolderPos, binTopPos, 100 - binTopPos);
        const fundingBonus       =
            (parseFloat(fundingVal) > 0.01 && parseFloat(bybitLongPct) > 70) ? 30 :
            (parseFloat(fundingVal) < -0.01 && parseFloat(bybitLongPct) < 30) ? 30 : 0;

        const score = divBybitWhales + divRetailWhales + extremism + fundingBonus;
        // ────────────────────────────────────────────────

        return {
            symbol,
            binHolderPos,
            binTopPos,
            binHolderVal,
            binTopVal,
            bybitVal: bybitLongPct,
            funding: fundingVal,
            price: ticker ? parseFloat(ticker.lastPrice || 0) : 0,
            score
        };
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
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, {
            params: { category: 'linear' },
            timeout: 20000
        });

        const tickerMap = new Map(tickersRes.data.result.list.map(t => [t.symbol, t]));

        const candidates = PAIRS.filter(s => {
            const t = tickerMap.get(s);
            if (!t) return false;
            if (parseFloat(t.turnover24h || 0) < MIN_VOL_24H_USDT) return false;
            if (BINANCE_SYMBOLS.size > 0 && !BINANCE_SYMBOLS.has(s)) return false;
            return true;
        });

        console.log(`Scan → ${candidates.length} coppie qualificate`);

        let signals = [];

        for (let i = 0; i < candidates.length; i += CONCURRENCY_LIMIT) {
            const batch = candidates.slice(i, i + CONCURRENCY_LIMIT);
            const results = await Promise.all(batch.map(s => fetchSentimentData(s, tickerMap)));

            for (const res of results) {
                if (!res) continue;
                if (parseFloat(res.bybitVal) < 5) continue;

                let title = "", emoji = "", subtitle = "";

                if (res.binHolderPos >= SOGLIA_ALTA_BIN && res.binTopPos <= SOGLIA_BASSA_BIN && parseFloat(res.bybitVal) >= SOGLIA_BYBIT_LONG) {
                    title = "LONG – SQUEEZE DIVERGENZA";
                    emoji = "🚀⚡";
                    subtitle = "Whales SHORT vs Retail LONG estremi";
                } else if (res.binHolderPos <= SOGLIA_BASSA_BIN && res.binTopPos >= SOGLIA_ALTA_BIN && parseFloat(res.bybitVal) <= SOGLIA_BYBIT_SHORT) {
                    title = "SHORT – SQUEEZE DIVERGENZA";
                    emoji = "📉⚠️";
                    subtitle = "Whales LONG vs Retail SHORT estremi";
                } else if (res.binHolderPos >= SOGLIA_ALTA_BIN && res.binTopPos >= SOGLIA_ALTA_BIN && parseFloat(res.bybitVal) >= SOGLIA_BYBIT_LONG) {
                    title = "LONG – OVERCROWDED";
                    emoji = "🚀🔥";
                    subtitle = "Sentiment unanime Long";
                } else if (res.binHolderPos <= SOGLIA_BASSA_BIN && res.binTopPos <= SOGLIA_BASSA_BIN && parseFloat(res.bybitVal) <= SOGLIA_BYBIT_SHORT) {
                    title = "SHORT – OVERCROWDED";
                    emoji = "📉❄️";
                    subtitle = "Sentiment unanime Short";
                }

                if (title) {
                    const fundingSign = parseFloat(res.funding) > 0 ? '🔴 longs pagano' : '🟢 shorts pagano';

                    signals.push({
                        text: `
<b>${emoji} ${title}</b>
#${res.symbol} @ ${res.price.toFixed(4)}
${subtitle}

Bin Retail: <b>${res.binHolderVal}%</b> (Pos ${res.binHolderPos.toFixed(0)}%)
Bin Top: <b>${res.binTopVal}%</b> (Pos ${res.binTopPos.toFixed(0)}%)
Bybit Retail: <b>${res.bybitVal}%</b>
Funding: <b>${res.funding}%</b> ${fundingSign}
                        `.trim(),
                        score: res.score
                    });
                }
            }
            await sleep(600);
        }

        // ORDINA per score decrescente
        signals.sort((a, b) => b.score - a.score);

        if (signals.length > 0) {
            const texts = signals.map(s => s.text);
            for (let j = 0; j < texts.length; j += 3) {
                const chunk = texts.slice(j, j + 3).join("\n\n———\n\n");
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: `<b>📊 SENTIMENT ALERT ${new Date().toLocaleTimeString('it-IT')}</b>\n\n${chunk}`,
                    parse_mode: "HTML"
                }, { timeout: 10000 }).catch(() => {});
            }
        }

        console.log(`Scan completato (${((Date.now() - start)/1000).toFixed(1)}s) — segnali: ${signals.length}`);
    } catch (err) {
        console.error("Errore scan:", err.message);
    } finally {
        isScanning = false;
    }
}

// ==========================================
// AVVIO
// ==========================================

async function initialize() {
    try {
        // Carica coppie Bybit
        const res = await axios.get(`${BASE_BYBIT}/v5/market/instruments-info`, {
            params: { category: "linear" },
            timeout: 20000
        });

        PAIRS = res.data.result.list
            .filter(p => p.quoteCoin === "USDT" && p.status === "Trading")
            .map(p => p.symbol);

        console.log(`Caricate ${PAIRS.length} coppie USDT`);

        // Carica cache Binance subito
        await loadBinanceSymbols();

        // Refresh cache Binance ogni 12 ore
        setInterval(loadBinanceSymbols, 1000 * 60 * 60 * 12);

        await scan();
        setInterval(scan, SCAN_INTERVAL);
    } catch (err) {
        console.error("Inizializzazione fallita:", err.message);
    }
}

initialize();
