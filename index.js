const axios = require('axios');

// ==========================================
// CONFIGURAZIONE
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SOGLIA_ALTA  = 80;
const SOGLIA_BASSA = 20;
const LOOKBACK     = 48;
const MIN_VOL_2M   = 2000000;

const SCAN_INTERVAL = 1000 * 60 * 30; // 30 minuti

const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";
// ==========================================

let PAIRS = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getPosition(current, history) {
    const values = history.map(v => parseFloat(v));
    const max = Math.max(...values);
    const min = Math.min(...values);
    if (max === min) return 50;
    return ((current - min) / (max - min)) * 100;
}

// ==========================================
// Bybit Retail Ratio (account-ratio con buy/sell)
// ==========================================
async function getBybitData(symbol, tickerMap) {
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, {
            params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK },
            timeout: 6000
        });
        const list = res.data?.result?.list || [];
        if (list.length < 5) return null;

        const longHist = list.map(x => parseFloat(x.buyRatio || 0) * 100); // buyRatio = % long accounts
        const currentLong = longHist[0];

        const ticker = tickerMap.get(symbol);
        return {
            bybitLongPos: getPosition(currentLong, longHist),
            bybitLong: currentLong,
            priceFallback: ticker ? parseFloat(ticker.lastPrice) : 0,
            fund: ticker ? (parseFloat(ticker.fundingRate) * 100).toFixed(4) : '0.0000'
        };
    } catch (err) {
        return null;
    }
}

// ==========================================
// Binance Holder + Top Trader
// ==========================================
async function getBinanceRatios(symbol) {
    try {
        const [resHolder, resTop] = await Promise.all([
            axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, {
                params: { symbol, period: '1h', limit: LOOKBACK },
                timeout: 6000
            }),
            axios.get(`${BASE_BINANCE}/futures/data/topLongShortAccountRatio`, {
                params: { symbol, period: '1h', limit: LOOKBACK },
                timeout: 6000
            })
        ]);

        const holder = resHolder.data || [];
        const top    = resTop.data    || [];

        if (holder.length < 5 || top.length < 5) return null;

        const holderLongHist = holder.map(x => parseFloat(x.longAccount) * 100);
        const topLongHist    = top.map(x => parseFloat(x.longAccount) * 100);

        return {
            holderPos: getPosition(holderLongHist[0], holderLongHist),
            topPos:    getPosition(topLongHist[0],    topLongHist),
            holderLong: holderLongHist[0],
            topLong:    topLongHist[0],
            price: parseFloat(holder[0]?.price || 0)
        };
    } catch (err) {
        console.log(`Binance skip ${symbol}: ${err.message}`);
        return null;
    }
}

// ==========================================
// SCAN
// ==========================================
async function scan() {
    console.log(`\n--- [${new Date().toLocaleTimeString()}] Scan ---`);

    try {
        const tickRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' }, timeout: 10000 });
        const tickerMap = new Map(tickRes.data.result.list.map(t => [t.symbol, t]));

        const highVolPairs = PAIRS.filter(s => {
            const t = tickerMap.get(s);
            return t && parseFloat(t.turnover24h || 0) >= MIN_VOL_2M;
        });

        console.log(`Coppie da analizzare: ${highVolPairs.length}`);

        let messages = [];

        for (let i = 0; i < highVolPairs.length; i += 5) {
            const batch = highVolPairs.slice(i, i + 5);

            await Promise.all(batch.map(async symbol => {
                const [binance, bybit] = await Promise.all([
                    getBinanceRatios(symbol),
                    getBybitData(symbol, tickerMap)
                ]);

                if (!binance) return;

                const price = binance.price || bybit?.priceFallback || 0;
                const fund  = bybit?.fund || '0.0000';

                let type = "";
                const hPos = binance.holderPos;
                const tPos = binance.topPos;

                if (hPos >= SOGLIA_ALTA && tPos <= SOGLIA_BASSA) {
                    type = "⚡ SQUEEZE LONG (Divergenza)";
                } else if (hPos <= SOGLIA_BASSA && tPos >= SOGLIA_ALTA) {
                    type = "⚠️ SHORT SQUEEZE (Divergenza)";
                } else if (hPos >= SOGLIA_ALTA && tPos >= SOGLIA_ALTA) {
                    type = "🚀 LONG FORTE UNANIME";
                } else if (hPos <= SOGLIA_BASSA && tPos <= SOGLIA_BASSA) {
                    type = "📉 SHORT FORTE UNANIME";
                }

                if (type) {
                    const bybitLine = bybit 
                        ? `Bybit Retail Long: <b>${bybit.bybitLong.toFixed(1)}%</b> (${bybit.bybitLongPos.toFixed(0)}% range)`
                        : `Bybit Retail: <i>non disp.</i>`;

                    messages.push(`
<b>${type}</b>
<b>${symbol}</b> @ ${price.toFixed(2)}

Binance Holder: <b>${binance.holderLong.toFixed(1)}%</b> (${hPos.toFixed(0)}%)
Binance Top: <b>${binance.topLong.toFixed(1)}%</b> (${tPos.toFixed(0)}%)
${bybitLine}
Funding: <b>${fund}%</b> ${parseFloat(fund) > 0 ? '🔴' : '🟢'}
                    `.trim());
                }
            }));

            await sleep(500);
        }

        if (messages.length > 0) {
            for (let j = 0; j < messages.length; j += 4) {
                const chunk = messages.slice(j, j + 4).join("\n\n———\n\n");
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: `<b>📊 RADAR BINANCE + BYBIT</b>\n\n${chunk}`,
                    parse_mode: "HTML"
                });
            }
            console.log(`✅ Inviati ${messages.length} segnali`);
        } else {
            console.log("Nessun segnale");
        }

    } catch (e) {
        console.error("Errore scan:", e.message);
    }
}

// Init pairs da Bybit
async function init() {
    console.log("🚀 Avvio...");
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/instruments-info`, { params: { category: "linear" } });
        PAIRS = res.data.result.list
            .filter(p => p.quoteCoin === "USDT" && p.contractType === "LinearPerpetual" && p.status === "Trading")
            .map(p => p.symbol);
        console.log(`Coppie caricate: ${PAIRS.length}`);
        await scan();
        setInterval(scan, SCAN_INTERVAL);
    } catch (e) {
        console.error("Init fallito:", e.message);
    }
}

init();
