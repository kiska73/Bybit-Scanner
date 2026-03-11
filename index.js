const axios = require('axios');

// ==========================================================================
// SNIPER ELITE v16.2 - ULTRA-FILTERED (Binance + Bybit Mandatory Alignment)
// ==========================================================================

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const SCAN_INTERVAL = 1000 * 60 * 45; 
const BASE_BYBIT   = "https://api.bybit.com";
const BASE_BINANCE = "https://fapi.binance.com";

async function scan() {
    console.log("🚀 Scansione Ultra-Filtrata in corso...");
    try {
        const tickersRes = await axios.get(`${BASE_BYBIT}/v5/market/tickers`, { params: { category: 'linear' } });
        const symbols = tickersRes.data.result.list.filter(t => parseFloat(t.turnover24h) > 5000000);

        for (const t of symbols) {
            const symbol = t.symbol;

            const binTopResp = await axios.get(`${BASE_BINANCE}/futures/data/topLongShortPositionRatio`, { params: { symbol, period: '1h', limit: 1 } }).catch(()=>null);
            const binGlobalResp = await axios.get(`${BASE_BINANCE}/futures/data/globalLongShortAccountRatio`, { params: { symbol, period: '1h', limit: 1 } }).catch(()=>null);
            const bybitRatioResp = await axios.get(`${BASE_BYBIT}/v5/market/account-ratio`, { params: { category: 'linear', symbol, period: '1h', limit: 1 } }).catch(()=>null);

            if (!binTopResp?.data?.[0] || !binGlobalResp?.data?.[0] || !bybitRatioResp?.data?.result?.list?.[0]) continue;

            const whaleLong = parseFloat(binTopResp.data[0].longAccount) * 100;
            const retailLong = parseFloat(binGlobalResp.data[0].longAccount) * 100;
            const binDiv = whaleLong - retailLong;

            const bybitRatio = parseFloat(bybitRatioResp.data.result.list[0].buyRatio);
            const bybitLongPct = (bybitRatio * 100);

            // --- 1. FILTRO DIREZIONALE OBBLIGATORIO (BYBIT DEVE ESSERE D'ACCORDO) ---
            const isAligned = (binDiv > 0 && bybitRatio > 0.52) || (binDiv < 0 && bybitRatio < 0.48);
            if (!isAligned) continue; // Se discordanti, scarta il segnale e passa alla prossima coin

            // --- 2. FILTRO "ELITE" (DIVERGENZA > 15% E SOGLIE ESTREME) ---
            const extremeWhales = whaleLong > 85 || whaleLong < 15;
            const extremeRetail = retailLong > 70 || retailLong < 30; // Retail spesso più bilanciato, ma cerchiamo sbilanciamento

            if (Math.abs(binDiv) > 15 || extremeWhales) {
                
                let title = binDiv > 0 ? "🚀 CARICO ESPLOSIVO LONG" : "🩸 CARICO ESPLOSIVO SHORT";
                let desc = `Divergenza Whale/Retail estrema (${Math.abs(binDiv).toFixed(1)}%). `;
                desc += `Binance e Bybit sono ALLINEATI. Le balene sono al ${whaleLong.toFixed(1)}%, situazione da monitorare per breakout imminente.`;

                const text = `<b>🧨 ${title}</b>\n#${symbol} @ ${t.lastPrice}\n\n` +
                             `📝 <b>ANALISI:</b>\n<i>${desc}</i>\n\n` +
                             `🐳 <b>WHALE (Bin):</b> <code>${whaleLong.toFixed(1)}%</code>\n` +
                             `👥 <b>RETAIL (Bin):</b> <code>${retailLong.toFixed(1)}%</code>\n` +
                             `📊 <b>BYBIT LONG:</b> <code>${bybitLongPct.toFixed(1)}%</code>\n\n` +
                             `✅ <b>CONFERMA CROSS-EXCHANGE OK</b>\n` +
                             `💸 <b>FUNDING:</b> <code>${(parseFloat(t.fundingRate)*100).toFixed(3)}%</code>`;

                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { 
                    chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" 
                }).catch(()=>{});
            }
        }
    } catch (e) { console.error("Errore:", e.message); }
    console.log("✅ Ciclo completato.");
}

setInterval(scan, SCAN_INTERVAL);
scan();
