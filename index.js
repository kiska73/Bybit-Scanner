// BYBIT SQUEEZE SCANNER PRO V6
// Focus: leverage compression + imbalance

import axios from "axios";

const TELEGRAM_BOT_TOKEN = '6916198243:AAFTF66uLYSeqviL5YnfGtbUkSjTwPzah6s';
const TELEGRAM_CHAT_ID   = '820279313';

const BASE = "https://api.bybit.com";

let lastOI = {};

const REQUEST_DELAY_MS = 600;
const MAX_PARALLEL = 3;

//────────────────────

async function sendTelegram(msg){
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{
    chat_id: TELEGRAM_CHAT_ID,
    text: msg,
    parse_mode: "Markdown"
  });
}

function delay(ms){
  return new Promise(r=>setTimeout(r,ms));
}

//────────────────────

async function getPairs(){

  const res = await axios.get(`${BASE}/v5/market/instruments-info`,{
    params:{category:"linear"}
  });

  return res.data.result.list
  .filter(p=>p.quoteCoin==="USDT" && p.status==="Trading")
  .map(p=>p.symbol);

}

//────────────────────

async function getTicker(symbol){

  const res = await axios.get(`${BASE}/v5/market/tickers`,{
    params:{category:"linear",symbol}
  });

  return res.data.result.list[0];

}

//────────────────────

async function getKlines(symbol){

  const res = await axios.get(`${BASE}/v5/market/kline`,{
    params:{
      category:"linear",
      symbol,
      interval:"30",
      limit:12
    }
  });

  return res.data.result.list;

}

//────────────────────

async function getLongShortRatio(symbol){

  try{

    const res = await axios.get(`${BASE}/v5/market/account-ratio`,{
      params:{
        category:"linear",
        symbol,
        period:"30min",
        limit:1
      }
    });

    const d = res.data.result.list?.[0];
    if(!d) return 1;

    const buy=parseFloat(d.buyRatio);
    const sell=parseFloat(d.sellRatio);

    if(!buy || !sell) return 1;

    return buy/sell;

  }catch{
    return 1;
  }

}

//────────────────────

function classify(score){

  if(score>=20) return "🔥 NUCLEAR SQUEEZE";
  if(score>=16) return "🚀 HIGH PROBABILITY";
  if(score>=12) return "⚠️ BUILDING PRESSURE";

  return null;

}

//────────────────────

async function scanSymbol(symbol,signals){

  try{

    const ticker=await getTicker(symbol);

    const volume24h=parseFloat(ticker.turnover24h||0);
    if(volume24h<3000000) return;

    const klines=await getKlines(symbol);

    const oi=parseFloat(ticker.openInterest||0);
    const funding=parseFloat(ticker.fundingRate||0);

    const lastClose=parseFloat(klines[0][4]);

    const oiUsd=oi*lastClose;

    if(oiUsd<4000000) return;

    let oiChange=0;

    if(lastOI[symbol]){

      oiChange=((oi-lastOI[symbol])/lastOI[symbol])*100;

    }

    lastOI[symbol]=oi;

    if(oiChange<6) return;

    const oiVolumeRatio=oiUsd/volume24h;

    // Range compression

    const closes=klines.map(k=>parseFloat(k[4]));

    const high=Math.max(...closes);
    const low=Math.min(...closes);

    const mid=(high+low)/2;

    const range=((high-low)/mid)*100;

    if(range>1.6) return;

    const prevClose=closes[1]||lastClose;

    const priceChange=((lastClose-prevClose)/prevClose)*100;

    const lsr=await getLongShortRatio(symbol);

    let score=0;
    let bias="NEUTRAL";

    // OI change

    if(oiChange>20) score+=8;
    else if(oiChange>12) score+=5;
    else score+=3;

    // leverage ratio

    if(oiVolumeRatio>0.65) score+=6;
    else if(oiVolumeRatio>0.45) score+=4;
    else if(oiVolumeRatio>0.30) score+=2;

    // compression

    if(range<0.6) score+=5;
    else if(range<1) score+=3;

    // funding

    if(Math.abs(funding)>0.001) score+=3;
    else if(Math.abs(funding)>0.0006) score+=1;

    // long short imbalance

    if(lsr>3){

      score+=5;
      bias="SHORT";

    }

    else if(lsr<0.33){

      score+=5;
      bias="LONG";

    }

    else if(lsr>2){

      score+=2;
      bias="SHORT";

    }

    else if(lsr<0.5){

      score+=2;
      bias="LONG";

    }

    // trapped positions

    if(bias==="SHORT" && priceChange>0.5) score+=2;
    if(bias==="LONG" && priceChange<-0.5) score+=2;

    const quality=classify(score);

    if(!quality) return;

    signals.push({

      score,

      msg:`*${quality}* 🚨

*${symbol}* | ${bias}

Score: *${score}*

OI Δ: ${oiChange.toFixed(2)}%
OI/Vol: ${oiVolumeRatio.toFixed(2)}

Funding: ${funding.toFixed(5)}

Range 6h: ${range.toFixed(2)}%
Price Δ: ${priceChange.toFixed(2)}%

L/S Ratio: ${lsr.toFixed(2)}

${new Date().toLocaleTimeString("it-IT")}`

    });

  }

  catch(e){

    console.log(symbol,e.message);

  }

}

//────────────────────

async function scanner(){

  console.log("\nSCAN START",new Date().toLocaleString("it-IT"));

  const pairs=await getPairs();

  let signals=[];

  for(let i=0;i<pairs.length;i+=MAX_PARALLEL){

    const batch=pairs.slice(i,i+MAX_PARALLEL);

    await Promise.all(batch.map(s=>scanSymbol(s,signals)));

    await delay(REQUEST_DELAY_MS);

  }

  signals
  .sort((a,b)=>b.score-a.score)
  .slice(0,6)
  .forEach(s=>{

    console.log(s.msg.replace(/\*/g,""));
    sendTelegram(s.msg);

  });

}
