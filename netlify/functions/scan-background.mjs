// netlify/functions/scan-background.mjs
//
// Server-side copy of the ForexSim "Warm Up" + scoring, for the trading bot.
// Runs as a Netlify BACKGROUND function (name ends in -background), which is
// allowed up to 15 minutes — needed because TwelveData's free tier only allows
// 8 credits/minute per key, so a full scan takes a few minutes.
//
// What it does (forex only — no gold, metals or crypto):
//   1. Pulls 1W, 1D, 4H and 1H candles for the 28 forex pairs (15m is skipped:
//      the bot only trades off the 1H score, and 1H reads 4H/1D/1W for its
//      higher-timeframe points, so those are the only ones needed).
//   2. Runs the SAME scoring math as watchlist/index.html (sma + computeAnalysis,
//      copied across unchanged — do not "fix" anything in here without also
//      changing the website, or the two will drift apart).
//   3. Saves the 1H result (picks scoring 80+) to Netlify Blobs, where
//      /api/signals (signals.mjs) serves it to the MT5 bot.
//
// The AI Momentum Read / ai-analyze.js is NOT used anywhere in this file.
//
// Environment variables (Netlify -> Site configuration -> Environment variables):
//   TWELVEDATA_KEYS  comma-separated TwelveData keys (use NEW ones, not the old
//                    ones that were in index.html)
//   SIGNALS_TOKEN    any long random string; the scheduler sends it to this
//                    function and the MT5 bot sends it to /api/signals

import { getStore } from "@netlify/blobs";

/* ---------------- assets (same pair list/order as the watchlist) ---------------- */
const FX_CCY_ORDER = ['EUR','GBP','AUD','NZD','USD','CAD','CHF','JPY'];

function buildForexAssets(){
  const list = [];
  for (let i=0;i<FX_CCY_ORDER.length;i++){
    for (let j=i+1;j<FX_CCY_ORDER.length;j++){
      const base = FX_CCY_ORDER[i], quote = FX_CCY_ORDER[j];
      const cls = (base==='USD'||quote==='USD') ? 'Forex · Major' : 'Forex · Cross';
      list.push({ sym: base+quote, tdSymbol: `${base}/${quote}`, cls });
    }
  }
  return list;
}
const ASSETS = buildForexAssets();

/* ---------------- constants (same values as the watchlist) ---------------- */
const FETCH_OUTPUTSIZE = 1500;
const BATCH_SIZE = 8; // TwelveData free tier: 8 credits/minute, 1 credit per symbol
const EXNESS_SERVER_TIMEZONE = 'Europe/Bucharest';
const TD_INTERVAL = {'1h':'1h','4h':'4h','1d':'1day','1w':'1week'};
const TF_ORDER = ['1w','1d','4h','1h']; // higher timeframes first (1H reads them)
const PARENT_TF = {'1h':'4h','4h':'1d','1d':'1w','1w':'1w'};
const MAJOR_SR_TF = {'1h':'1d','4h':'1d','1d':'1w','1w':'1w'};
const TRENDING_SIGNALS = ['Bullish Cross','Bearish Cross','Trend Active','Trend Established','Pullback Setup'];
const MIN_SCORE_TO_PUBLISH = 80;
const RUN_BUDGET_MS = 13.5 * 60 * 1000; // stay safely under the 15 min limit

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function mulberry32(seed){
  return function(){
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s){
  let h = 1779033703 ^ s.length;
  for(let i=0;i<s.length;i++){
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

/* ---------------- SCORING MATH — copied from watchlist/index.html ---------------- */
function sma(series, period){
  const out = new Array(series.length).fill(null);
  let sum = 0;
  for(let i=0;i<series.length;i++){
    sum += series[i];
    if (i>=period) sum -= series[i-period];
    if (i>=period-1) out[i] = sum/period;
  }
  const firstVal = out[period-1];
  for(let i=0;i<period-1;i++) out[i] = firstVal;
  return out;
}

// `snaps[tf][sym]` replaces the browser's loadSnapshot(tf).data[sym]
function computeAnalysis(asset, tf, epoch, closes, snaps){
  if (!closes || closes.length < 55){
    return { noData:true, signal:'No Data', confidence:0, direction:'flat',
      support:0, resistance:0, barsSinceCross:null, invalidated:false, last:0 };
  }
  const e10 = sma(closes, 10);
  const e50 = sma(closes, 50);
  const n = closes.length;
  const last = n-1;

  const diff = closes.map((_,i)=> e10[i]-e50[i]);

  let crossIdx = -1;
  for(let i=last;i>50;i--){
    if (Math.sign(diff[i]) !== Math.sign(diff[i-1]) && Math.sign(diff[i-1]) !== 0){
      crossIdx = i; break;
    }
  }
  const direction = diff[last] >= 0 ? 'bullish' : 'bearish';
  const barsSinceCross = crossIdx >=0 ? (last - crossIdx) : null;

  const lookback = 15;
  let alignedMoves = 0, total = 0;
  for(let i=last-lookback+1;i<=last;i++){
    if (i<=0) continue;
    total++;
    const moveUp = closes[i] > closes[i-1];
    if ((direction==='bullish' && moveUp) || (direction==='bearish' && !moveUp)) alignedMoves++;
  }
  const consistency = total ? alignedMoves/total : 0.5;

  const trMoves = [];
  for(let i=last-13;i<=last;i++){ if(i>0) trMoves.push(Math.abs(closes[i]-closes[i-1])); }
  const sortedTr = [...trMoves].sort((a,b)=>a-b);
  const medianTr = sortedTr.length ? sortedTr[Math.floor(sortedTr.length/2)] : 0;
  const GAP_MULTIPLIER = 3;
  const gapFiltered = medianTr > 0 ? trMoves.filter(m => m <= medianTr*GAP_MULTIPLIER) : trMoves;
  const usedMoves = gapFiltered.length >= trMoves.length - 2 ? gapFiltered : trMoves;
  const trueRangeSum = usedMoves.reduce((s,m)=>s+m, 0);
  const atrProxy = (usedMoves.length ? trueRangeSum/usedMoves.length : 0) || 1e-9;
  const emaGapATR = Math.abs(diff[last]) / atrProxy;

  const priceToE10 = Math.abs(closes[last]-e10[last]) / atrProxy;
  const priceToE50 = Math.abs(closes[last]-e50[last]) / atrProxy;
  const nearEma = Math.min(priceToE10, priceToE50) < 0.9;

  const srWindow = closes.slice(Math.max(0,last-40), last-2);
  const localResistance = srWindow.length ? Math.max(...srWindow) : closes[last]*1.01;
  const localSupport = srWindow.length ? Math.min(...srWindow) : closes[last]*0.99;

  let resistance = localResistance, support = localSupport, srAvailable = false;
  const srTf = MAJOR_SR_TF[tf];
  if (srTf && srTf !== tf){
    const srR = snaps[srTf] ? snaps[srTf][asset.sym] : null;
    if (srR && !srR.noData && Number.isFinite(srR.resistance) && Number.isFinite(srR.support)){
      srAvailable = true;
      resistance = srR.resistance;
      support = srR.support;
    }
  }

  const half = Math.floor(srWindow.length/2) || 1;
  const firstHalf = srWindow.slice(0, half);
  const secondHalf = srWindow.slice(half);
  const fhHigh = firstHalf.length?Math.max(...firstHalf):closes[last];
  const fhLow = firstHalf.length?Math.min(...firstHalf):closes[last];
  const shHigh = secondHalf.length?Math.max(...secondHalf):closes[last];
  const shLow = secondHalf.length?Math.min(...secondHalf):closes[last];
  let structure = 'Sideways / Range-bound';
  if (shHigh > fhHigh && shLow > fhLow) structure = 'Higher Highs / Higher Lows';
  else if (shHigh < fhHigh && shLow < fhLow) structure = 'Lower Highs / Lower Lows';

  const gapNow = Math.abs(diff[last]);
  const gapPrior = Math.abs(diff[Math.max(0, last-8)]);
  const convergenceRatio = gapPrior > 1e-9 ? gapNow/gapPrior : 1;
  const isConverging = crossIdx === null
    && convergenceRatio < 0.65
    && emaGapATR > 0.15 && emaGapATR < 0.9;
  const approachDirection = diff[last] < 0 ? 'bullish' : 'bearish';

  function rng_local(){ return mulberry32(hashStr(asset.sym+tf+epoch+'r'))(); }

  let signal, emaConfidence;
  const rangeCondition = emaGapATR < 0.35 && crossIdx===null && !isConverging;
  if (crossIdx === null && isConverging){
    signal = approachDirection === 'bullish' ? 'Approaching Bullish Cross' : 'Approaching Bearish Cross';
    emaConfidence = Math.round(40 + (1-convergenceRatio)*35 + Math.min(emaGapATR*10,10));
  } else if (crossIdx === null){
    signal = rangeCondition ? 'Range' : 'Watching';
    emaConfidence = rangeCondition ? Math.round(20 + rng_local()*10) : Math.round(30 + emaGapATR*15);
  } else if (barsSinceCross <= 2){
    signal = direction==='bullish' ? 'Bullish Cross' : 'Bearish Cross';
    emaConfidence = Math.round(50 + Math.min(consistency*30,30) + Math.min(emaGapATR*10,10));
  } else if (nearEma && barsSinceCross > 4){
    signal = 'Pullback Setup';
    emaConfidence = Math.round(45 + consistency*25);
  } else if (barsSinceCross > 25 && consistency > 0.55){
    signal = 'Trend Established';
    emaConfidence = Math.round(55 + consistency*25 + Math.min(emaGapATR*8,10));
  } else if (barsSinceCross > 2){
    signal = 'Trend Active';
    emaConfidence = Math.round(50 + consistency*25 + Math.min(emaGapATR*8,10));
  } else {
    signal = 'Watching';
    emaConfidence = Math.round(35 + consistency*15);
  }
  emaConfidence = Math.max(5, Math.min(97, emaConfidence));

  const priceVsE10 = closes[last] - e10[last];
  const priceAgreesWithDirection = (direction==='bullish' && priceVsE10 >= 0)
                                 || (direction==='bearish' && priceVsE10 <= 0);
  const invalidated = !priceAgreesWithDirection && TRENDING_SIGNALS.includes(signal);

  let freshnessPts;
  if (invalidated) freshnessPts = 0;
  else if (signal==='Bullish Cross' || signal==='Bearish Cross') freshnessPts = 2;
  else if (TRENDING_SIGNALS.includes(signal)) freshnessPts = 1;
  else freshnessPts = 0;

  let structurePts;
  const bullStruct = structure === 'Higher Highs / Higher Lows';
  const bearStruct = structure === 'Lower Highs / Lower Lows';
  if ((direction==='bullish' && bullStruct) || (direction==='bearish' && bearStruct)) structurePts = 2;
  else if (!bullStruct && !bearStruct) structurePts = 1;
  else structurePts = 0;

  const roomDistance = direction==='bullish' ? (resistance - closes[last]) : (closes[last] - support);
  const roomRatio = roomDistance / atrProxy;
  const roomPctOfPrice = roomDistance / closes[last];
  function getRoomThreshold(cls){
    if (cls === 'Forex · Major') return 0.0010;
    if (cls === 'Forex · Cross') return 0.0012;
    return 0.0015;
  }
  const MIN_ROOM_PCT = getRoomThreshold(asset.cls);
  let roomPts;
  if (roomRatio > 2 && roomPctOfPrice > MIN_ROOM_PCT) roomPts = 2;
  else if (roomRatio > 0.7 && roomPctOfPrice > MIN_ROOM_PCT * 0.5) roomPts = 1;
  else roomPts = 0;

  let htfPts = 1;
  const parentTf = PARENT_TF[tf];
  if (parentTf && parentTf !== tf){
    const htfR = snaps[parentTf] ? snaps[parentTf][asset.sym] : null;
    if (htfR && !htfR.noData){
      const htfTrending = TRENDING_SIGNALS.includes(htfR.signal);
      if (htfTrending && htfR.direction === direction) htfPts = 2;
      else if (!htfTrending) htfPts = 1;
      else htfPts = 0;
    }
  }

  let emaPts = emaConfidence >= 70 ? 2 : (emaConfidence >= 50 ? 1 : 0);
  if (emaGapATR > 5.0) emaPts = Math.max(0, emaPts - 2);
  else if (emaGapATR > 3.0) emaPts = Math.max(0, emaPts - 1);

  const scoreTotal = freshnessPts + structurePts + roomPts + htfPts + emaPts;
  const confidence = scoreTotal * 10;

  return {
    noData: false, last: closes[last],
    signal, confidence, direction, structure,
    support, resistance, barsSinceCross, invalidated, srAvailable
  };
}
/* ---------------- end of copied scoring math ---------------- */

function tzParamFor(interval){
  return (interval === '1day' || interval === '1week') ? '' : `&timezone=${encodeURIComponent(EXNESS_SERVER_TIMEZONE)}`;
}

async function fetchBatch(key, tdSymbols, interval){
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbols.join(','))}&interval=${interval}&outputsize=${FETCH_OUTPUTSIZE}&order=ASC&apikey=${key}${tzParamFor(interval)}`;
  const res = await fetch(url);
  const creditsLeft = res.headers.get('api-credits-left');
  const json = await res.json();
  return { json, creditsLeft };
}

export default async (req) => {
  const secret = process.env.SIGNALS_TOKEN || '';
  if (!secret || req.headers.get('x-scan-secret') !== secret) {
    return new Response('forbidden', { status: 403 });
  }

  const store = getStore('forexsim');
  const startedAt = Date.now();
  const keys = (process.env.TWELVEDATA_KEYS || '').split(',').map(s=>s.trim()).filter(Boolean);
  const log = [];

  if (!keys.length) {
    await store.setJSON('status', { at: startedAt, ok: false, message: 'TWELVEDATA_KEYS is not set' });
    return new Response('no keys', { status: 200 });
  }

  // one task per (timeframe, batch of 8 pairs)
  const tasks = [];
  for (const tf of TF_ORDER) {
    for (let i = 0; i < ASSETS.length; i += BATCH_SIZE) {
      tasks.push({ tf, assets: ASSETS.slice(i, i + BATCH_SIZE), attempts: 0 });
    }
  }
  const totalTasks = tasks.length;
  const closesBy = {}; TF_ORDER.forEach(tf => closesBy[tf] = {});
  const dead = keys.map(() => false);
  const creditsLeft = keys.map(() => null);

  // one worker per key, each paced to one call per 61s (8 credits/min limit)
  async function worker(k) {
    let lastCall = 0;
    while (tasks.length) {
      if (dead[k] || Date.now() - startedAt > RUN_BUDGET_MS) return;
      const task = tasks.shift();
      if (!task) return;
      const wait = lastCall + 61000 - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      try {
        const { json, creditsLeft: left } = await fetchBatch(keys[k], task.assets.map(a => a.tdSymbol), TD_INTERVAL[task.tf]);
        if (left !== null) creditsLeft[k] = parseInt(left, 10);
        if (json && json.status === 'error') {
          const msg = json.message || 'TwelveData error';
          log.push(`key#${k+1} ${task.tf}: ${msg}`);
          if (/minute/i.test(msg)) { // temporary per-minute limit: retry later
            if (++task.attempts < 3) tasks.push(task);
            continue;
          }
          if (/day|daily/i.test(msg)) { // this key is out for today
            dead[k] = true; tasks.push(task); return;
          }
          continue; // some other error: skip this batch
        }
        for (const a of task.assets) {
          const entry = task.assets.length === 1 ? json : json[a.tdSymbol];
          if (entry && entry.status !== 'error' && Array.isArray(entry.values)) {
            closesBy[task.tf][a.sym] = entry.values.map(v => parseFloat(v.close));
          } else {
            log.push(`${a.sym} ${task.tf}: no data`);
          }
        }
      } catch (e) {
        log.push(`key#${k+1} ${task.tf}: ${e.message}`);
        if (++task.attempts < 3) tasks.push(task);
      }
    }
  }
  await Promise.all(keys.map((_, k) => worker(k)));

  // if any whole timeframe came back empty, don't publish anything
  const missingTf = TF_ORDER.filter(tf => Object.keys(closesBy[tf]).length === 0);
  if (missingTf.length) {
    await store.setJSON('status', {
      at: Date.now(), ok: false,
      message: `Scan incomplete — no data for: ${missingTf.join(', ')}. Old signals left untouched.`,
      log: log.slice(-20), creditsLeft
    });
    return new Response('incomplete', { status: 200 });
  }

  // analyse in order 1w -> 1d -> 4h -> 1h so higher timeframes exist when 1h reads them
  const epoch = Date.now();
  const snaps = {};
  for (const tf of TF_ORDER) {
    snaps[tf] = {};
    for (const asset of ASSETS) {
      snaps[tf][asset.sym] = computeAnalysis(asset, tf, epoch, closesBy[tf][asset.sym], snaps);
    }
  }

  const all = [];
  const picks = [];
  ASSETS.forEach((asset, order) => {
    const r = snaps['1h'][asset.sym];
    const hasAllTf = TF_ORDER.every(tf => snaps[tf][asset.sym] && !snaps[tf][asset.sym].noData);
    all.push({ sym: asset.sym, score: r.confidence, direction: r.direction, signal: r.signal, invalidated: !!r.invalidated, complete: hasAllTf });
    if (!hasAllTf || r.noData || r.invalidated) return;
    if (!TRENDING_SIGNALS.includes(r.signal)) return;
    if (r.confidence < MIN_SCORE_TO_PUBLISH) return;
    picks.push({
      sym: asset.sym,
      side: r.direction === 'bullish' ? 'BUY' : 'SELL',
      score: r.confidence,
      signal: r.signal,
      barsSinceCross: r.barsSinceCross,
      order
    });
  });

  // best first: higher score, then fresher cross, then watchlist order
  picks.sort((a, b) =>
    (b.score - a.score) ||
    ((a.barsSinceCross ?? 999) - (b.barsSinceCross ?? 999)) ||
    (a.order - b.order));

  await store.setJSON('latest', { generatedAt: Date.now(), timeframe: '1h', picks, all });
  await store.setJSON('status', {
    at: Date.now(), ok: true,
    message: `Scan complete: ${picks.length} qualifying pick(s) from ${ASSETS.length} pairs in ${Math.round((Date.now()-startedAt)/1000)}s (${totalTasks} calls).`,
    log: log.slice(-20), creditsLeft
  });
  return new Response('done', { status: 200 });
};
