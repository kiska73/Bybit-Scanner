const axios = require('axios');

// ==========================================================================
// 🎯 SNIPER ELITE v27.0 - THE GLOBAL MIRROR (Binance vs Bybit Alignment)
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

// --- CONFIGURAZIONE CHIRURGICA ---
const P_HIGH  = 90;   
const P_LOW   = 10;   
const PERIOD  = '1h';     
const LIMIT   = 720;      // 30 Giorni esatti per la statistica (720 ore)
const MIN_LIFE = 720;     // Esclude monete con meno di 1 mese di vita
const VOL_MIN = 2000000;  
const SCAN_INTERVAL = 1000 * 60 * 30; 

const BASE_BINANCE = "https://fapi.binance.com";
let sentSignals = {}; 

function calculatePercentile(current, history) {
    const values = history.map(h => parseFloat(h.longShortRatio));
    const countBelow = values.filter(v => v < current).length;
    return (countBelow / values.length) * 100;
}

async function scan() {
    console.log(`🚀 Scan Mirroring in corso... Analisi 30gg (720h)`);
    try {
        const tickersRes = await axios.get(`${BASE_BINANCE}/fapi/v1/ticker/24hr`);
        const symbols = tickersRes.data.filter(t => parseFloat(t.quoteVolume) > VOL_MIN && t.symbol.endsWith('USDT'));
        
        const premiumRes = await axios.get(`${BASE_BINANCE}/fapi/v1/premiumIndex`);
        const fundingData = premiumRes.data;

        for (const t of symbols) {
            const symbol = t.symbol;

            // Chiamate ai due indicatori che vedi nel grafico di Bybit:
            const [topHist, globHist] = await Promise.all([
                // 1. TOP TRADER (Le Balene - Grafico superiore su Bybit)
                axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: PERIOD, limit: LIMIT } }).catch(()=>null),
                // 2. LONG-SHORT ACCOUNT (Il Retail/Holders - Grafico inferiore su Bybit)
                axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: PERIOD, limit: LIMIT } }).catch(()=>null)
            ]);

            if (!topHist?.data || topHist.data.length < MIN_LIFE || !globHist?.data || globHist.data.length < MIN_LIFE) continue;

            const curWhaleRatio = parseFloat(topHist.data[topHist.data.length - 1].longShortRatio);
            const curRetailRatio = parseFloat(globHist.data[globHist.data.length - 1].longShortRatio);
            
            const whalePerc = calculatePercentile(curWhaleRatio, topHist.data);
            const retailPerc = calculatePercentile(curRetailRatio, globHist.data);
            
            const fInfo = fundingData.find(f => f.symbol === symbol);
            const funding = fInfo ? parseFloat(fInfo.lastFundingRate) : 0;

            let signalType = "";
            let side = "";

            // LOGICA 90/10 PERFETTA
            if (whalePerc > P_HIGH && retailPerc < P_LOW) { signalType = "DIVERGENZA LONG"; side = "LONG"; }
            else if (whalePerc < P_LOW && retailPerc > P_HIGH) { signalType = "DIVERGENZA SHORT"; side = "SHORT"; }
            else if (whalePerc < P_LOW && retailPerc < P_LOW) { signalType = "ESTREMO PANICO"; side = "LONG"; }
            else if (whalePerc > P_HIGH && retailPerc > P_HIGH) { signalType = "ESTREMO EUFORIA"; side = "SHORT"; }

            if (signalType !== "") {
                const now = Date.now();
                if (sentSignals[symbol] && (now - sentSignals[symbol]) < 1000 * 60 * 60 * 6) continue;
                sentSignals[symbol] = now;

                let fundingEmoji = (side === "LONG") ? (funding <= 0.0001 ? "✅" : "❌") : (funding >= 0.0001 ? "✅" : "❌");

                const emoji = side === "LONG" ? "🚀" : "🩸";
                const text = `<b>${emoji} ${signalType} (1H)</b>\n` +
                             `#${symbol} @ ${parseFloat(t.lastPrice)}\n\n` +
                             `📊 <b>PERCENTILLA BINANCE (30gg):</b>\n` +
                             `• 🐳 <b>TOP 100 Traders:</b> <b>${whalePerc.toFixed(1)}%</b>\n` +
                             `• 👥 <b>Global Accounts:</b> <b>${retailPerc.toFixed(1)}%</b>\n\n` +
                             `💸 <b>FUNDING:</b>\n` +
                             `${fundingEmoji} Rate: <code>${(funding * 100).toFixed(4)}%</code>\n\n` +
                             `🎯 <i>Check Bybit: Se i valori sono allineati, il segnale è TOP!</i>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { 
                    chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" 
                }).catch(()=>{});
            }
        }
    } catch (e) { console.error("Errore:", e.message); }
}

setInterval(scan, SCAN_INTERVAL);
scan();
