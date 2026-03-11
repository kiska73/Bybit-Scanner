const axios = require('axios');

// ==========================================================================
// 🎯 SNIPER ELITE v29.0 - THE UNBOUND SCANNER (No Age Limit / Full Vol >2M)
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const P_HIGH  = 90;   
const P_LOW   = 10;   
const PERIOD  = '1h';     
const LIMIT   = 720;      // Target 1 mese (720 ore)
const VOL_MIN = 2000000;  // Volume minimo 2M USDT
const SCAN_INTERVAL = 1000 * 60 * 30;

const BASE_BINANCE = "https://fapi.binance.com";
const BATCH_SIZE = 10;

let sentSignals = {};
let scanning = false;

// Calcolo Percentile dinamico (usa tutto lo storico che trova, da 1 a 720 ore)
function calculatePercentile(current, history) {
    const values = history.map(h => parseFloat(h.longShortRatio));
    const countBelow = values.filter(v => v < current).length;
    return (countBelow / values.length) * 100;
}

async function scan() {
    if (scanning) return;
    scanning = true;
    const startTime = Date.now();

    try {
        const tickersRes = await axios.get(`${BASE_BINANCE}/fapi/v1/ticker/24hr`, { timeout: 10000 });
        const symbols = tickersRes.data
            .filter(t => parseFloat(t.quoteVolume) > VOL_MIN && t.symbol.endsWith('USDT'))
            .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

        console.log(`🚀 Scan avviato su ${symbols.length} coppie (Vol > 2M)...`);

        const premiumRes = await axios.get(`${BASE_BINANCE}/fapi/v1/premiumIndex`, { timeout: 10000 });
        const fundingMap = {};
        premiumRes.data.forEach(f => { fundingMap[f.symbol] = parseFloat(f.lastFundingRate); });

        // Pulizia segnali (12h)
        const now = Date.now();
        Object.keys(sentSignals).forEach(sym => {
            if (now - sentSignals[sym] > 1000 * 60 * 60 * 12) delete sentSignals[sym];
        });

        for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
            const chunk = symbols.slice(i, i + BATCH_SIZE);

            await Promise.all(chunk.map(async (t) => {
                const symbol = t.symbol;

                const [topHist, globHist] = await Promise.all([
                    axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, {
                        params: { symbol, period: PERIOD, limit: LIMIT },
                        timeout: 10000
                    }).catch(() => null),
                    axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, {
                        params: { symbol, period: PERIOD, limit: LIMIT },
                        timeout: 10000
                    }).catch(() => null)
                ]);

                // Ora basta che ci sia ALMENO un dato (nessun limite di giorni)
                if (!topHist?.data?.length || !globHist?.data?.length) return;

                const curWhaleRatio = parseFloat(topHist.data[topHist.data.length - 1].longShortRatio);
                const curRetailRatio = parseFloat(globHist.data[globHist.data.length - 1].longShortRatio);

                const whalePerc = calculatePercentile(curWhaleRatio, topHist.data);
                const retailPerc = calculatePercentile(curRetailRatio, globHist.data);

                const funding = fundingMap[symbol] ?? 0;
                let signalType = "", side = "";

                if (whalePerc > P_HIGH && retailPerc < P_LOW) { signalType = "DIVERGENZA LONG"; side = "LONG"; }
                else if (whalePerc < P_LOW && retailPerc > P_HIGH) { signalType = "DIVERGENZA SHORT"; side = "SHORT"; }
                else if (whalePerc < P_LOW && retailPerc < P_LOW) { signalType = "ESTREMO PANICO"; side = "LONG"; }
                else if (whalePerc > P_HIGH && retailPerc > P_HIGH) { signalType = "ESTREMO EUFORIA"; side = "SHORT"; }

                if (signalType !== "") {
                    const nowTS = Date.now();
                    if (sentSignals[symbol] && (nowTS - sentSignals[symbol]) < 1000 * 60 * 60 * 6) return;
                    sentSignals[symbol] = nowTS;

                    let fundingEmoji = (side === "LONG") ? (funding <= 0.0001 ? "✅" : "❌") : (funding >= 0.0001 ? "✅" : "❌");
                    const emoji = side === "LONG" ? "🚀" : "🩸";

                    const text =
                        `<b>${emoji} ${signalType} (1H)</b>\n` +
                        `#${symbol} @ ${parseFloat(t.lastPrice)}\n\n` +
                        `📊 <b>PERCENTILLA (Storico ${topHist.data.length}h):</b>\n` +
                        `• 🐳 <b>Whales (Top 100):</b> <b>${whalePerc.toFixed(1)}%</b>\n` +
                        `• 👥 <b>Retail (Holders):</b> <b>${retailPerc.toFixed(1)}%</b>\n\n` +
                        `💸 <b>FUNDING:</b>\n` +
                        `${fundingEmoji} Rate: <code>${(funding * 100).toFixed(4)}%</code>\n\n` +
                        `🎯 <i>Check Bybit: se il trend è uguale, entra!</i>`;

                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML"
                    }).catch(() => {});
                }
            }));
        }
        console.log(`✅ Scan completato in ${((Date.now() - startTime) / 1000).toFixed(1)}s.`);
    } catch (e) { console.error("Errore Scan:", e.message); }
    scanning = false;
}

setInterval(scan, SCAN_INTERVAL);
scan();
