const axios = require('axios');

// ==========================================================================
// 🎯 SNIPER ELITE v23.0 - THE 500H GUARDIAN (Min 500h History & 2M Vol)
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

// --- CONFIGURAZIONE AGGIORNATA ---
const P_HIGH  = 90;   
const P_LOW   = 10;   
const MIN_HOURS = 500;    // Filtro: la moneta deve avere almeno 500 ore di storico
const VOL_MIN  = 2000000; // Volume minimo 2M USDT
const SCAN_INTERVAL = 1000 * 60 * 30; // Scan ogni 30 minuti

const BASE_BINANCE = "https://fapi.binance.com";
let sentSignals = {}; 

function calculatePercentile(current, history) {
    const values = history.map(h => parseFloat(h.longAccount));
    const countBelow = values.filter(v => v < current).length;
    return (countBelow / values.length) * 100;
}

async function scan() {
    console.log(`🚀 Scan 1H avviato... (Analisi su 500 ORE, Min Life 500h, Vol >2M)`);
    try {
        const tickersRes = await axios.get(`${BASE_BINANCE}/fapi/v1/ticker/24hr`);
        const symbols = tickersRes.data.filter(t => parseFloat(t.quoteVolume) > VOL_MIN && t.symbol.endsWith('USDT'));
        
        const premiumRes = await axios.get(`${BASE_BINANCE}/fapi/v1/premiumIndex`);
        const fundingData = premiumRes.data;

        for (const t of symbols) {
            const symbol = t.symbol;

            const [topHist, globHist] = await Promise.all([
                axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(()=>null),
                axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: 500 } }).catch(()=>null)
            ]);

            // --- FILTRO SICUREZZA 500 ORE ---
            if (!topHist?.data || topHist.data.length < MIN_HOURS || !globHist?.data || globHist.data.length < MIN_HOURS) {
                continue;
            }

            const curWhale = parseFloat(topHist.data[topHist.data.length - 1].longAccount);
            const curRetail = parseFloat(globHist.data[globHist.data.length - 1].longAccount);
            
            const whalePerc = calculatePercentile(curWhale, topHist.data);
            const retailPerc = calculatePercentile(curRetail, globHist.data);
            
            const fInfo = fundingData.find(f => f.symbol === symbol);
            const funding = fInfo ? parseFloat(fInfo.lastFundingRate) : 0;

            let signalType = "";
            let side = "";

            // LOGICA 90/10 RIGIDA
            if (whalePerc > P_HIGH && retailPerc < P_LOW) { signalType = "DIVERGENZA LONG"; side = "LONG"; }
            else if (whalePerc < P_LOW && retailPerc > P_HIGH) { signalType = "DIVERGENZA SHORT"; side = "SHORT"; }
            else if (whalePerc < P_LOW && retailPerc < P_LOW) { signalType = "ESTREMO PANICO"; side = "LONG"; }
            else if (whalePerc > P_HIGH && retailPerc > P_HIGH) { signalType = "ESTREMO EUFORIA"; side = "SHORT"; }

            if (signalType !== "") {
                const now = Date.now();
                if (sentSignals[symbol] && (now - sentSignals[symbol]) < 1000 * 60 * 60 * 4) continue;
                sentSignals[symbol] = now;

                let fundingEmoji = (side === "LONG") ? (funding <= 0.0001 ? "✅" : "❌") : (funding >= 0.0001 ? "✅" : "❌");

                const emoji = side === "LONG" ? "🚀" : "🩸";
                const text = `<b>${emoji} ${signalType} (1H)</b>\n` +
                             `#${symbol} @ ${parseFloat(t.lastPrice)}\n\n` +
                             `📊 <b>PERCENTILLA (500 ORE):</b>\n` +
                             `• Whale: <b>${whalePerc.toFixed(1)}%</b>\n` +
                             `• Retail: <b>${retailPerc.toFixed(1)}%</b>\n\n` +
                             `💸 <b>FUNDING BINANCE:</b>\n` +
                             `${fundingEmoji} Rate: <code>${(funding * 100).toFixed(4)}%</code>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { 
                    chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" 
                }).catch(()=>{});
            }
        }
    } catch (e) { console.error("Errore:", e.message); }
    console.log("✅ Scan terminato.");
}

setInterval(scan, SCAN_INTERVAL);
scan();
