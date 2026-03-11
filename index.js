const axios = require('axios');

// ==========================================================================
// 🎯 SNIPER ELITE v19.1 - THE DAILY SIGNAL (Binance 1D + Funding Info)
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const P_HIGH  = 90;   
const P_LOW   = 10;   
const SCAN_INTERVAL = 1000 * 60 * 60; 

const BASE_BINANCE = "https://fapi.binance.com";
let sentSignals = {}; 

function calculatePercentile(current, history) {
    const values = history.map(h => parseFloat(h.longAccount));
    const countBelow = values.filter(v => v < current).length;
    return (countBelow / values.length) * 100;
}

async function scan() {
    console.log(`🚀 Scan DAILY... Filtri: >${P_HIGH}% e <${P_LOW}%`);
    try {
        const tickersRes = await axios.get(`${BASE_BINANCE}/fapi/v1/ticker/24hr`);
        const symbols = tickersRes.data.filter(t => parseFloat(t.quoteVolume) > 10000000 && t.symbol.endsWith('USDT'));

        // Prendi tutti i funding rate in una volta sola per efficienza
        const premiumRes = await axios.get(`${BASE_BINANCE}/fapi/v1/premiumIndex`);
        const fundingData = premiumRes.data;

        for (const t of symbols) {
            const symbol = t.symbol;

            const [topHist, globHist] = await Promise.all([
                axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1d', limit: 500 } }).catch(()=>null),
                axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1d', limit: 500 } }).catch(()=>null)
            ]);

            if (!topHist?.data?.length || !globHist?.data?.length) continue;

            const curWhale = parseFloat(topHist.data[topHist.data.length - 1].longAccount);
            const curRetail = parseFloat(globHist.data[globHist.data.length - 1].longAccount);
            const whalePerc = calculatePercentile(curWhale, topHist.data);
            const retailPerc = calculatePercentile(curRetail, globHist.data);
            
            // Recupero Funding specifico
            const fInfo = fundingData.find(f => f.symbol === symbol);
            const funding = fInfo ? parseFloat(fInfo.lastFundingRate) : 0;

            let signalType = "";
            let side = "";

            if (whalePerc > P_HIGH && retailPerc < P_LOW) { signalType = "DIVERGENZA LONG"; side = "LONG"; }
            else if (whalePerc < P_LOW && retailPerc > P_HIGH) { signalType = "DIVERGENZA SHORT"; side = "SHORT"; }
            else if (whalePerc < P_LOW && retailPerc < P_LOW) { signalType = "ESTREMO PANICO"; side = "LONG"; }
            else if (whalePerc > P_HIGH && retailPerc > P_HIGH) { signalType = "ESTREMO EUFORIA"; side = "SHORT"; }

            if (signalType !== "") {
                const now = Date.now();
                if (sentSignals[symbol] && (now - sentSignals[symbol]) < 1000 * 60 * 60 * 12) continue;
                sentSignals[symbol] = now;

                // Logica Semaforo Funding
                let fundingEmoji = "⚪"; 
                if (side === "LONG") {
                    fundingEmoji = funding <= 0.0001 ? "✅" : "❌"; // Negativo o basso è ottimo per Long
                } else {
                    fundingEmoji = funding >= 0.0001 ? "✅" : "❌"; // Positivo è ottimo per Short
                }

                const emoji = side === "LONG" ? "🚀" : "🩸";
                const text = `<b>${emoji} ${signalType} (1D)</b>\n` +
                             `#${symbol} @ ${parseFloat(t.lastPrice)}\n\n` +
                             `📊 <b>PERCENTILLA (500 Giorni):</b>\n` +
                             `• Whale: <b>${whalePerc.toFixed(1)}%</b>\n` +
                             `• Retail: <b>${retailPerc.toFixed(1)}%</b>\n\n` +
                             `👥 <b>VALORI ATTUALI:</b>\n` +
                             `• Whales: <code>${(curWhale * 100).toFixed(1)}%</code>\n` +
                             `• Retail: <code>${(curRetail * 100).toFixed(1)}%</code>\n\n` +
                             `💸 <b>FUNDING BINANCE:</b>\n` +
                             `${fundingEmoji} Rate: <code>${(funding * 100).toFixed(4)}%</code>\n\n` +
                             `🔍 <i>Controlla Bybit per la conferma finale.</i>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { 
                    chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" 
                }).catch(()=>{});
            }
        }
    } catch (e) { console.error("Errore:", e.message); }
}

setInterval(scan, SCAN_INTERVAL);
scan();
