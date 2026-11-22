require('dotenv').config({ path: './.env.local' });
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');

const auth = require('./auth');
const db = require('./db');
const alerts = require('./alerts');
const tg = require('./telegram');

const app = express();
const PORT = process.env.PORT || 3500;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

let webpush = null;
try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@wills-ai.local', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
} catch (e) {}

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(PUBLIC_DIR, { etag: false, lastModified: false, setHeaders: (res, fp) => { if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); } }));

// ═══════════════════════════════════════════════════════════
// BIQUOTE CACHING HELPER
// ═══════════════════════════════════════════════════════════
const cache = new Map(), TTL = 30_000; 
async function cachedFetch(url) {
  const hit = cache.get(url); if (hit && hit.expires > Date.now()) return hit.data;
  const resp = await fetch(url); if (!resp.ok) throw new Error(`Biquote Error: ${resp.status}`);
  const data = await resp.json(); cache.set(url, { data, expires: Date.now() + TTL }); return data;
}

// ═══════════════════════════════════════════════════════════
// VERITASIUM MATH ENGINE (SERVER SIDE)
// ═══════════════════════════════════════════════════════════
function linregSeries(values, period) { const out = new Array(values.length).fill(null); if (values.length < period) return out; for (let i = period - 1; i < values.length; i++) { let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0; for (let j = 0; j < period; j++) { const x = j, y = values[i - period + 1 + j]; sumX += x; sumY += y; sumXY += x * y; sumXX += x * x; } const denom = period * sumXX - sumX * sumX; if (denom === 0) { out[i] = values[i]; continue; } const slope = (period * sumXY - sumX * sumY) / denom; const intercept = (sumY - slope * sumX) / period; out[i] = intercept + slope * (period - 1); } return out; }
function calculateStdDev(values, mean) { if (values.length === 0) return 0; let sum = 0; for (const v of values) sum += (v - mean) ** 2; return Math.sqrt(sum / values.length); }
function calculateRSI(prices, period = 14) { if (prices.length < period + 1) return 50; let gainSum = 0, lossSum = 0; for (let i = 1; i <= period; i++) { const d = prices[i] - prices[i - 1]; if (d >= 0) gainSum += d; else lossSum -= d; } let avgGain = gainSum / period, avgLoss = lossSum / period; for (let i = period + 1; i < prices.length; i++) { const d = prices[i] - prices[i - 1]; avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period; avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period; } if (avgLoss === 0) return 100; return 100 - 100 / (1 + avgGain / avgLoss); }
function calculateMACD(prices) { if (prices.length < 35) return { macd: 0, signal: 0, histogram: 0 }; const lr12 = linregSeries(prices, 12); const lr26 = linregSeries(prices, 26); const macdLine = []; for (let i = 25; i < prices.length; i++) { if (lr12[i] !== null && lr26[i] !== null) macdLine.push(lr12[i] - lr26[i]); } if (macdLine.length < 9) { const m = macdLine[macdLine.length - 1] || 0; return { macd: m, signal: m, histogram: 0 }; } const signalSeries = linregSeries(macdLine, 9); const macd = macdLine[macdLine.length - 1]; const signal = signalSeries[signalSeries.length - 1]; return { macd, signal, histogram: macd - signal }; }
function calculateZScore(prices, lookback = 20) { if (prices.length < lookback) return 0; const slice = prices.slice(-lookback); const mean = slice.reduce((a, b) => a + b, 0) / slice.length; const std = calculateStdDev(slice, mean); if (std === 0) return 0; return (prices[prices.length - 1] - mean) / std; }
function calculateHurst(prices) { if (prices.length < 100) return 0.5; const returns = []; for (let i = 1; i < prices.length; i++) { const r = Math.log(prices[i] / prices[i - 1]); if (isFinite(r)) returns.push(r); } if (returns.length < 80) return 0.5; const maxLag = Math.floor(returns.length / 2), minLag = 10; const lags = [], rsVals = []; for (let lag = minLag; lag <= maxLag; lag = Math.floor(lag * 1.5)) { const sections = Math.floor(returns.length / lag); if (sections < 2) continue; let rsSum = 0, count = 0; for (let s = 0; s < sections; s++) { const slice = returns.slice(s * lag, (s + 1) * lag); const mean = slice.reduce((a, b) => a + b, 0) / slice.length; let cum = 0, maxCum = -Infinity, minCum = Infinity; for (const v of slice) { cum += v - mean; if (cum > maxCum) maxCum = cum; if (cum < minCum) minCum = cum; } const R = maxCum - minCum; const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length; const S = Math.sqrt(variance); if (S > 0 && R > 0) { rsSum += R / S; count++; } } if (count > 0) { const avg = rsSum / count; if (avg > 0) { lags.push(Math.log(lag)); rsVals.push(Math.log(avg)); } } } if (lags.length < 3) return 0.5; const n = lags.length; const sumX = lags.reduce((a, b) => a + b, 0); const sumY = rsVals.reduce((a, b) => a + b, 0); const sumXY = lags.reduce((a, x, i) => a + x * rsVals[i], 0); const sumX2 = lags.reduce((a, x) => a + x * x, 0); const denom = n * sumX2 - sumX * sumX; if (denom === 0) return 0.5; return Math.max(0, Math.min(1, (n * sumXY - sumX * sumY) / denom)); }
function calculateATR(candles, period = 14) { if (candles.length < period + 1) return 0; const tr = []; for (let i = 1; i < candles.length; i++) { const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close; tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); } let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period; for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period; return atr; }
function calculateVWAP(candles, lookback = 20) { const slice = candles.slice(-lookback); if (slice.length === 0) return candles[candles.length - 1].close; let pvSum = 0, volSum = 0; for (const c of slice) { const typical = (c.high + c.low + c.close) / 3; const vol = c.volume > 0 ? c.volume : 1; pvSum += typical * vol; volSum += vol; } return volSum > 0 ? pvSum / volSum : candles[candles.length - 1].close; }
function findLastSwing(candles, leftBars = 5, rightBars = 5) { const n = candles.length; let swingHigh = null, swingLow = null; for (let i = n - rightBars - 1; i >= leftBars; i--) { const h = candles[i].high, l = candles[i].low; let isHigh = true, isLow = true; for (let j = i - leftBars; j <= i + rightBars; j++) { if (j === i) continue; if (candles[j].high >= h) isHigh = false; if (candles[j].low <= l) isLow = false; } if (isHigh && swingHigh === null) swingHigh = { idx: i, price: h }; if (isLow && swingLow === null) swingLow = { idx: i, price: l }; if (swingHigh && swingLow) break; } return { swingHigh, swingLow }; }
function calculateFibonacci(candles) { const { swingHigh, swingLow } = findLastSwing(candles); const last = candles[candles.length - 1].close; const high = swingHigh ? swingHigh.price : Math.max(...candles.map(c => c.high)); const low = swingLow ? swingLow.price : Math.min(...candles.map(c => c.low)); const diff = high - low; const direction = (swingHigh && swingLow && swingHigh.idx > swingLow.idx) ? 'UP' : 'DOWN'; const levels = { fib_0: low, fib_0_236: low + diff * 0.236, fib_0_382: low + diff * 0.382, fib_0_5: low + diff * 0.5, fib_0_618: low + diff * 0.618, fib_0_786: low + diff * 0.786, fib_1: high }; let nearest = null, nearestDist = Infinity; for (const [name, price] of Object.entries(levels)) { const d = Math.abs(last - price); if (d < nearestDist) { nearestDist = d; nearest = { name, price }; } } return { high, low, direction, ...levels, nearest }; }
function calculateValueArea(candles, bins = 20, vaPercent = 0.70) { const slice = candles.slice(-100); if (slice.length < 20) return null; const minP = Math.min(...slice.map(c => c.low)); const maxP = Math.max(...slice.map(c => c.high)); const rangeP = maxP - minP; if (rangeP <= 0) return null; const binSize = rangeP / bins; const profile = new Array(bins).fill(0); for (const c of slice) { const typical = (c.high + c.low + c.close) / 3; const idx = Math.min(bins - 1, Math.floor((typical - minP) / binSize)); profile[idx] += c.volume > 0 ? c.volume : 1; } const totalVol = profile.reduce((a, b) => a + b, 0); const maxVol = Math.max(...profile); const pocIdx = profile.indexOf(maxVol); const poc = minP + (pocIdx + 0.5) * binSize; let lowerIdx = pocIdx, upperIdx = pocIdx; let captured = profile[pocIdx]; const target = totalVol * vaPercent; while (captured < target && (lowerIdx > 0 || upperIdx < bins - 1)) { const upVol = upperIdx < bins - 1 ? profile[upperIdx + 1] : -1; const downVol = lowerIdx > 0 ? profile[lowerIdx - 1] : -1; if (upVol >= downVol) { upperIdx++; captured += profile[upperIdx]; } else { lowerIdx--; captured += profile[lowerIdx]; } } const vah = minP + (upperIdx + 0.5) * binSize; const val = minP + (lowerIdx + 0.5) * binSize; return { poc: +poc.toFixed(5), vah: +vah.toFixed(5), val: +val.toFixed(5) }; }
function detectLiquiditySweep(candles, lookback = 20) { const n = candles.length; if (n < lookback + 3) return null; for (let off = 1; off <= 3; off++) { const sweepBar = candles[n - off]; const lookbackEnd = n - off - 1; const lookbackStart = Math.max(0, lookbackEnd - lookback); const prior = candles.slice(lookbackStart, lookbackEnd); if (prior.length < 5) continue; const priorHigh = Math.max(...prior.map(c => c.high)); const priorLow = Math.min(...prior.map(c => c.low)); if (sweepBar.low < priorLow && sweepBar.close > priorLow) { return { type: 'BULLISH_SWEEP', sweptLevel: priorLow, barsAgo: off }; } if (sweepBar.high > priorHigh && sweepBar.close < priorHigh) { return { type: 'BEARISH_SWEEP', sweptLevel: priorHigh, barsAgo: off }; } } return null; }
function detectCVD(candles) { const n = candles.length; if (n < 20) return null; const delta = new Array(n).fill(0); let cumulative = 0; for (let i = 0; i < n; i++) { const c = candles[i]; const range = c.high - c.low; const vol = c.volume > 0 ? c.volume : 1; delta[i] = range > 0 ? (((c.close - c.low) - (c.high - c.close)) / range) * vol : 0; cumulative += delta[i]; } return { cvd: +cumulative.toFixed(0), lastDelta: +delta[n - 1].toFixed(0) }; }

// ═══════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/api/calendar', async (req, res) => { /* ... existing calendar logic ... */ });
app.get('/api/news', (req, res) => { /* ... existing news logic ... */ });

app.post('/api/signal', async (req, res) => {
  try {
    const { symbol, text, contextMode } = req.body;
    const mistralKey = process.env.MISTRAL_API_KEY;
    if (!mistralKey) return res.status(500).json({ error: 'Mistral API key missing.' });

    let contextStr = "";
    if (contextMode === 'events' || contextMode === 'both') {
      const today = new Date().toISOString().slice(0, 10);
      const { data: events } = await db.admin.from('calendar_events').select('currency, title, impact, actual, forecast').eq('event_date', today).in('impact', ['high', 'medium']).limit(5);
      if (events && events.length > 0) { contextStr += "ECONOMIC EVENTS TODAY:\n"; events.forEach(e => { contextStr += `- ${e.currency} ${e.title} (${e.impact}): F ${e.forecast || 'N/A'}, A ${e.actual || 'Pending'}\n`; }); }
    }
    if (contextMode === 'both') {
      try { const newsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'investing_news.json'), 'utf8')); const latestNews = (newsData.items || []).slice(0, 3); if (latestNews.length > 0) { contextStr += "\nLATEST NEWS:\n"; latestNews.forEach(n => { contextStr += `- ${n.title}\n`; }); } } catch (e) {}
    }

    let targetSymbol = symbol;
    if (!targetSymbol || targetSymbol === "GENERAL") {
      const lower = (text || "").toLowerCase();
      if (lower.includes('gold') || lower.includes('xau')) targetSymbol = 'XAUUSD';
      else if (lower.includes('eur')) targetSymbol = 'EURUSD';
      else if (lower.includes('gbp')) targetSymbol = 'GBPUSD';
      else if (lower.includes('btc')) targetSymbol = 'BTCUSD';
    }

    if (!targetSymbol && text) {
      const chatRes = await fetch('https://api.mistral.ai/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mistralKey}` }, body: JSON.stringify({ model: 'open-mistral-7b', messages: [{ role: 'system', content: `You are Will's AI. Context:\n${contextStr}` }, { role: 'user', content: text }] }) });
      const chatData = await chatRes.json(); return res.json({ signal: chatData.choices[0].message.content });
    }

    if (!targetSymbol) return res.json({ signal: "Select a symbol or ask a question." });

    // --- FETCH 7 TIMEFRAMES FROM BIQUOTE ---
    const timeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
    let mtfDataStr = "";
    let globalLivePrice = 0;

    for (const tf of timeframes) {
      const url = `https://biquote.io/api/${targetSymbol}/ohlc?interval=${tf}&limit=150`;
      try {
        const ohlcData = await cachedFetch(url);
        if (ohlcData && ohlcData.bars && ohlcData.bars.length >= 60) {
          const candles = ohlcData.bars.reverse().map(b => ({ open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 }));
          const prices = candles.map(c => c.close);
          const cp = prices[prices.length - 1];
          if (tf === '1m') globalLivePrice = cp;

          const rsi = calculateRSI(prices, 14);
          const macd = calculateMACD(prices);
          const hurst = calculateHurst(prices);
          const atr = calculateATR(candles, 14);
          const vwap = calculateVWAP(candles, 20);
          const fib = calculateFibonacci(candles);
          const va = calculateValueArea(candles);
          const sweep = detectLiquiditySweep(candles);
          const cvd = detectCVD(candles);

          mtfDataStr += `\n[${tf.toUpperCase()} TIMEFRAME]\nPrice: ${cp.toFixed(4)} | ATR: ${atr.toFixed(4)} | RSI: ${rsi.toFixed(1)} | MACD: ${macd.histogram > 0 ? 'BULL' : 'BEAR'}\nHurst: ${hurst.toFixed(2)} | VWAP: ${vwap.toFixed(4)}\nFib 38.2%: ${fib.fib_0_382.toFixed(4)} | 61.8%: ${fib.fib_0_618.toFixed(4)}\n`;
          if (va) mtfDataStr += `Value Area: VAL ${va.val.toFixed(4)} | POC ${va.poc.toFixed(4)} | VAH ${va.vah.toFixed(4)}\n`;
          if (cvd) mtfDataStr += `CVD: ${cvd.cvd} | Delta: ${cvd.lastDelta}\n`;
          if (sweep) mtfDataStr += `Liquidity Sweep: ${sweep.type} at ${sweep.sweptLevel.toFixed(4)}\n`;
        }
      } catch (e) { console.error(`[signal] Failed to fetch ${tf}`); }
    }

    if (!mtfDataStr) return res.status(400).json({ error: "Could not fetch market data for this symbol." });

    const prompt = `You are an elite institutional quantitative trader. Analyze this multi-timeframe data for ${targetSymbol}.
    
    ${contextStr ? `CONTEXT:\n${contextStr}\n` : 'Pure technical analysis.'}
    
    MULTI-TIMEFRAME DATA:
    ${mtfDataStr}
    
    Based on the data above (Hurst, RSI, CVD, Volume Profile, Fib, Sweeps), provide a BUY/SELL/HOLD signal. 
    Explain exactly why (cite the Hurst value, the POC, the Fib level, etc.). 
    Include Entry, Stop-Loss (place outside the recent swing/ATR), and Take-Profit (place at next POC or Fib).`;

    const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mistralKey}` },
      body: JSON.stringify({ model: 'open-mistral-7b', messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 2000 })
    });
    const mistralData = await mistralRes.json();
    if (!mistralRes.ok) throw new Error(mistralData.error?.message || 'Mistral Error');
    
    res.json({ signal: mistralData.choices[0].message.content });

  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ... [Auth, Telegram, Push, Cron, and SPA Catch-All remain exactly the same] ...
// (Paste your existing Auth, Telegram, Push, Cron, and SPA routes below this line)