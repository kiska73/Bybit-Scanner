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
// Bybit Retail Ratio (buy/sell account ratio)
// ==========================================
async function getBybitRetail(symbol, tickerMap) {
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, {
            params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK },
            timeout: 6000
        });

        const list = res.data?.result?.list || [];
        if (list.length < 1) return null;

        const buyHistory = list.map(x => parseFloat(x.buyRatio || 0));
        const currentBuy = buyHistory[0] * 100; // in %

        return { bybitBuyPos: getPosition(currentBuy, buyHistory), bybitBuy: currentBuy };
    } catch (err) {
        if (err.response?.status !== 404) console.log(`Bybit retail err ${symbol}: ${err.message}`);
        return null;
    }
}

// ==========================================
// Binance Holder (global account) + Top Trader
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

        if (holder.length < 1 || top.length < 1) return null;

        const holderLongHist = holder.map(x => parseFloat(x.longAccount) * 100);
        const topLongHist    = top.map(x => parseFloat(x.longAccount) * 100);

        const holderLong = holderLongHist[0];
        const topLong    = topLongHist[0];

        const price = parseFloat(holder[0]?.price || tickerMap.get(symbol)?.lastPrice || 0);

        return {
            holderPos: getPosition(holderLong, holderLongHist),
            topPos:    getPosition(topLong,    topLongHist),
            holderLong,
            topLong,
            price
        };
    } catch (err) {
        console.log(`Binance err ${symbol}: ${err.message}`);
        return null;
    }
}

// ==========================================
// SCAN PRINCIPALE
// ==========================================
async function scan() {
    console.log(`\n--- [${new Date().toLocaleTimeString()}] Scan Bybit+Binance ---`);

    // Tickers Bybit per volume + funding + price fallback
    const tickRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' }, timeout: 10000 });
    const tickerMap = new Map(tickRes.data.result.list.map(t => [t.symbol, t]));

    const highVolPairs = PAIRS.filter(s => {
        const t = tickerMap.get(s);
        return t && parseFloat(t.turnover24h || 0) >= MIN_VOL_2M;
    });

    console.log(`High vol pairs: ${highVolPairs.length}`);

    let messages = [];

    for (let i = 0; i < highVolPairs.length; i += 8) {  // batch piccolo per Binance
        const batch = highVolPairs.slice(i, i + 8);

        await Promise.all(batch.map(async symbol => {
            const binance = await getBinanceRatios(symbol);
            if (!binance) return;

            const { holderPos, topPos, holderLong, topLong, price } = binance;

            const ticker = tickerMap.get(symbol);
            const fund = ticker ? (parseFloat(ticker.fundingRate) * 100).toFixed(4) : 'N/A';

            let type = "";
            if (holderPos >= SOGLIA_ALTA && topPos >= SOGLIA_ALTA) {
                type = "2 alti long forte";
            } else if (holderPos <= SOGLIA_BASSA && topPos <= SOGLIA_BASSA) {
                type = "2 bassi short forte";
            } else if (
                (holderPos >= SOGLIA_ALTA && topPos <= SOGLIA_BASSA) ||
                (holderPos <= SOGLIA_BASSA && topPos >= SOGLIA_ALTA)
            ) {
                type = "SQUEEZE possibile (divergenza)";
            }

            if (type) {
                messages.push(`
<b>${type.toUpperCase()}</b>
<b>${symbol}</b> @ ${price.toFixed(2)}

Holder Binance: <b>${holderLong.toFixed(0)}%</b> long
Top Binance: <b>${topLong.toFixed(0)}%</b> long
Funding: <b>${fund}%</b> ${parseFloat(fund) > 0 ? '🔴' : '🟢'}
                `.trim());
            }
        }));

        await sleep(300); // respiro per Binance rate limit
    }

    if (messages.length > 0) {
        for (let j = 0; j < messages.length; j += 4) {
            const chunk = messages.slice(j, j + 4).join("\n\n——————\n\n");
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: `<b>📊 RATIO ALERT (Binance + Bybit retail)</b>\n\n${chunk}`,
                parse_mode: "HTML"
            }).catch(e => console.log("Telegram err:", e.message));
        }
        console.log(`✅ ${messages.length} segnali inviati`);
    } else {
        console.log("Nessun segnale estremo");
    }
}

// ==========================================
// AVVIO
// ==========================================
async function init() {
    console.log("🚀 Radar Bybit+Binance avviato...");
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/instruments-info`, { params: { category: "linear" } });
        PAIRS = res.data.result.list
            .filter(p => p.quoteCoin === "USDT" && p.contractType === "LinearPerpetual" && p.status === "Trading")
            .map(p => p.symbol);

        console.log(`Caricate ${PAIRS.length} coppie USDT perp`);
    } catch (e) {
        console.error("Errore init pairs:", e.message);
    }

    await scan();
    setInterval(scan, SCAN_INTERVAL);
}

init().catch(console.error);
