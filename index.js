const axios = require('axios');

// ==========================================
// CONFIGURAZIONE
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SOGLIA_ALTA  = 60;  // Abbassata per più segnali
const SOGLIA_BASSA = 40;

const LOOKBACK = 48;
const MIN_VOL  = 2000000;

const SCAN_INTERVAL = 1000 * 60 * 30; // 30 minuti
// ==========================================

const BASE = "https://api.bybit.com";

let PAIRS_WITH_RATIO = [];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getPosition(current, history) {
    const values = history.map(v => parseFloat(v));
    const max = Math.max(...values);
    const min = Math.min(...values);
    if (max === min) return 50;
    return ((current - min) / (max - min)) * 100;
}

// ==========================================
// TROVA COPPIE CON RATIO DISPONIBILE
// ==========================================
async function getPairsWithRatio(allPairs) {
    console.log("🔎 Ricerca coppie con ratio disponibile...");
    let supported = [];
    for (let i = 0; i < allPairs.length; i++) {
        const symbol = allPairs[i];
        try {
            await axios.get(`${BASE}/v5/market/account-ratio`, {
                params: { category: 'linear', symbol, period: '1h', limit: 1 },
                timeout: 4000
            });
            supported.push(symbol);
        } catch (err) {
            if (err.response && err.response.status !== 404) {
                console.log(`Errore su ${symbol}`);
            }
        }
        await sleep(80); // evita rate limit
    }
    console.log(`✅ Coppie con ratio disponibile: ${supported.length}`);
    return supported;
}

// ==========================================
// ANALISI SINGOLA COIN
// ==========================================
async function getSignal(symbol) {
    try {
        const [resM, resT, resTick] = await Promise.all([
            axios.get(`${BASE}/v5/market/account-ratio`, {
                params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK },
                timeout: 5000
            }),
            axios.get(`${BASE}/v5/market/top-trader-account-ratio`, {
                params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK },
                timeout: 5000
            }),
            axios.get(`${BASE}/v5/market/tickers`, {
                params: { category: 'linear', symbol },
                timeout: 5000
            })
        ]);

        const ticker = resTick.data.result?.list?.[0];
        if (!ticker) return null;

        const vol24h = parseFloat(ticker.turnover24h);
        if (vol24h < MIN_VOL) return null;

        const mData = resM.data.result?.list;
        const tData = resT.data.result?.list;
        if (!mData?.length || !tData?.length) return null;

        const currentM = parseFloat(mData[0].accountRatio);
        const currentT = parseFloat(tData[0].topTraderAccountRatio);

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
        if (err.response && err.response.status === 404) return null;
        console.log(`⚠️ ${symbol} errore`);
        return null;
    }
}

// ==========================================
// SCAN MERCATO
// ==========================================
async function scan() {
    console.log(`\n--- [${new Date().toLocaleTimeString()}] Analisi ${PAIRS_WITH_RATIO.length} coppie ---`);
    let messages = [];

    for (let i = 0; i < PAIRS_WITH_RATIO.length; i += 5) {
        const batch = PAIRS_WITH_RATIO.slice(i, i + 5);
        const results = await Promise.all(batch.map(s => getSignal(s)));

        for (const data of results) {
            if (!data) continue;

            // 🔹 log per debug e leggibilità
            console.log(
                `${data.symbol} | Top: ${data.posT.toFixed(0)}% | Retail: ${data.posM.toFixed(0)}% | Vol: ${(data.vol24h/1000000).toFixed(1)}M`
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

🟡 Top Trader: <b>${data.posT.toFixed(0)}%</b>
🟠 Retail: <b>${data.posM.toFixed(0)}%</b>

💰 Funding: <b>${data.fund.toFixed(4)}%</b>
📊 Volume: <b>$${(data.vol24h / 1000000).toFixed(2)}M</b>
                `.trim());
            }
        }

        await sleep(200);
    }

    console.log(`Segnali trovati: ${messages.length}`);

    if (messages.length > 0) {
        for (let i = 0; i < messages.length; i += 5) {
            const chunk = messages.slice(i, i + 5).join("\n\n——————\n\n");
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: `<b>📊 REPORT RATIO</b>\n\n${chunk}`,
                parse_mode: "HTML"
            });
        }
        console.log(`✅ ${messages.length} segnali inviati`);
    }
}

// ==========================================
// AVVIO BOT
// ==========================================
async function startBot() {
    console.log("🚀 Radar Blindato avviato...");

    const res = await axios.get(`${BASE}/v5/market/instruments-info`, {
        params: { category: "linear" }
    });

    const allPairs = res.data.result.list
        .filter(p =>
            p.quoteCoin === "USDT" &&
            p.contractType === "LinearPerpetual" &&
            p.status === "Trading"
        )
        .map(p => p.symbol);

    console.log(`Totale coppie USDT perpetual: ${allPairs.length}`);

    PAIRS_WITH_RATIO = await getPairsWithRatio(allPairs);

    console.log(`Scanner attivo su ${PAIRS_WITH_RATIO.length} coppie`);

    await scan();

    setInterval(scan, SCAN_INTERVAL);
}

startBot();
