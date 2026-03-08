const axios = require('axios');

// ==========================================
// CONFIGURAZIONE BLINDATA (BINANCE 95/5 + BYBIT 80%)
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

// Binance: Posizione nel grafico (95 = soffitto, 5 = pavimento)
const SOGLIA_ALTA_BIN  = 95; 
const SOGLIA_BASSA_BIN = 5;

// Bybit: Valore assoluto Retail (80% = massa pesantemente long)
const SOGLIA_BYBIT_LONG  = 80;
const SOGLIA_BYBIT_SHORT = 20;

const LOOKBACK     = 48; 
const MIN_VOL_2M   = 2000000;
const SCAN_INTERVAL = 1000 * 60 * 30; // 30 min

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

async function getBybitData(symbol, tickerMap) {
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, {
            params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK },
            timeout: 6000
        });
        const list = res.data?.result?.list || [];
        if (list.length < 10) return null;

        const currentBuyRatio = parseFloat(list[0].buyRatio || 0) * 100;
        const ticker = tickerMap.get(symbol);

        return {
            value: currentBuyRatio, // es: 82.5
            fund: ticker ? (parseFloat(ticker.fundingRate || 0) * 100).toFixed(4) : '0.0000',
            price: ticker ? parseFloat(ticker.lastPrice || 0) : 0
        };
    } catch (err) { return null; }
}

async function getBinanceRatios(symbol) {
    try {
        const [resH, resT] = await Promise.all([
            axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: LOOKBACK }, timeout: 6000 }),
            axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: LOOKBACK }, timeout: 6000 })
        ]);

        const hData = resH.data || [];
        const tData = resT.data || [];
        if (hData.length < 10 || tData.length < 10) return null;

        const hHist = hData.map(x => parseFloat(x.longAccount));
        const tHist = tData.map(x => parseFloat(x.longAccount));

        return {
            hPos: getPosition(hHist[0], hHist),
            tPos: getPosition(tHist[0], tHist),
            hVal: (hHist[0] * 100).toFixed(1),
            tVal: (tHist[0] * 100).toFixed(1),
            price: parseFloat(hData[0].price)
        };
    } catch (err) { return null; }
}

async function scan() {
    console.log(`\n--- [${new Date().toLocaleTimeString()}] SCANNER ATTIVO ---`);

    try {
        const tickRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' } });
        const tickerMap = new Map(tickRes.data.result.list.map(t => [t.symbol, t]));

        const targetPairs = PAIRS.filter(s => {
            const t = tickerMap.get(s);
            return t && parseFloat(t.turnover24h || 0) >= MIN_VOL_2M;
        });

        let messages = [];

        for (let i = 0; i < targetPairs.length; i += 5) {
            const batch = targetPairs.slice(i, i + 5);
            await Promise.all(batch.map(async symbol => {
                const [bin, byb] = await Promise.all([getBinanceRatios(symbol), getBybitData(symbol, tickerMap)]);
                
                if (!bin || !byb) return;

                let type = "";
                // LOGICA 3 VERSIONI + FILTRO BYBIT 80/20
                
                // 1. SQUEEZE LONG (Divergenza: Retail Up, Top Down)
                if (bin.hPos >= SOGLIA_ALTA_BIN && bin.tPos <= SOGLIA_BASSA_BIN && byb.value >= SOGLIA_BYBIT_LONG) {
                    type = "⚡ SQUEEZE LONG (Divergenza)";
                } 
                // 2. SHORT SQUEEZE (Divergenza: Retail Down, Top Up)
                else if (bin.hPos <= SOGLIA_BASSA_BIN && bin.tPos >= SOGLIA_ALTA_BIN && byb.value <= SOGLIA_BYBIT_SHORT) {
                    type = "⚠️ SHORT SQUEEZE (Divergenza)";
                }
                // 3. UNANIME / FORTE (Tutti ultra-carichi nella stessa direzione)
                else if (bin.hPos >= SOGLIA_ALTA_BIN && bin.tPos >= SOGLIA_ALTA_BIN && byb.value >= SOGLIA_BYBIT_LONG) {
                    type = "🚀 ECCESSO LONG UNANIME";
                }
                else if (bin.hPos <= SOGLIA_BASSA_BIN && bin.tPos <= SOGLIA_BASSA_BIN && byb.value <= SOGLIA_BYBIT_SHORT) {
                    type = "📉 ECCESSO SHORT UNANIME";
                }

                if (type) {
                    messages.push(`
<b>${type}</b>
<b>#${symbol}</b> @ ${bin.price.toFixed(3)}
————————————
Binance Holder Pos: <b>${bin.hPos.toFixed(0)}%</b> (${bin.hVal}%)
Binance Top Pos: <b>${bin.tPos.toFixed(0)}%</b> (${bin.tVal}%)
Bybit Retail: <b>${byb.value.toFixed(1)}%</b>
💰 Funding: <b>${byb.fund}%</b> ${parseFloat(byb.fund) > 0 ? '🔴' : '🟢'}
                    `.trim());
                }
            }));
            await sleep(500);
        }

        if (messages.length > 0) {
            for (let j = 0; j < messages.length; j += 5) {
                const chunk = messages.slice(j, j + 5).join("\n\n—————\n\n");
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID, text: `<b>🚨 FILTRO 95/5 + BYBIT 80%</b>\n\n${chunk}`, parse_mode: "HTML"
                });
            }
        }
        console.log(`Scan finito. Segnali: ${messages.length}`);
    } catch (e) { console.error("Err:", e.message); }
}

async function init() {
    try {
        const res = await axios.get(`${BASE_BYBIT}/v5/market/instruments-info`, { params: { category: "linear" } });
        PAIRS = res.data.result.list.filter(p => p.quoteCoin === "USDT" && p.status === "Trading").map(p => p.symbol);
        console.log(`🚀 Radar Inizializzato. Monete: ${PAIRS.length}`);
        scan();
        setInterval(scan, SCAN_INTERVAL);
    } catch (e) { console.error("Init fallito"); }
}

init();
