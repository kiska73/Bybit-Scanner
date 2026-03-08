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
// ANALISI SINGOLA COIN (senza più controllo volume)
// ==========================================
async function getSignal(symbol, tickerMap) {
    try {
        const [resM, resT] = await Promise.all([
            axios.get(`${BASE}/v5/market/account-ratio`, {
                params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK },
                timeout: 5000
            }),
            axios.get(`${BASE}/v5/market/top-trader-account-ratio`, {
                params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK },
                timeout: 5000
            })
        ]);

        const ticker = tickerMap.get(symbol);
        if (!ticker) return null;

        const mData = resM.data.result?.list;
        const tData = resT.data.result?.list;
        if (!mData?.length || !tData?.length) return null;

        const currentM = parseFloat(mData[0].accountRatio);
        const currentT = parseFloat(tData[0].topTraderAccountRatio);
        const vol24h = parseFloat(ticker.turnover24h);

        return {
            symbol,
            price: parseFloat(ticker.lastPrice),
            fund: parseFloat(ticker.fundingRate) * 100,
            vol24h,
            posM: getPosition(currentM, mData.map(x => x.accountRatio)),
            posT: getPosition(currentT, tData.map(x => x.topTraderAccountRatio)),
            currentM,
            currentT
        };

    } catch (err) {
        if (err.response?.status === 404) return null;
        console.log(`⚠️ ${symbol} errore API`);
        return null;
    }
}

// ==========================================
// SCAN MERCATO (con log dettagliati)
// ==========================================
async function scan() {
    const startTime = Date.now();
    console.log(`\n🚀 [${new Date().toLocaleTimeString()}] INIZIO SCAN - ${PAIRS.length} coppie totali`);

    // 1. Tutti i ticker in UNA chiamata
    const resTick = await axios.get(`${BASE}/v5/market/tickers`, {
        params: { category: 'linear' },
        timeout: 8000
    });

    const tickerMap = new Map(resTick.data.result.list.map(t => [t.symbol, t]));

    // 2. Filtra solo le coppie con volume sufficiente
    const highVolPairs = PAIRS.filter(symbol => {
        const ticker = tickerMap.get(symbol);
        return ticker && parseFloat(ticker.turnover24h || 0) >= MIN_VOL;
    });

    const skipped = PAIRS.length - highVolPairs.length;
    console.log(`📈 ${highVolPairs.length} coppie con volume > 2M USDT`);
    console.log(`⏭️  ${skipped} coppie skippate per volume troppo basso\n`);

    let messages = [];

    // 3. Analisi a batch
    for (let i = 0; i < highVolPairs.length; i += BATCH_SIZE) {
        const batch = highVolPairs.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(s => getSignal(s, tickerMap)));

        for (const data of results) {
            if (!data) continue;

            // LOG DETTAGLIATO - ecco cosa trovi!
            console.log(
                `${data.symbol.padEnd(12)} | ` +
                `Top: ${data.posT.toFixed(0)}% (${data.currentT.toFixed(3)}) | ` +
                `Retail: ${data.posM.toFixed(0)}% (${data.currentM.toFixed(3)}) | ` +
                `Vol: ${(data.vol24h/1000000).toFixed(1)}M`
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
📊 Volume: <b>$${(data.vol24h / 1000000).toFixed(2)}M</b>
                `.trim());
            }
        }

        await sleep(BATCH_SLEEP);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ SCAN COMPLETATO in ${duration}s | Analizzate: ${highVolPairs.length} | Segnali: ${messages.length}`);

    // Invio Telegram
    if (messages.length > 0) {
        for (let i = 0; i < messages.length; i += 5) {
            const chunk = messages.slice(i, i + 5).join("\n\n——————\n\n");
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: `<b>📊 REPORT RATIO</b>\n\n${chunk}`,
                parse_mode: "HTML"
            });
        }
        console.log(`📤 ${messages.length} segnali inviati su Telegram`);
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
    });

    PAIRS = res.data.result.list
        .filter(p => p.quoteCoin === "USDT" && p.contractType === "LinearPerpetual" && p.status === "Trading")
        .map(p => p.symbol);

    console.log(`✅ Caricate ${PAIRS.length} coppie USDT Perpetual\n`);

    await scan();
    setInterval(scan, SCAN_INTERVAL);
}

startBot();
