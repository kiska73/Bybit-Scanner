const axios = require('axios');

// ==========================================
// CONFIGURAZIONE
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SOGLIA_ALTA  = 80;
const SOGLIA_BASSA = 20;

const LOOKBACK = 48;
const MIN_VOL  = 2000000;

const SCAN_INTERVAL = 1000 * 60 * 30; // 30 minuti
const BATCH_SIZE    = 15;
const BATCH_SLEEP   = 100;
// ==========================================

const BASE = "https://api.bybit.com";

let PAIRS = [];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getPosition(current, history) {
    const values = history.map(v => parseFloat(v));
    const max = Math.max(...values);
    const min = Math.min(...values);
    if (max === min) return 50;
    return ((current - min) / (max - min)) * 100;
}

// ==========================================
// ANALISI SINGOLA COIN con LOG DIAGNOSTICI
// ==========================================
async function getSignal(symbol, tickerMap) {
    try {
        const [resM, resT] = await Promise.all([
            axios.get(`${BASE}/v5/market/account-ratio`, {
                params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK },
                timeout: 5000
            }).catch(err => ({ error: err.response?.status || err.message, data: err.response?.data || err.message })),
            axios.get(`${BASE}/v5/market/top-trader-account-ratio`, {
                params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK },
                timeout: 5000
            }).catch(err => ({ error: err.response?.status || err.message, data: err.response?.data || err.message }))
        ]);

        const ticker = tickerMap.get(symbol);
        if (!ticker) {
            console.log(`${symbol.padEnd(12)} → NO TICKER DATA`);
            return null;
        }

        const vol24h = parseFloat(ticker.turnover24h);

        // ────────────────────────────────────────────────
        // LOG DIAGNOSTICO RETAIL (account-ratio)
        // ────────────────────────────────────────────────
        if (resM.error) {
            console.log(`${symbol.padEnd(12)} → RETAIL ERROR: ${resM.error} | ${JSON.stringify(resM.data || 'no extra data')}`);
        } else {
            const resultM = resM.data?.result;
            const listM = resultM?.list || [];
            console.log(`${symbol.padEnd(12)} → RETAIL list length: ${listM.length}`);
            
            if (listM.length > 0) {
                const ultimo = listM[0];
                console.log(`${symbol.padEnd(12)} → RETAIL ultimo: buyRatio=${ultimo.buyRatio || 'N/A'}, sellRatio=${ultimo.sellRatio || 'N/A'}, accountRatio=${ultimo.accountRatio || 'N/A'}`);
            } else if (resultM) {
                console.log(`${symbol.padEnd(12)} → RETAIL result presente ma list VUOTO`);
                console.log(`${symbol.padEnd(12)} → RETAIL result completo: ${JSON.stringify(resultM, null, 2).slice(0, 300)}...`);
            } else {
                console.log(`${symbol.padEnd(12)} → RETAIL result.list NON ESISTE`);
            }
        }

        // ────────────────────────────────────────────────
        // LOG DIAGNOSTICO TOP TRADER
        // ────────────────────────────────────────────────
        if (resT.error) {
            console.log(`${symbol.padEnd(12)} → TOP ERROR: ${resT.error} | ${JSON.stringify(resT.data || 'no extra data')}`);
        } else {
            const resultT = resT.data?.result;
            const listT = resultT?.list || [];
            console.log(`${symbol.padEnd(12)} → TOP list length: ${listT.length}`);
            
            if (listT.length > 0) {
                const ultimo = listT[0];
                console.log(`${symbol.padEnd(12)} → TOP ultimo: buyRatio=${ultimo.buyRatio || 'N/A'}, sellRatio=${ultimo.sellRatio || 'N/A'}, topTraderAccountRatio=${ultimo.topTraderAccountRatio || 'N/A'}`);
            } else if (resultT) {
                console.log(`${symbol.padEnd(12)} → TOP result presente ma list VUOTO`);
                console.log(`${symbol.padEnd(12)} → TOP result completo: ${JSON.stringify(resultT, null, 2).slice(0, 300)}...`);
            } else {
                console.log(`${symbol.padEnd(12)} → TOP result.list NON ESISTE`);
            }
        }

        const mData = resM.data?.result?.list || [];
        const tData = resT.data?.result?.list || [];

        if (mData.length === 0 || tData.length === 0) {
            console.log(`${symbol.padEnd(12)} → SKIPPED: dati ratio insufficienti (retail:${mData.length}, top:${tData.length})`);
            return null;
        }

        const currentM = parseFloat(mData[0].accountRatio || mData[0].buyRatio || 0);
        const currentT = parseFloat(tData[0].topTraderAccountRatio || 0);

        console.log(`${symbol.padEnd(12)} → OK → retail: ${currentM.toFixed(4)} | top: ${currentT.toFixed(4)} | vol: ${(vol24h/1e6).toFixed(1)}M`);

        return {
            symbol,
            price: parseFloat(ticker.lastPrice),
            fund: parseFloat(ticker.fundingRate) * 100,
            vol24h,
            posM: getPosition(currentM, mData.map(x => parseFloat(x.accountRatio || x.buyRatio || 0))),
            posT: getPosition(currentT, tData.map(x => parseFloat(x.topTraderAccountRatio || 0))),
            currentM,
            currentT
        };

    } catch (err) {
        console.log(`${symbol.padEnd(12)} → CRASH GENERICO: ${err.message}`);
        return null;
    }
}

// ==========================================
// SCAN MERCATO
// ==========================================
async function scan() {
    const startTime = Date.now();
    console.log(`\n🚀 [${new Date().toLocaleTimeString()}] INIZIO SCAN - ${PAIRS.length} coppie totali`);

    const resTick = await axios.get(`${BASE}/v5/market/tickers`, {
        params: { category: 'linear' },
        timeout: 8000
    }).catch(err => {
        console.log(`ERRORE TICKERS GLOBALI: ${err.message}`);
        return { data: { result: { list: [] } } };
    });

    const tickerMap = new Map((resTick.data.result?.list || []).map(t => [t.symbol, t]));

    const highVolPairs = PAIRS.filter(s => {
        const t = tickerMap.get(s);
        return t && parseFloat(t.turnover24h || 0) >= MIN_VOL;
    });

    console.log(`📈 ${highVolPairs.length} coppie con volume ≥ 2M USDT`);
    console.log(`⏭️  ${PAIRS.length - highVolPairs.length} coppie skippate per volume basso\n`);

    let messages = [];

    for (let i = 0; i < highVolPairs.length; i += BATCH_SIZE) {
        const batch = highVolPairs.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(s => getSignal(s, tickerMap)));

        for (const data of results) {
            if (!data) continue;

            console.log(
                `${data.symbol.padEnd(12)} | ` +
                `Top: ${data.posT.toFixed(0)}% (${data.currentT.toFixed(3)}) | ` +
                `Retail: ${data.posM.toFixed(0)}% (${data.currentM.toFixed(3)}) | ` +
                `Vol: ${(data.vol24h/1e6).toFixed(1)}M`
            );

            let type = "";
            if (data.posT >= SOGLIA_ALTA && data.posM <= SOGLIA_BASSA) type = "⚡ SQUEEZE LONG (BULLISH)";
            else if (data.posT <= SOGLIA_BASSA && data.posM >= SOGLIA_ALTA) type = "⚠️ SHORT SQUEEZE (BEARISH)";
            else if (data.posT >= SOGLIA_ALTA && data.posM >= SOGLIA_ALTA) type = "🚀 ECCESSO LONG UNANIME";
            else if (data.posT <= SOGLIA_BASSA && data.posM <= SOGLIA_BASSA) type = "📉 ECCESSO SHORT UNANIME";

            if (type) {
                messages.push(`
<b>${type}</b>
<b>Coppia:</b> ${data.symbol}
<b>Prezzo:</b> ${data.price}

🟡 Top Trader: <b>${data.posT.toFixed(0)}%</b> (${data.currentT.toFixed(3)})
🟠 Retail: <b>${data.posM.toFixed(0)}%</b> (${data.currentM.toFixed(3)})

💰 Funding: <b>${data.fund.toFixed(4)}%</b>
📊 Volume: <b>$${(data.vol24h / 1e6).toFixed(2)}M</b>
                `.trim());
            }
        }

        await sleep(BATCH_SLEEP);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ SCAN COMPLETATO in ${duration}s | Analizzate: ${highVolPairs.length} | Segnali trovati: ${messages.length}`);

    if (messages.length > 0) {
        for (let i = 0; i < messages.length; i += 5) {
            const chunk = messages.slice(i, i + 5).join("\n\n——————\n\n");
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: `<b>📊 REPORT RATIO</b>\n\n${chunk}`,
                parse_mode: "HTML"
            }).catch(err => console.log(`Telegram send error: ${err.message}`));
        }
        console.log(`📤 ${messages.length} segnali inviati`);
    } else {
        console.log(`😶 Nessun segnale questa volta`);
    }
}

// ==========================================
// AVVIO
// ==========================================
async function startBot() {
    console.log("🚀 Radar Blindato avviato...");

    const res = await axios.get(`${BASE}/v5/market/instruments-info`, {
        params: { category: "linear" }
    }).catch(err => {
        console.error("ERRORE instruments-info:", err.message);
        process.exit(1);
    });

    PAIRS = res.data.result.list
        .filter(p => p.quoteCoin === "USDT" && p.contractType === "LinearPerpetual" && p.status === "Trading")
        .map(p => p.symbol);

    console.log(`✅ Caricate ${PAIRS.length} coppie USDT Perpetual\n`);

    await scan();
    setInterval(scan, SCAN_INTERVAL);
}

startBot().catch(err => {
    console.error("ERRORE AVVIO:", err);
});
