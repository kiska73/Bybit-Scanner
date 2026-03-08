const axios = require('axios');

// ==========================================
// CONFIGURAZIONE SNIPER 95/5
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SOGLIA_ALTA  = 95;
const SOGLIA_BASSA = 5;
const LOOKBACK     = 48;
const MIN_VOL_2M   = 2000000;

const SCAN_INTERVAL = 1000 * 60 * 30;

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
    const pos = ((current - min) / (max - min)) * 100;
    return Math.max(0, Math.min(100, pos));
}

// Bybit Retail
async function getBybitData(symbol, tickerMap) {
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, {
            params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK },
            timeout: 6000
        });
        const list = res.data?.result?.list || [];
        if (list.length < 10) return null;

        const longHist = list.map(x => parseFloat(x.buyRatio || 0));
        const currentLong = longHist[0];
        const ticker = tickerMap.get(symbol);

        return {
            bybitLongPos: getPosition(currentLong, longHist),
            bybitLongValue: (currentLong * 100).toFixed(1),
            fund: ticker ? (parseFloat(ticker.fundingRate || 0) * 100).toFixed(4) : '0.0000',
            priceFallback: ticker ? parseFloat(ticker.lastPrice || 0) : 0
        };
    } catch (err) {
        // console.log(`Bybit skip ${symbol}`);
        return null;
    }
}

// Binance Holder + Top Position
async function getBinanceRatios(symbol) {
    try {
        const resHolder = await axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, {
            params: { symbol, period: '1h', limit: LOOKBACK },
            timeout: 6000
        });

        const hData = resHolder.data || [];
        if (hData.length < 10) return null;

        const hHist = hData.map(x => parseFloat(x.longAccount || 0));
        const currentH = hHist[0];

        let tPos = null, tValue = null;
        try {
            const resTop = await axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, {
                params: { symbol, period: '1h', limit: LOOKBACK },
                timeout: 6000
            });
            const tData = resTop.data || [];
            if (tData.length >= 10) {
                const tHist = tData.map(x => parseFloat(x.longAccount || 0));
                tPos = getPosition(tHist[0], tHist);
                tValue = (tHist[0] * 100).toFixed(1);
            }
        } catch (topErr) {
            // console.log(`Binance top skip ${symbol}`);
        }

        return {
            hPos: getPosition(currentH, hHist),
            hValue: (currentH * 100).toFixed(1),
            tPos,
            tValue,
            price: parseFloat(hData[0]?.price || 0)
        };
    } catch (err) {
        // console.log(`Binance full skip ${symbol}: ${err.message}`);
        return null;
    }
}

async function scan() {
    console.log(`\n--- [${new Date().toLocaleTimeString()}] ANALISI ---`);

    try {
        const tickRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' }, timeout: 10000 });
        const tickerMap = new Map(tickRes.data.result.list.map(t => [t.symbol, t]));

        const targetPairs = PAIRS.filter(s => {
            const t = tickerMap.get(s);
            return t && parseFloat(t.turnover24h || 0) >= MIN_VOL_2M;
        });

        console.log(`Coppie attive: ${targetPairs.length}`);

        let messages = [];

        for (let i = 0; i < targetPairs.length; i += 5) {
            const batch = targetPairs.slice(i, i + 5);

            await Promise.all(batch.map(async symbol => {
                const binance = await getBinanceRatios(symbol);
                if (!binance) return;

                const bybit = await getBybitData(symbol, tickerMap);
                const price = binance.price || bybit?.priceFallback || 0;
                const fund  = bybit?.fund || 'N/A';
                const fEmoji = parseFloat(fund) > 0 ? '🔴' : '🟢';

                let type = "";
                const hPos = binance.hPos;
                const tPos = binance.tPos;

                if (tPos !== null) {
                    if (hPos >= SOGLIA_ALTA && tPos <= SOGLIA_BASSA) type = "⚡ SQUEEZE LONG (Bullish)";
                    else if (hPos <= SOGLIA_BASSA && tPos >= SOGLIA_ALTA) type = "⚠️ SHORT SQUEEZE (Bearish)";
                    else if (hPos >= SOGLIA_ALTA && tPos >= SOGLIA_ALTA) type = "🚀 LONG UNANIME";
                    else if (hPos <= SOGLIA_BASSA && tPos <= SOGLIA_BASSA) type = "📉 SHORT UNANIME";
                } else if (hPos >= SOGLIA_ALTA) type = "🚀 LONG FORTE (Holder)";
                  else if (hPos <= SOGLIA_BASSA) type = "📉 SHORT FORTE (Holder)";

                if (type) {
                    const topLine = tPos !== null ? `Binance Top: <b>${binance.tValue}%</b> (Pos: ${tPos.toFixed(0)}%)` : `Binance Top: <i>N/D</i>`;
                    const bybitLine = bybit ? `Bybit Retail: <b>${bybit.bybitLongValue}%</b> (Pos: ${bybit.bybitLongPos.toFixed(0)}%)` : `Bybit: <i>N/D</i>`;

                    messages.push(`
<b>${type}</b>
#${symbol} @ ${price.toFixed(3)}
————————————
Binance Holder: <b>${binance.hValue}%</b> (Pos: ${hPos.toFixed(0)}%)
${topLine}
${bybitLine}
Funding: <b>${fund}%</b> ${fEmoji}
                    `.trim());
                }
            }));

            await sleep(500);
        }

        if (messages.length > 0) {
            for (let j = 0; j < messages.length; j += 5) {
                const chunk = messages.slice(j, j + 5).join("\n\n—————\n\n");
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: `<b>🚨 ECCESSI 95/5</b>\n\n${chunk}`,
                    parse_mode: "HTML"
                });
            }
            console.log(`Inviati ${messages.length} segnali`);
        } else {
            console.log("Nessun eccesso rilevato");
        }
    } catch (e) {
        console.error("Scan error:", e.message);
    }
}

async function init() {
    console.log("🚀 Radar Sniper avviato...");
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/instruments-info`, { params: { category: "linear" } });
        PAIRS = res.data.result.list
            .filter(p => p.quoteCoin === "USDT" && p.contractType === "LinearPerpetual" && p.status === "Trading")
            .map(p => p.symbol);
        console.log(`Coppie caricate: ${PAIRS.length}`);
        scan();
        setInterval(scan, SCAN_INTERVAL);
    } catch (e) {
        console.error("Init error:", e.message);
    }
}

init();
