const axios = require('axios');

// ==========================================
// CONFIGURAZIONE
// ==========================================
const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SOGLIA_EXTREME = 90;     // ← soglia per eccesso retail (puoi alzare a 78-80 se vuoi meno segnali)

const LOOKBACK = 48;
const MIN_VOL  = 2000000;

const SCAN_INTERVAL = 1000 * 60 * 30; // 30 minuti
const BATCH_SIZE    = 20;             // più veloce
const BATCH_SLEEP   = 80;
// ==========================================

const BASE = "https://api.bybit.com";

let PAIRS = [];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ==========================================
// ANALISI SINGOLA COIN (SOLO RETAIL - TOP TRADER RIMOSSO)
// ==========================================
async function getSignal(symbol, tickerMap) {
    try {
        const resM = await axios.get(`${BASE}/v5/market/account-ratio`, {
            params: { category: 'linear', symbol, period: '1h', limit: LOOKBACK },
            timeout: 5000
        });

        const ticker = tickerMap.get(symbol);
        if (!ticker) return null;

        const mData = resM.data?.result?.list || [];
        if (mData.length === 0) return null;

        const vol24h = parseFloat(ticker.turnover24h);
        if (vol24h < MIN_VOL) return null;

        const ultimo = mData[0];
        const buyRatio  = parseFloat(ultimo.buyRatio  || 0);
        const sellRatio = parseFloat(ultimo.sellRatio || 0);

        return {
            symbol,
            price: parseFloat(ticker.lastPrice),
            fund: parseFloat(ticker.fundingRate) * 100,
            vol24h,
            buyRatio,
            sellRatio
        };

    } catch (err) {
        if (err.response?.status === 404) return null;
        console.log(`⚠️ ${symbol} errore`);
        return null;
    }
}

// ==========================================
// SCAN MERCATO
// ==========================================
async function scan() {
    const startTime = Date.now();
    console.log(`\n🚀 [${new Date().toLocaleTimeString()}] INIZIO SCAN - ${PAIRS.length} coppie`);

    const resTick = await axios.get(`${BASE}/v5/market/tickers`, {
        params: { category: 'linear' },
        timeout: 8000
    });

    const tickerMap = new Map(resTick.data.result.list.map(t => [t.symbol, t]));

    const highVolPairs = PAIRS.filter(s => {
        const t = tickerMap.get(s);
        return t && parseFloat(t.turnover24h || 0) >= MIN_VOL;
    });

    console.log(`📈 ${highVolPairs.length} coppie con volume ≥ 2M USDT\n`);

    let messages = [];

    for (let i = 0; i < highVolPairs.length; i += BATCH_SIZE) {
        const batch = highVolPairs.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(s => getSignal(s, tickerMap)));

        for (const data of results) {
            if (!data) continue;

            const { buyRatio, sellRatio } = data;

            console.log(
                `${data.symbol.padEnd(12)} | ` +
                `Retail BUY: ${(buyRatio*100).toFixed(1)}% | ` +
                `SELL: ${(sellRatio*100).toFixed(1)}% | ` +
                `Vol: ${(data.vol24h/1e6).toFixed(1)}M`
            );

            let type = "";
            if (buyRatio >= SOGLIA_EXTREME / 100) {
                type = "🚀 RETAIL EXTREME LONG (eccesso di long)";
            } else if (sellRatio >= SOGLIA_EXTREME / 100) {
                type = "⚠️ RETAIL EXTREME SHORT (eccesso di short)";
            }

            if (type) {
                messages.push(`
<b>${type}</b>
<b>Coppia:</b> ${data.symbol}
<b>Prezzo:</b> ${data.price}

🟠 Retail BUY: <b>${(buyRatio*100).toFixed(1)}%</b>
🟠 Retail SELL: <b>${(sellRatio*100).toFixed(1)}%</b>

💰 Funding: <b>${data.fund.toFixed(4)}%</b>
📊 Volume: <b>$${(data.vol24h / 1e6).toFixed(2)}M</b>
                `.trim());
            }
        }

        await sleep(BATCH_SLEEP);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ SCAN COMPLETATO in ${duration}s | Segnali trovati: ${messages.length}`);

    if (messages.length > 0) {
        for (let i = 0; i < messages.length; i += 5) {
            const chunk = messages.slice(i, i + 5).join("\n\n——————\n\n");
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: `<b>📊 REPORT RETAIL RATIO</b>\n\n${chunk}`,
                parse_mode: "HTML"
            });
        }
        console.log(`📤 ${messages.length} segnali inviati su Telegram`);
    } else {
        console.log(`😶 Nessun eccesso retail estremo questa volta`);
    }
}

// ==========================================
// AVVIO
// ==========================================
async function startBot() {
    console.log("🚀 Radar Blindato (solo Retail) avviato...");

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
