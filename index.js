const axios = require('axios');

// ==========================================================================
// SNIPER ELITE v16.1 - CROSS-EXCHANGE DIRECTIONAL (Binance + Bybit)
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SCAN_INTERVAL = 1000 * 60 * 45; 
const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";

async function scan() {
    console.log("🚀 Inizio scansione cross-exchange...");
    try {
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' } });
        const symbols = tickersRes.data.result.list.filter(t => parseFloat(t.turnover24h) > 4000000);

        for (const t of symbols) {
            const symbol = t.symbol;

            // 1. Dati Binance (Whale vs Retail)
            const binTopResp = await axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: 1 } }).catch(()=>null);
            const binGlobalResp = await axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: 1 } }).catch(()=>null);
            
            // 2. Dati Bybit (Account Ratio)
            const bybitRatioResp = await axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: 1 } }).catch(()=>null);

            if (!binTopResp?.data?.[0] || !binGlobalResp?.data?.[0] || !bybitRatioResp?.data?.result?.list?.[0]) continue;

            // Calcolo Divergenza Binance
            const whaleLong = parseFloat(binTopResp.data[0].longAccount) * 100;
            const retailLong = parseFloat(binGlobalResp.data[0].longAccount) * 100;
            const binDiv = whaleLong - retailLong;

            // Calcolo Sentiment Bybit
            const bybitRatio = parseFloat(bybitRatioResp.data.result.list[0].buyRatio);
            const bybitLongPct = (bybitRatio * 100);

            // --- TRIGGER: Divergenza Binance > 10% ---
            if (Math.abs(binDiv) > 10) {
                const side = binDiv > 0 ? "LONG" : "SHORT";
                const isAligned = (binDiv > 0 && bybitRatio > 0.5) || (binDiv < 0 && bybitRatio < 0.5);
                
                // --- COSTRUZIONE MESSAGGIO NARRATIVO ---
                let title = ""; let emoji = ""; let desc = "";
                const divAbs = Math.abs(binDiv).toFixed(1);

                if (binDiv > 0) {
                    title = `💣 CARICO ESPLOSIVO 📈 (Long)`;
                    emoji = "🧨";
                    desc = `Divergenza Whale/Retail su Binance del ${divAbs}%. Le balene stanno caricando mentre il retail shorta.`;
                } else {
                    title = `💣 CARICO ESPLOSIVO 📉 (Short)`;
                    emoji = "🧨";
                    desc = `Divergenza Whale/Retail su Binance del ${divAbs}%. Le balene stanno distribuendo pesantemente mentre il retail compra.`;
                }

                if (isAligned) {
                    desc += ` Bybit conferma il movimento con un sentiment allineato (${bybitLongPct.toFixed(1)}% Long).`;
                } else {
                    desc += ` Attenzione: Bybit al momento è DISCORDANTE (${bybitLongPct.toFixed(1)}% Long). Possibile manipolazione o ritardo.`;
                }

                const statusEmoji = isAligned ? "✅ ALLINEATO" : "⚠️ DISCORDANZA";

                const text = `<b>${emoji} ${title}</b>\n#${symbol} @ ${t.lastPrice}\n\n` +
                             `📝 <b>ANALISI:</b>\n<i>${desc}</i>\n\n` +
                             `🐳 <b>BINANCE DIV:</b> <code>${binDiv > 0 ? '+' : ''}${binDiv.toFixed(1)}%</code>\n` +
                             `📊 <b>BYBIT SENTIMENT:</b> <code>${statusEmoji}</code>\n\n` +
                             `👥 <b>DETTAGLI:</b>\n` +
                             `• Binance Whales: ${whaleLong.toFixed(1)}%\n` +
                             `• Binance Retail: ${retailLong.toFixed(1)}%\n` +
                             `• Bybit Long Ratio: ${bybitLongPct.toFixed(1)}%\n` +
                             `• Funding Rate: <code>${(parseFloat(t.fundingRate)*100).toFixed(3)}%</code>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { 
                    chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" 
                }).catch(()=>{});
            }
        }
    } catch (e) { console.error("Errore Scan:", e.message); }
    console.log("✅ Ciclo completato.");
}

setInterval(scan, SCAN_INTERVAL);
scan();
