const axios = require('axios');

// ==========================================
// CONFIGURAZIONE
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SOGLIA_ALTA_BIN    = 95;
const SOGLIA_BASSA_BIN   = 5;
const SOGLIA_BYBIT_LONG  = 80;
const SOGLIA_BYBIT_SHORT = 20;

const LOOKBACK          = 48;           // ore
const MIN_VOL_24H_USDT  = 2000000;      // volume minimo 24h in USDT
const SCAN_INTERVAL     = 1000 * 60 * 30; // 30 minuti

const CONCURRENCY_LIMIT = 6;            // prudente per evitare ban rate-limit
const REQUEST_TIMEOUT   = 8000;

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";

let PAIRS = [];
let isScanning = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==========================================
// FUNZIONI DI CALCOLO
// ==========================================

function getRelativePosition(current, history) {
    const values = history.map(v => parseFloat(v)).filter(v => !isNaN(v));
    if (values.length === 0) return 50;
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max === min) return 50;
    return Math.max(0, Math.min(100, ((current - min) / (max - min)) * 100));
}

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

        if (bybitList.length < 5 || binHolder.length < 5 || binTop.length < 5) {
            return null;
        }

        // Bybit → ultimo valore (più recente)
        const latestBybit = bybitList[bybitList.length - 1];
        const bybitLongPct = parseFloat(latestBybit.longRatio || 0) * 100;

        // Binance → ultimo valore = più recente
        const binHolderLongs = binHolder.map(x => parseFloat(x.longAccount || 0));
        const binTopLongs    = binTop.map(x => parseFloat(x.longAccount || 0));

        const currentBinHolder = binHolderLongs[binHolderLongs.length - 1] || 0;
        const currentBinTop    = binTopLongs[binTopLongs.length - 1]    || 0;

        const ticker = tickerMap.get(symbol);

        return {
            symbol,
            binHolderPos: getRelativePosition(currentBinHolder, binHolderLongs),
            binTopPos:    getRelativePosition(currentBinTop,    binTopLongs),
            binHolderVal: (currentBinHolder * 100).toFixed(1),
            binTopVal:    (currentBinTop    * 100).toFixed(1),
            bybitVal:     bybitLongPct.toFixed(1),
            funding:      ticker ? (parseFloat(ticker.fundingRate || 0) * 100).toFixed(4) : '0.0000',
            price:        ticker ? parseFloat(ticker.lastPrice || 0) : 0
        };
    } catch (err) {
        console.log(`Errore fetch ${symbol}: ${err.message}`);
        return null;
    }
}

// ==========================================
// SCANNER PRINCIPALE
// ==========================================

async function scan() {
    if (isScanning) {
        console.log("Scan già in corso → salto");
        return;
    }

    isScanning = true;
    const start = Date.now();

    try {
        // 1. Ottieni tutti i ticker per volume e prezzo
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, {
            params: { category: 'linear' },
            timeout: 12000
        });

        const tickerMap = new Map(tickersRes.data.result.list.map(t => [t.symbol, t]));

        // 2. Filtra solo coppie attive con volume decente
        const candidates = PAIRS.filter(s => {
            const t = tickerMap.get(s);
            return t && parseFloat(t.turnover24h || 0) >= MIN_VOL_24H_USDT;
        });

        console.log(`Scan avviato — ${candidates.length} coppie qualificate`);

        let signals = [];

        // Processa a batch per non ammazzare rate-limit
        for (let i = 0; i < candidates.length; i += CONCURRENCY_LIMIT) {
            const batch = candidates.slice(i, i + CONCURRENCY_LIMIT);
            const results = await Promise.all(
                batch.map(s => fetchSentimentData(s, tickerMap))
            );

            for (const res of results) {
                if (!res) continue;

                let title = "";
                let emoji = "";
                let subtitle = "";

                if (res.binHolderPos >= SOGLIA_ALTA_BIN &&
                    res.binTopPos    <= SOGLIA_BASSA_BIN &&
                    res.bybitVal     >= SOGLIA_BYBIT_LONG) {
                    title    = "LONG – SQUEEZE DIVERGENZA";
                    emoji    = "🚀⚡";
                    subtitle = "Top corti vs Retail long estremi";
                }
                else if (res.binHolderPos <= SOGLIA_BASSA_BIN &&
                         res.binTopPos    >= SOGLIA_ALTA_BIN &&
                         res.bybitVal     <= SOGLIA_BYBIT_SHORT) {
                    title    = "SHORT – SQUEEZE DIVERGENZA";
                    emoji    = "📉⚠️";
                    subtitle = "Top long vs Retail short estremi";
                }
                else if (res.binHolderPos >= SOGLIA_ALTA_BIN &&
                         res.binTopPos    >= SOGLIA_ALTA_BIN &&
                         res.bybitVal     >= SOGLIA_BYBIT_LONG) {
                    title    = "LONG – OVERCROWDED";
                    emoji    = "🚀🔥";
                    subtitle = "Tutti estremi long";
                }
                else if (res.binHolderPos <= SOGLIA_BASSA_BIN &&
                         res.binTopPos    <= SOGLIA_BASSA_BIN &&
                         res.bybitVal     <= SOGLIA_BYBIT_SHORT) {
                    title    = "SHORT – OVERCROWDED";
                    emoji    = "📉❄️";
                    subtitle = "Tutti estremi short";
                }

                if (title) {
                    const priceStr = res.price
                        ? res.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
                        : "—";

                    const fundingSign = parseFloat(res.funding) > 0 ? '🔴 longs pagano' : '🟢 shorts pagano';

                    signals.push(`
<b>${emoji} ${title}</b>
#${res.symbol}  @ ${priceStr}
${subtitle}

Bin Holder: <b>${res.binHolderVal}%</b>   Top: <b>${res.binTopVal}%</b>
Bybit retail: <b>${res.bybitVal}%</b>
Funding: <b>${res.funding}%</b> ${fundingSign}
                    `.trim());
                }
            }

            await sleep(350); // micro-pausa tra batch
        }

        // Invio Telegram se ci sono segnali
        if (signals.length > 0) {
            console.log(`Trovati ${signals.length} segnali`);

            for (let j = 0; j < signals.length; j += 4) {
                const chunk = signals.slice(j, j + 4).join("\n\n———\n\n");
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: `<b>📊 SENTIMENT ALERT  ${new Date().toLocaleTimeString('it-IT')}</b>\n\n${chunk}`,
                    parse_mode: "HTML"
                }, { timeout: 10000 }).catch(e => console.log("Telegram fallito:", e.message));
            }
        }

        const duration = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`Scan terminato in ${duration}s — segnali: ${signals.length}`);

    } catch (err) {
        console.error("Errore scan principale:", err.message);
    } finally {
        isScanning = false;
    }
}

// ==========================================
// AVVIO
// ==========================================

async function initialize() {
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/instruments-info`, {
            params: { category: "linear" },
            timeout: 15000
        });

        PAIRS = res.data.result.list
            .filter(p => p.quoteCoin === "USDT" && p.status === "Trading")
            .map(p => p.symbol);

        console.log(`Inizializzato — ${PAIRS.length} coppie lineari USDT`);

        await scan();                    // primo scan immediato
        setInterval(scan, SCAN_INTERVAL); // poi ciclico

    } catch (err) {
        console.error("Fallita inizializzazione:", err.message);
    }
}

initialize();
