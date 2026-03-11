const axios = require('axios');

// ==========================================================================
// 🎯 SNIPER ELITE v32.1 - THE STEALTH HAMMER (Anti-Rate Limit / 50 Min)
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

// --- CONFIGURAZIONE ---
const P_HIGH  = 95;
const P_LOW   = 5;
const PERIOD  = '1h';
const LIMIT   = 500;      
const MIN_LIFE = 500;     
const VOL_MIN = 2000000;  
const SCAN_INTERVAL = 1000 * 60 * 50; 

const BASE_BINANCE = "https://fapi.binance.com";
const BATCH_SIZE = 5;      // Ridotto per sicurezza (più lento, più sicuro)
const BATCH_DELAY = 2000;  // 2 secondi di pausa tra i blocchi

let scanning = false;

// Utility per la pausa
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function calculatePercentile(current, history) {
    const values = history.map(h => parseFloat(h.longShortRatio));
    const countBelow = values.filter(v => v <= current).length;
    return (countBelow / values.length) * 100;
}

async function scan() {
    if (scanning) return;
    scanning = true;

    const startTime = Date.now();

    try {
        console.log(`🚀 Scan "Stealth" avviato...`);
        const tickersRes = await axios.get(`${BASE_BINANCE}/fapi/v1/ticker/24hr`, { timeout: 10000 });

        const symbols = tickersRes.data
            .filter(t => parseFloat(t.quoteVolume) > VOL_MIN && t.symbol.endsWith('USDT'))
            .sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

        const premiumRes = await axios.get(`${BASE_BINANCE}/fapi/v1/premiumIndex`, { timeout: 10000 });
        const fundingMap = {};
        premiumRes.data.forEach(f => {
            fundingMap[f.symbol] = parseFloat(f.lastFundingRate);
        });

        // Elaborazione lenta e costante
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

                if (!topHist?.data || topHist.data.length < MIN_LIFE || !globHist?.data || globHist.data.length < MIN_LIFE) return;

                const curWhaleRatio = parseFloat(topHist.data[topHist.data.length - 1].longShortRatio);
                const curRetailRatio = parseFloat(globHist.data[globHist.data.length - 1].longShortRatio);

                if (!curWhaleRatio || !curRetailRatio) return;

                const whalePerc = calculatePercentile(curWhaleRatio, topHist.data);
                const retailPerc = calculatePercentile(curRetailRatio, globHist.data);

                const funding = fundingMap[symbol] ?? 0;
                let signalType = "";
                let side = "";

                if (whalePerc > P_HIGH && retailPerc < P_LOW) {
                    signalType = "DIVERGENZA LONG"; side = "LONG";
                } else if (whalePerc < P_LOW && retailPerc > P_HIGH) {
                    signalType = "DIVERGENZA SHORT"; side = "SHORT";
                } else if (whalePerc < P_LOW && retailPerc < P_LOW) {
                    signalType = "ESTREMO PANICO"; side = "LONG";
                } else if (whalePerc > P_HIGH && retailPerc > P_HIGH) {
                    signalType = "ESTREMO EUFORIA"; side = "SHORT";
                }

                if (signalType !== "") {
                    let fundingEmoji = side === "LONG" ? (funding <= 0 ? "✅" : "❌") : (funding >= 0 ? "✅" : "❌");
                    const text = `<b>${side === "LONG" ? "🚀" : "🩸"} ${signalType} (1H)</b>\n` +
                                 `#${symbol} @ ${parseFloat(t.lastPrice)}\n\n` +
                                 `📊 <b>PERCENTILLA (30gg):</b>\n` +
                                 `• Whale: <b>${whalePerc.toFixed(1)}%</b>\n` +
                                 `• Retail: <b>${retailPerc.toFixed(1)}%</b>\n\n` +
                                 `💸 <b>FUNDING:</b> <code>${(funding*100).toFixed(4)}%</code> ${fundingEmoji}`;

                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML"
                    }).catch(() => {});
                }
            }));

            // Pausa tattica tra un blocco e l'altro per il Rate Limit
            if (i + BATCH_SIZE < symbols.length) await sleep(BATCH_DELAY);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✅ Scan completato in ${duration}s su ${symbols.length} monete.`);
    } catch (e) {
        console.error("Errore Scan:", e.message);
    }
    scanning = false;
}

setInterval(scan, SCAN_INTERVAL);
scan();
