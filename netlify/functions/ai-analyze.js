// netlify/functions/ai-analyze.js
//
// Server-side only. Reads the Gemini API key from an environment variable
// (Netlify: Site configuration -> Environment variables -> GEMINI_API_KEY)
// so the key is never present in index.html or sent to the browser.
//
// Supports up to 5 keys for the "Analyze All" batch feature (build t), so
// several assets can be analyzed in parallel instead of queuing on one key's
// rate limit. Slot 0 = GEMINI_API_KEY (the original single key — always
// required). Slots 1-4 = GEMINI_API_KEY_2 / _3 / _4 / _5 (all optional). A
// single "Run AI Read" click always uses slot 0. Add GEMINI_API_KEY_2.._5 in
// Netlify whenever you have more keys — no code change needed for that part;
// the frontend's Analyze All batcher probes all 5 slots and self-adjusts to
// however many are actually configured.
//
// This matches the exact request/response contract runAiMomentumRead() /
// analyzeAllAssets() in index.html already expect — no frontend changes
// needed for this swap.
// Request body:  { symbol, timeframe, signal, direction, confidence, last,
//                  ema10, ema50, support, resistance, srAvailable, structure,
//                  closesRecent, ohlcRecent, swingHighs, swingLows,
//                  trendline, higherTimeframe, tradingProfile, keySlot }
// Response body: { stage, reasoning, confidence, stopLoss, takeProfit, rr, targetFit }  (or { error })
// stopLoss/takeProfit/rr (build v): the model's own price levels, derived from
// the same support/resistance/structure/swing/trendline data it already reads
// for the stage call — not a separate rule-based calculation. rr is the
// resulting reward:risk ratio the model computed from its own two levels, so
// the frontend never has to re-derive it. All three are null when the rule-
// based direction is 'neutral'/'none' (no directional trade to size a stop/
// target around) or when the model declines to give a level.
// targetFit (build w): a one-sentence proportionality gut-check against
// Folarin's fixed lot size + modest per-trade/daily $ goal (sent in
// tradingProfile) — never changes stopLoss/takeProfit, just flags when a
// setup would need an outsized move or hold to matter at his size, so the
// goal informs the read without warping it. Null when tradingProfile wasn't
// sent, or when there's no directional stopLoss/takeProfit to judge.
//
// build y: removed Fibonacci reasoning entirely (fibLevels field, prompt
// section, and the fib fallback step in the stop/target ordering) and named
// geometric chart patterns (head & shoulders etc.) are now explicitly told
// to reason from, per Folarin's request. In its place, "higherTimeframe" now
// carries a genuinely higher timeframe's own ema10/ema50/support/resistance
// (sourced from MAJOR_SR_TF in index.html — e.g. 1d for a 1h read — not just
// the next timeframe step up), and the prompt enforces a MANDATORY TOP-DOWN
// ORDER: major support/resistance first, then that higher timeframe's EMA10
// vs EMA50 relationship/strength, then its overall direction, and only then
// the current timeframe's own OHLC price action / EMA cross / structure as
// confluence against that bigger picture.
//
// If Google has renamed/retired the model string below by the time you set
// this up, this is the one line to change — check "Rate Limit" in Google AI
// Studio (aistudio.google.com) for a "Text-out models" row with a real
// (non-zero) RPM number, then confirm its exact API string via that model's
// card/model-picker page before pasting it in here.
const GEMINI_MODEL = 'gemini-3.5-flash-lite';

const STAGES = ['Extending', 'Cooling', 'Exhausted', 'Reversing'];
const KEY_ENV_VARS = ['GEMINI_API_KEY', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY_3', 'GEMINI_API_KEY_4', 'GEMINI_API_KEY_5'];

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let p;
  try {
    p = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const keySlot = Number.isInteger(p.keySlot) ? p.keySlot : 0;
  if (keySlot < 0 || keySlot >= KEY_ENV_VARS.length) {
    return { statusCode: 400, body: JSON.stringify({ error: `keySlot must be 0-${KEY_ENV_VARS.length - 1}.` }) };
  }
  const envVarName = KEY_ENV_VARS[keySlot];
  // .trim() defensively strips stray whitespace/newlines that sometimes ride
  // along when a key is copied out of Google AI Studio and pasted into
  // Netlify's env var UI — a trailing "\n" silently breaks the ?key= query
  // string and Google responds with a confusing generic 401
  // ("Expected OAuth 2 access token...") instead of "bad key".
  const apiKey = (process.env[envVarName] || '').trim();
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `${envVarName} is not set in this site's environment variables.` })
    };
  }
  const required = ['symbol', 'timeframe', 'signal', 'direction', 'confidence', 'last', 'ema10', 'ema50', 'support', 'resistance', 'structure', 'closesRecent'];
  const missing = required.filter(k => p[k] === undefined || p[k] === null);
  if (missing.length) {
    return { statusCode: 400, body: JSON.stringify({ error: `Missing fields: ${missing.join(', ')}` }) };
  }

  // ohlcRecent/swingHighs/swingLows/trendline are all optional (build t) — an
  // older frontend build or a payload for an asset with too little history to
  // compute swings will simply omit them, and the prompt below degrades
  // gracefully to closes-only reasoning in that case.
  const hasOhlc = Array.isArray(p.ohlcRecent) && p.ohlcRecent.length > 0;
  const hasSwings = (Array.isArray(p.swingHighs) && p.swingHighs.length) || (Array.isArray(p.swingLows) && p.swingLows.length);
  const hasTrendline = p.trendline && typeof p.trendline === 'object';
  const hasTradingProfile = p.tradingProfile && typeof p.tradingProfile === 'object';

  const systemInstruction = `You read momentum for a swing trader on one asset at a time.
Reply with STRICT JSON only, matching this shape, nothing else:
{"stage": "Extending" | "Cooling" | "Exhausted" | "Reversing", "reasoning": "...", "confidence": <integer 0-100>,
 "stopLoss": <number> | null, "takeProfit": <number> | null, "rr": <number> | null, "targetFit": <string> | null}

The four stages are a repeating lifecycle, not a one-way path:
Extending -> Cooling -> Exhausted -> Reversing -> back to Extending (in the new direction).

- Extending: the current move still has clean momentum — candle bodies still full-size, price
  still making fresh highs/lows in its direction, not badly overstretched from its short EMA yet.
- Cooling: momentum is decelerating but hasn't broken down — shrinking candle bodies, longer
  wicks, choppier action. Not a reversal by itself, just "this push is running out of gas."
- Exhausted: the move has stalled — no fresh highs/lows for several bars, compressing range.
- Reversing: structure has actually started flipping against the prior trend — treat this as an
  early "pay attention, a new trend may be starting" flag, not a dead end. Only call this if
  there's a real break of the last swing high/low, not just a deeper-than-usual pullback still
  inside the old range.

You're given the asset's existing rule-based read (signal/direction/confidence from a 10/50 EMA
cross system), current EMAs, support/resistance, market structure, and up to the last 60 bars.

CANDLE DATA: when "ohlcRecent" is provided, each entry is {o,h,l,c} for one bar, oldest first —
this is REAL open/high/low/close data, not inferred. Use it directly to judge candle body size
(|c-o| relative to recent average) and wick length (h-max(o,c) and min(o,c)-l) — a shrinking body
with growing wicks is real deceleration evidence; a full body closing near its high/low with small
wicks is real continuation evidence. If "ohlcRecent" is absent or empty, only "closesRecent" (a
plain list of closes) is available — in that case do NOT claim to see candle bodies or wicks, since
you cannot; reason from close-to-close movement and volatility instead, and say so if it materially
limits your confidence.

CANDLESTICK PATTERN CHECK (mandatory when "ohlcRecent" is provided): explicitly check the last 5
bars — not just generic body/wick trend — against these exact definitions before you finalize your
stage call. Don't skip this because nothing looked interesting at a glance; run the check every
time, on every asset, the same way:
- Bullish engulfing: bar[i] closes bearish (c<o), bar[i+1] closes bullish (c>o) AND bar[i+1]'s body
  fully contains bar[i]'s body (bar[i+1].o < bar[i].c and bar[i+1].c > bar[i].o). Bearish engulfing
  is the mirror image.
- Pin bar / hammer (bullish): one wick at least 2x the body length, on the LOWER side
  (min(o,c)-l >= 2*|c-o|), small upper wick, appearing after a down move. Shooting star (bearish) is
  the mirror: long upper wick, small lower wick, appearing after an up move.
- Doji: body is very small relative to the bar's full range (|c-o| < ~10% of (h-l)) — indecision,
  not directional evidence by itself, but two or more in a row after an extended move supports
  Cooling/Exhausted.
If one of these actually appears in the last 5 bars, name it plainly in "reasoning" and weigh it
the way a real chart-reader would (a bullish engulfing or hammer at support is real evidence toward
Extending/Reversing-up; the bearish mirrors toward the downside). If none appear, don't invent one —
say the recent candles don't show a clean named pattern and reason from body/wick trend alone
instead, exactly as the paragraph above already describes.

When present, "swingHighs" and "swingLows" are actual recent pivot prices (local
turning points), most recent last — use these as the real reference points for "has price made a
fresh high/low" and "where would a break of structure actually occur," instead of guessing from
raw closes. When present, "trendline" gives {type, slope, level} — a rough linear fit through the
last 2-3 relevant swing points (support trendline under an uptrend's swing lows, or resistance
trendline over a downtrend's swing highs) and its current price level. Treat price still holding
on the correct side of that level as support for Extending/Cooling; a clean close through it, in
the direction that breaks the trend, is meaningful evidence toward Reversing (more meaningful the
more decisively it broke, less meaningful if it's a single small poke through).

Support/resistance reliability matters: if "srAvailable" is true, those levels were confirmed
against a wider multi-timeframe window and should be weighted heavily — treat a bounce or rejection
there as meaningful. If "srAvailable" is false, those are a same-timeframe local fallback only —
still useful, but hold them more loosely and don't treat a small poke through a local level as
a big deal the way you would at a major zone.

MANDATORY TOP-DOWN ORDER: do this in the order below, every time, before you name a stage. Don't
jump straight to the current timeframe's price action.
1. HIGHER TIMEFRAME STRUCTURE FIRST: if "higherTimeframe" is present, it is a genuinely higher
   timeframe (e.g. this call is 1h, higherTimeframe is 1d) — not just the next step up. Start there.
   Read its "support"/"resistance" as the MAJOR zones for this asset right now — these outrank
   anything the current timeframe's own local support/resistance can tell you.
2. HIGHER TIMEFRAME EMA: look at higherTimeframe's "ema10" vs "ema50" — which is on top, and how
   wide the gap is relative to price (a wide gap = strong established pressure in that direction, a
   narrow/converging gap = weak or fading pressure, possibly compressing toward a cross).
3. HIGHER TIMEFRAME DIRECTION: from higherTimeframe's "direction"/"structure"/EMA relationship,
   settle on whether the bigger picture is bullish or bearish (or genuinely range-bound/unclear) —
   state this plainly in "reasoning" before moving on. If higherTimeframe is null, no cached
   higher-timeframe read was available — say so and reason from the current timeframe alone.
4. MID TIMEFRAME STRUCTURE: if "parentTimeframe" is present, it is the timeframe immediately above
   the current one (e.g. this call is 1h, parentTimeframe is 4h) — a nearer-term structural check
   that sits between the higher timeframe's big picture and the current timeframe's own action. Look
   at its "structure" and "direction" as a second, more immediate confirmation layer: does the
   near-term structure agree with the higher-timeframe direction from step 3, or is it already
   showing signs of pausing/turning before the current timeframe does? Weigh this as more current
   than the higher timeframe but still more reliable than the current timeframe alone. If
   parentTimeframe is null (either not cached, or it coincides with higherTimeframe for this
   timeframe), skip this step and rely on steps 1-3 plus the current timeframe alone.
5. CURRENT TIMEFRAME CONFLUENCE: only now bring in the current timeframe's own evidence — real OHLC
   price action (candle bodies/wicks/patterns as above), the current EMA10/EMA50 cross state, current
   market structure, and current support/resistance (weighted per "srAvailable") — and judge how it
   lines up with the reads from steps 1-4. Current-timeframe action that agrees with the bigger-
   picture direction is your strongest evidence; current-timeframe action that fights it is more
   likely a pullback/pause within the bigger trend than a real reversal, unless it's actually
   breaking the higher timeframe's own major structure (step 1) — in which case give it real weight.

CROSS CONFIRMATION: if higherTimeframe.signal is "Bullish Cross" or "Bearish Cross" and its
"barsSinceCross" is small (a fresh cross, roughly 0-3 bars old), do not treat it as confirmed yet —
a cross by itself is not the same as the move actually following through. Advise waiting for the
move to actually confirm itself before treating the setup as ready: several small-bodied/choppy
follow-through bars in the cross's direction, fewer medium-sized decisive bars, or a single strong
full-bodied bar closing convincingly in that direction, are all valid confirmation — judge which of
those you're actually seeing in the higher timeframe's own recent candles (or the current timeframe's
"ohlcRecent" if that's the closest data you have to it) rather than picking a fixed bar count. Say
this plainly in "reasoning" (e.g. "the daily cross is only 1 bar old — wait for it to follow through
with real continuation before treating this as confirmed" ) rather than silently ignoring a fresh,
unconfirmed cross. Do not phrase this in pips — pip size varies too much across forex, metals, and
crypto to be a fair unit here; reason in terms of candle count and candle conviction instead. Once
barsSinceCross is larger (the cross has had time to either follow through or fail), reason about it
normally as an established trend rather than something still needing confirmation.

Do not reason using named geometric chart patterns (head and shoulders, triangles, flags, wedges,
double tops/bottoms, Fibonacci retracements, or similar) — none of that data is provided and none of
it should be invented. Your only structural inputs are the real support/resistance, EMA values,
swing highs/lows, trendline, and OHLC candle data actually given to you above and below.

Weigh all of this together — the top-down order above, plus real candle texture and structure/
trendline data, should move your confidence more than the bare rule-based numbers alone, since
they're the actual evidence a human chart-reader would look at. "confidence" is YOUR confidence in
the stage call (0-100), independent of the rule-based confidence you were given. Keep "reasoning" to
2-4 short sentences, plain language, for someone learning to read charts — walk through the higher-
timeframe read first, then the current-timeframe confluence, referencing the actual numbers/levels
you were given rather than vague generalities. Never claim certainty — this is a probabilistic read,
not a guarantee.

STOP LOSS / TAKE PROFIT: give your own honest, discerning price levels — this is your point of
view on where the trade would actually be invalidated and where it would realistically pay off,
not a fixed formula. Base it on the real structure you were given, in this order of preference:
the nearest relevant swing high/low beyond a small buffer, then the trendline level if one was
given, then support/resistance (weighted per srAvailable as above, and preferring the higher
timeframe's major zone over a local one when both are in play), only falling back to a rough
percentage-of-price distance if none of that structure is usable. If direction is 'buy': stopLoss
belongs below the nearest structural floor, takeProfit at or just before the nearest structural
ceiling. If direction is 'sell': mirror that (stop above structure, target below it). Set both to
null if direction is neutral/none/flat, or if the current stage is Reversing with no clear fresh
structure yet to anchor a level to (say so in "reasoning" rather than inventing a number). Compute
"rr" yourself as the reward:risk ratio implied by your own two levels relative to "last" (reward =
|takeProfit - last|, risk = |last - stopLoss|, rr = reward/risk, rounded to 1 decimal) — null
whenever either level is null. If a level you'd otherwise pick sits unrealistically close to
"last" (inside typical noise for this timeframe), say so and widen it rather than handing back a
stop that would get clipped by normal chop. These are your own judgment call, clearly labeled as
probabilistic in "reasoning" when relevant — never state a stop or target as a guarantee.

TARGET FIT (only when "tradingProfile" is provided): this trader uses a small, FIXED position size
on every trade (given in "fixedSizeNote" below) and is aiming for a modest, realistic per-trade
profit ("perTradeTargetUSD") toward a small daily goal ("dailyTargetUSD") — he is NOT asking you to
resize the stop/target to hit that dollar figure, and you must never let it distort the structural
stopLoss/takeProfit you already picked above. Its only job is a second, independent gut-check: given
the realistic distance to your takeProfit and how this instrument/timeframe typically moves, would
banking a small, modest gain at this fixed size require an unusually large price swing or an
unusually long hold to get there, or is it a normal, quickly-reachable move for this setup? You do
not have this trader's exact pip/contract value, so don't invent a dollar figure — reason
proportionally instead (e.g. "this move is a small fraction of the recent range, well within normal
reach" vs. "this would need a much bigger move than this pair/timeframe typically makes in one
push"). Set "targetFit" to a short one-sentence verdict in that spirit, or null if tradingProfile
wasn't provided, or if stopLoss/takeProfit are both null. Be honest when a setup looks like it would
need to be forced or overheld to matter at this size — say so plainly rather than softening it, the
same way you'd flag a level that's too close and would get clipped by chop.`;

  const ohlcLine = hasOhlc
    ? `Last ${p.ohlcRecent.length} bars (OHLC, oldest first): ${JSON.stringify(p.ohlcRecent)}`
    : `OHLC data: not provided this call — reasoning about candle bodies/wicks is not possible, closes only.`;
  const swingLine = hasSwings
    ? `Recent swing highs: ${JSON.stringify(p.swingHighs || [])} | Recent swing lows: ${JSON.stringify(p.swingLows || [])}`
    : `Swing highs/lows: not provided this call.`;
  const trendlineLine = hasTrendline
    ? `Trendline: ${JSON.stringify(p.trendline)}`
    : `Trendline: not provided this call.`;
  const tradingProfileLine = hasTradingProfile
    ? `Trader's sizing/goal context: ${JSON.stringify(p.tradingProfile)}`
    : `Trader's sizing/goal context: not provided this call — leave targetFit null.`;

  const userContent = `Symbol: ${p.symbol}
Timeframe: ${p.timeframe}
Rule-based signal: ${p.signal} (${p.direction}, ${p.confidence}% confidence)
Last price: ${p.last}
EMA10: ${p.ema10}
EMA50: ${p.ema50}
Support: ${p.support} (srAvailable: ${!!p.srAvailable})
Resistance: ${p.resistance} (srAvailable: ${!!p.srAvailable})
Market structure: ${p.structure}
Last ${Array.isArray(p.closesRecent) ? p.closesRecent.length : 0} closes: ${JSON.stringify(p.closesRecent)}
${ohlcLine}
${swingLine}
${trendlineLine}
Higher timeframe context (major structure — see MANDATORY TOP-DOWN ORDER above): ${p.higherTimeframe ? JSON.stringify(p.higherTimeframe) : 'null (not cached)'}
Parent timeframe context (nearer-term structure — see step 4 above): ${p.parentTimeframe ? JSON.stringify(p.parentTimeframe) : 'null (not cached, or same as higher timeframe)'}
${tradingProfileLine}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userContent }] }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          stage: { type: 'STRING', enum: STAGES },
          reasoning: { type: 'STRING' },
          confidence: { type: 'INTEGER' },
          stopLoss: { type: 'NUMBER', nullable: true },
          takeProfit: { type: 'NUMBER', nullable: true },
          rr: { type: 'NUMBER', nullable: true },
          targetFit: { type: 'STRING', nullable: true }
        },
        required: ['stage', 'reasoning', 'confidence', 'stopLoss', 'takeProfit', 'rr', 'targetFit']
      }
    }
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const text = await res.text();
    if (!res.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: `Gemini API error (${res.status}): ${text.slice(0, 300)}` }) };
    }

    const json = JSON.parse(text);
    const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      return { statusCode: 502, body: JSON.stringify({ error: 'No content returned by Gemini.' }) };
    }

    // responseSchema should make this already-clean JSON, but strip code
    // fences defensively in case the model wraps it anyway.
    const cleaned = raw.replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!STAGES.includes(parsed.stage) || typeof parsed.reasoning !== 'string') {
      return { statusCode: 502, body: JSON.stringify({ error: 'Model returned an unexpected shape.' }) };
    }

    const confidence = Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(100, Math.round(parsed.confidence))) : 50;
    // stopLoss/takeProfit/rr (build v): pass through only if the model gave real
    // finite numbers; anything else (missing, null, NaN, a stray string) collapses
    // to null rather than letting a malformed value reach the frontend.
    const stopLoss = Number.isFinite(parsed.stopLoss) ? parsed.stopLoss : null;
    const takeProfit = Number.isFinite(parsed.takeProfit) ? parsed.takeProfit : null;
    const rr = Number.isFinite(parsed.rr) ? Math.round(parsed.rr * 10) / 10 : null;
    const targetFit = typeof parsed.targetFit === 'string' && parsed.targetFit.trim() ? parsed.targetFit.trim() : null;

    return {
      statusCode: 200,
      body: JSON.stringify({ stage: parsed.stage, reasoning: parsed.reasoning, confidence, stopLoss, takeProfit, rr, targetFit })
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: e.message || 'Unknown error calling Gemini.' }) };
  }
};// netlify/functions/ai-analyze.js
//
// Server-side only. Reads the Gemini API key from an environment variable
// (Netlify: Site configuration -> Environment variables -> GEMINI_API_KEY)
// so the key is never present in index.html or sent to the browser.
//
// Supports up to 5 keys for the "Analyze All" batch feature (build t), so
// several assets can be analyzed in parallel instead of queuing on one key's
// rate limit. Slot 0 = GEMINI_API_KEY (the original single key — always
// required). Slots 1-4 = GEMINI_API_KEY_2 / _3 / _4 / _5 (all optional). A
// single "Run AI Read" click always uses slot 0. Add GEMINI_API_KEY_2.._5 in
// Netlify whenever you have more keys — no code change needed for that part;
// the frontend's Analyze All batcher probes all 5 slots and self-adjusts to
// however many are actually configured.
//
// This matches the exact request/response contract runAiMomentumRead() /
// analyzeAllAssets() in index.html already expect — no frontend changes
// needed for this swap.
// Request body:  { symbol, timeframe, signal, direction, confidence, last,
//                  ema10, ema50, support, resistance, srAvailable, structure,
//                  closesRecent, ohlcRecent, swingHighs, swingLows,
//                  trendline, higherTimeframe, tradingProfile, keySlot }
// Response body: { stage, reasoning, confidence, stopLoss, takeProfit, rr, targetFit }  (or { error })
// stopLoss/takeProfit/rr (build v): the model's own price levels, derived from
// the same support/resistance/structure/swing/trendline data it already reads
// for the stage call — not a separate rule-based calculation. rr is the
// resulting reward:risk ratio the model computed from its own two levels, so
// the frontend never has to re-derive it. All three are null when the rule-
// based direction is 'neutral'/'none' (no directional trade to size a stop/
// target around) or when the model declines to give a level.
// targetFit (build w): a one-sentence proportionality gut-check against
// Folarin's fixed lot size + modest per-trade/daily $ goal (sent in
// tradingProfile) — never changes stopLoss/takeProfit, just flags when a
// setup would need an outsized move or hold to matter at his size, so the
// goal informs the read without warping it. Null when tradingProfile wasn't
// sent, or when there's no directional stopLoss/takeProfit to judge.
//
// If Google has renamed/retired the model string below by the time you set
// this up, this is the one line to change — check "Rate Limit" in Google AI
// Studio (aistudio.google.com) for a "Text-out models" row with a real
// (non-zero) RPM number, then confirm its exact API string via that model's
// card/model-picker page before pasting it in here.
const GEMINI_MODEL = 'gemini-3.5-flash-lite';

const STAGES = ['Extending', 'Cooling', 'Exhausted', 'Reversing'];
const KEY_ENV_VARS = ['GEMINI_API_KEY', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY_3', 'GEMINI_API_KEY_4', 'GEMINI_API_KEY_5'];

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let p;
  try {
    p = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const keySlot = Number.isInteger(p.keySlot) ? p.keySlot : 0;
  if (keySlot < 0 || keySlot >= KEY_ENV_VARS.length) {
    return { statusCode: 400, body: JSON.stringify({ error: `keySlot must be 0-${KEY_ENV_VARS.length - 1}.` }) };
  }
  const envVarName = KEY_ENV_VARS[keySlot];
  // .trim() defensively strips stray whitespace/newlines that sometimes ride
  // along when a key is copied out of Google AI Studio and pasted into
  // Netlify's env var UI — a trailing "\n" silently breaks the ?key= query
  // string and Google responds with a confusing generic 401
  // ("Expected OAuth 2 access token...") instead of "bad key".
  const apiKey = (process.env[envVarName] || '').trim();
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `${envVarName} is not set in this site's environment variables.` })
    };
  }
  const required = ['symbol', 'timeframe', 'signal', 'direction', 'confidence', 'last', 'ema10', 'ema50', 'support', 'resistance', 'structure', 'closesRecent'];
  const missing = required.filter(k => p[k] === undefined || p[k] === null);
  if (missing.length) {
    return { statusCode: 400, body: JSON.stringify({ error: `Missing fields: ${missing.join(', ')}` }) };
  }

  // ohlcRecent/swingHighs/swingLows/trendline are all optional (build t) — an
  // older frontend build or a payload for an asset with too little history to
  // compute swings will simply omit them, and the prompt below degrades
  // gracefully to closes-only reasoning in that case.
  const hasOhlc = Array.isArray(p.ohlcRecent) && p.ohlcRecent.length > 0;
  const hasSwings = (Array.isArray(p.swingHighs) && p.swingHighs.length) || (Array.isArray(p.swingLows) && p.swingLows.length);
  const hasTrendline = p.trendline && typeof p.trendline === 'object';
  const hasFib = p.fibLevels && typeof p.fibLevels === 'object' && Array.isArray(p.fibLevels.levels);
  const hasTradingProfile = p.tradingProfile && typeof p.tradingProfile === 'object';

  const systemInstruction = `You read momentum for a swing trader on one asset at a time.
Reply with STRICT JSON only, matching this shape, nothing else:
{"stage": "Extending" | "Cooling" | "Exhausted" | "Reversing", "reasoning": "...", "confidence": <integer 0-100>,
 "stopLoss": <number> | null, "takeProfit": <number> | null, "rr": <number> | null, "targetFit": <string> | null}

The four stages are a repeating lifecycle, not a one-way path:
Extending -> Cooling -> Exhausted -> Reversing -> back to Extending (in the new direction).

- Extending: the current move still has clean momentum — candle bodies still full-size, price
  still making fresh highs/lows in its direction, not badly overstretched from its short EMA yet.
- Cooling: momentum is decelerating but hasn't broken down — shrinking candle bodies, longer
  wicks, choppier action. Not a reversal by itself, just "this push is running out of gas."
- Exhausted: the move has stalled — no fresh highs/lows for several bars, compressing range.
- Reversing: structure has actually started flipping against the prior trend — treat this as an
  early "pay attention, a new trend may be starting" flag, not a dead end. Only call this if
  there's a real break of the last swing high/low, not just a deeper-than-usual pullback still
  inside the old range.

You're given the asset's existing rule-based read (signal/direction/confidence from a 10/50 EMA
cross system), current EMAs, support/resistance, market structure, and up to the last 60 bars.

CANDLE DATA: when "ohlcRecent" is provided, each entry is {o,h,l,c} for one bar, oldest first —
this is REAL open/high/low/close data, not inferred. Use it directly to judge candle body size
(|c-o| relative to recent average) and wick length (h-max(o,c) and min(o,c)-l) — a shrinking body
with growing wicks is real deceleration evidence; a full body closing near its high/low with small
wicks is real continuation evidence. If "ohlcRecent" is absent or empty, only "closesRecent" (a
plain list of closes) is available — in that case do NOT claim to see candle bodies or wicks, since
you cannot; reason from close-to-close movement and volatility instead, and say so if it materially
limits your confidence.

CANDLESTICK PATTERN CHECK (mandatory when "ohlcRecent" is provided): explicitly check the last 5
bars — not just generic body/wick trend — against these exact definitions before you finalize your
stage call. Don't skip this because nothing looked interesting at a glance; run the check every
time, on every asset, the same way:
- Bullish engulfing: bar[i] closes bearish (c<o), bar[i+1] closes bullish (c>o) AND bar[i+1]'s body
  fully contains bar[i]'s body (bar[i+1].o < bar[i].c and bar[i+1].c > bar[i].o). Bearish engulfing
  is the mirror image.
- Pin bar / hammer (bullish): one wick at least 2x the body length, on the LOWER side
  (min(o,c)-l >= 2*|c-o|), small upper wick, appearing after a down move. Shooting star (bearish) is
  the mirror: long upper wick, small lower wick, appearing after an up move.
- Doji: body is very small relative to the bar's full range (|c-o| < ~10% of (h-l)) — indecision,
  not directional evidence by itself, but two or more in a row after an extended move supports
  Cooling/Exhausted.
If one of these actually appears in the last 5 bars, name it plainly in "reasoning" and weigh it
the way a real chart-reader would (a bullish engulfing or hammer at support is real evidence toward
Extending/Reversing-up; the bearish mirrors toward the downside). If none appear, don't invent one —
say the recent candles don't show a clean named pattern and reason from body/wick trend alone
instead, exactly as the paragraph above already describes.

STRUCTURE DATA: when present, "swingHighs" and "swingLows" are actual recent pivot prices (local
turning points), most recent last — use these as the real reference points for "has price made a
fresh high/low" and "where would a break of structure actually occur," instead of guessing from
raw closes. When present, "trendline" gives {type, slope, level} — a rough linear fit through the
last 2-3 relevant swing points (support trendline under an uptrend's swing lows, or resistance
trendline over a downtrend's swing highs) and its current price level. Treat price still holding
on the correct side of that level as support for Extending/Cooling; a clean close through it, in
the direction that breaks the trend, is meaningful evidence toward Reversing (more meaningful the
more decisively it broke, less meaningful if it's a single small poke through).

When present, "fibLevels" gives {from, to, levels: [{ratio, price}, ...]} — standard Fibonacci
retracement levels (23.6/38.2/50/61.8/78.6%) computed between the two most recent opposing swing
points. Treat these as another real structural reference, same weight class as support/resistance:
price stalling, bouncing, or rejecting cleanly at the 50% or 61.8% level is classic confluence and
should raise your confidence in whatever stage that reaction supports (e.g. a bounce there mid-
pullback favors Cooling/Extending continuation; a clean break through 61.8% against the prior trend
adds real weight toward Reversing). A level with no nearby price reaction isn't evidence either way
— don't force a fib level into the reasoning if price isn't actually near one.

Support/resistance reliability matters: if "srAvailable" is true, those levels were confirmed
against a wider multi-timeframe window and should be weighted heavily — treat a bounce or rejection
there as meaningful. If "srAvailable" is false, those are a same-timeframe local fallback only —
still useful, but hold them more loosely and don't treat a small poke through a local level as
a big deal the way you would at a major zone.

If "higherTimeframe" is present, it tells you the trend on the next timeframe up (e.g. this is 1h,
higherTimeframe is 4h). Give the higher timeframe's trend real weight when it conflicts with what
you see on the current timeframe — a clean higher-timeframe uptrend makes a current-timeframe dip
much more likely to be a healthy pullback (Extending/Cooling) than the start of a genuine Reversing;
a higher timeframe that's already ranging/choppy weakens that safety net. If higherTimeframe is
null, no cached higher-timeframe read was available — reason from the current timeframe alone.

Weigh all of this together — real candle texture and real structure/trendline data (when given)
should move your confidence more than the bare rule-based numbers alone, since they're the actual
evidence a human chart-reader would look at. "confidence" is YOUR confidence in the stage call
(0-100), independent of the rule-based confidence you were given. Keep "reasoning" to 2-4 short
sentences, plain language, for someone learning to read charts — reference the actual numbers/
levels you were given rather than vague generalities. Never claim certainty — this is a
probabilistic read, not a guarantee.

STOP LOSS / TAKE PROFIT: give your own honest, discerning price levels — this is your point of
view on where the trade would actually be invalidated and where it would realistically pay off,
not a fixed formula. Base it on the real structure you were given, in this order of preference:
the nearest relevant swing high/low beyond a small buffer, then a fib level (when price is actually
reacting near one), then the trendline level if one was given, then support/resistance (weighted
per srAvailable as above), only falling back to a rough percentage-of-price distance if none of
that structure is usable. If direction is 'buy': stopLoss
belongs below the nearest structural floor, takeProfit at or just before the nearest structural
ceiling. If direction is 'sell': mirror that (stop above structure, target below it). Set both to
null if direction is neutral/none/flat, or if the current stage is Reversing with no clear fresh
structure yet to anchor a level to (say so in "reasoning" rather than inventing a number). Compute
"rr" yourself as the reward:risk ratio implied by your own two levels relative to "last" (reward =
|takeProfit - last|, risk = |last - stopLoss|, rr = reward/risk, rounded to 1 decimal) — null
whenever either level is null. If a level you'd otherwise pick sits unrealistically close to
"last" (inside typical noise for this timeframe), say so and widen it rather than handing back a
stop that would get clipped by normal chop. These are your own judgment call, clearly labeled as
probabilistic in "reasoning" when relevant — never state a stop or target as a guarantee.

TARGET FIT (only when "tradingProfile" is provided): this trader uses a small, FIXED position size
on every trade (given in "fixedSizeNote" below) and is aiming for a modest, realistic per-trade
profit ("perTradeTargetUSD") toward a small daily goal ("dailyTargetUSD") — he is NOT asking you to
resize the stop/target to hit that dollar figure, and you must never let it distort the structural
stopLoss/takeProfit you already picked above. Its only job is a second, independent gut-check: given
the realistic distance to your takeProfit and how this instrument/timeframe typically moves, would
banking a small, modest gain at this fixed size require an unusually large price swing or an
unusually long hold to get there, or is it a normal, quickly-reachable move for this setup? You do
not have this trader's exact pip/contract value, so don't invent a dollar figure — reason
proportionally instead (e.g. "this move is a small fraction of the recent range, well within normal
reach" vs. "this would need a much bigger move than this pair/timeframe typically makes in one
push"). Set "targetFit" to a short one-sentence verdict in that spirit, or null if tradingProfile
wasn't provided, or if stopLoss/takeProfit are both null. Be honest when a setup looks like it would
need to be forced or overheld to matter at this size — say so plainly rather than softening it, the
same way you'd flag a level that's too close and would get clipped by chop.`;

  const ohlcLine = hasOhlc
    ? `Last ${p.ohlcRecent.length} bars (OHLC, oldest first): ${JSON.stringify(p.ohlcRecent)}`
    : `OHLC data: not provided this call — reasoning about candle bodies/wicks is not possible, closes only.`;
  const swingLine = hasSwings
    ? `Recent swing highs: ${JSON.stringify(p.swingHighs || [])} | Recent swing lows: ${JSON.stringify(p.swingLows || [])}`
    : `Swing highs/lows: not provided this call.`;
  const trendlineLine = hasTrendline
    ? `Trendline: ${JSON.stringify(p.trendline)}`
    : `Trendline: not provided this call.`;
  const fibLine = hasFib
    ? `Fibonacci retracement (from ${p.fibLevels.from} to ${p.fibLevels.to}): ${JSON.stringify(p.fibLevels.levels)}`
    : `Fibonacci retracement: not provided this call.`;
  const tradingProfileLine = hasTradingProfile
    ? `Trader's sizing/goal context: ${JSON.stringify(p.tradingProfile)}`
    : `Trader's sizing/goal context: not provided this call — leave targetFit null.`;

  const userContent = `Symbol: ${p.symbol}
Timeframe: ${p.timeframe}
Rule-based signal: ${p.signal} (${p.direction}, ${p.confidence}% confidence)
Last price: ${p.last}
EMA10: ${p.ema10}
EMA50: ${p.ema50}
Support: ${p.support} (srAvailable: ${!!p.srAvailable})
Resistance: ${p.resistance} (srAvailable: ${!!p.srAvailable})
Market structure: ${p.structure}
Last ${Array.isArray(p.closesRecent) ? p.closesRecent.length : 0} closes: ${JSON.stringify(p.closesRecent)}
${ohlcLine}
${swingLine}
${trendlineLine}
${fibLine}
Higher timeframe context: ${p.higherTimeframe ? JSON.stringify(p.higherTimeframe) : 'null (not cached)'}
${tradingProfileLine}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userContent }] }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          stage: { type: 'STRING', enum: STAGES },
          reasoning: { type: 'STRING' },
          confidence: { type: 'INTEGER' },
          stopLoss: { type: 'NUMBER', nullable: true },
          takeProfit: { type: 'NUMBER', nullable: true },
          rr: { type: 'NUMBER', nullable: true },
          targetFit: { type: 'STRING', nullable: true }
        },
        required: ['stage', 'reasoning', 'confidence', 'stopLoss', 'takeProfit', 'rr', 'targetFit']
      }
    }
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const text = await res.text();
    if (!res.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: `Gemini API error (${res.status}): ${text.slice(0, 300)}` }) };
    }

    const json = JSON.parse(text);
    const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      return { statusCode: 502, body: JSON.stringify({ error: 'No content returned by Gemini.' }) };
    }

    // responseSchema should make this already-clean JSON, but strip code
    // fences defensively in case the model wraps it anyway.
    const cleaned = raw.replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!STAGES.includes(parsed.stage) || typeof parsed.reasoning !== 'string') {
      return { statusCode: 502, body: JSON.stringify({ error: 'Model returned an unexpected shape.' }) };
    }

    const confidence = Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(100, Math.round(parsed.confidence))) : 50;
    // stopLoss/takeProfit/rr (build v): pass through only if the model gave real
    // finite numbers; anything else (missing, null, NaN, a stray string) collapses
    // to null rather than letting a malformed value reach the frontend.
    const stopLoss = Number.isFinite(parsed.stopLoss) ? parsed.stopLoss : null;
    const takeProfit = Number.isFinite(parsed.takeProfit) ? parsed.takeProfit : null;
    const rr = Number.isFinite(parsed.rr) ? Math.round(parsed.rr * 10) / 10 : null;
    const targetFit = typeof parsed.targetFit === 'string' && parsed.targetFit.trim() ? parsed.targetFit.trim() : null;

    return {
      statusCode: 200,
      body: JSON.stringify({ stage: parsed.stage, reasoning: parsed.reasoning, confidence, stopLoss, takeProfit, rr, targetFit })
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: e.message || 'Unknown error calling Gemini.' }) };
  }
};
