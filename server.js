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

// ── GLOBAL ERROR HANDLERS (Prevents silent crashes on Render) ──
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

const app = express();
const PORT = process.env.PORT || 3500;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

let webpush = null;
try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@wills-ai.local',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  }
} catch (e) {
  console.warn('[push] Web push not configured');
}

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(PUBLIC_DIR, {
  etag: false, lastModified: false,
  setHeaders: (res, fp) => { if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); }
}));

// ═══════════════════════════════════════════════════════════
//  BIQUOTE CACHING HELPER
// ═══════════════════════════════════════════════════════════
const cache = new Map();
const TTL = 30_000;
async function cachedFetch(url) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.data;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Biquote Error: ${resp.status}`);
  const data = await resp.json();
  cache.set(url, { data, expires: Date.now() + TTL });
  return data;
}

// ═══════════════════════════════════════════════════════════
//  FULL VERITASIUM MATH ENGINE (SERVER-SIDE)
// ═══════════════════════════════════════════════════════════
function linregSeries(values, period) { const out = new Array(values.length).fill(null); if (values.length < period) return out; for (let i = period - 1; i < values.length; i++) { let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0; for (let j = 0; j < period; j++) { const x = j, y = values[i - period + 1 + j]; sumX += x; sumY += y; sumXY += x * y; sumXX += x * x; } const denom = period * sumXX - sumX * sumX; if (denom === 0) { out[i] = values[i]; continue; } const slope = (period * sumXY - sumX * sumY) / denom; const intercept = (sumY - slope * sumX) / period; out[i] = intercept + slope * (period - 1); } return out; }
function calculateStdDev(values, mean) { if (values.length === 0) return 0; let sum = 0; for (const v of values) sum += (v - mean) ** 2; return Math.sqrt(sum / values.length); }
function calculateRSI(prices, period = 14) { if (prices.length < period + 1) return 50; let gainSum = 0, lossSum = 0; for (let i = 1; i <= period; i++) { const d = prices[i] - prices[i - 1]; if (d >= 0) gainSum += d; else lossSum -= d; } let avgGain = gainSum / period, avgLoss = lossSum / period; for (let i = period + 1; i < prices.length; i++) { const d = prices[i] - prices[i - 1]; avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period; avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period; } if (avgLoss === 0) return 100; return 100 - 100 / (1 + avgGain / avgLoss); }
function calculateMACD(prices) { if (prices.length < 35) return { macd: 0, signal: 0, histogram: 0 }; const lr12 = linregSeries(prices, 12); const lr26 = linregSeries(prices, 26); const macdLine = []; for (let i = 25; i < prices.length; i++) { if (lr12[i] !== null && lr26[i] !== null) macdLine.push(lr12[i] - lr26[i]); } if (macdLine.length < 9) { const m = macdLine[macdLine.length - 1] || 0; return { macd: m, signal: m, histogram: 0 }; } const signalSeries = linregSeries(macdLine, 9); const macd = macdLine[macdLine.length - 1]; const signal = signalSeries[signalSeries.length - 1]; return { macd, signal, histogram: macd - signal }; }
function calculateZScore(prices, lookback = 20) { if (prices.length < lookback) return 0; const slice = prices.slice(-lookback); const mean = slice.reduce((a, b) => a + b, 0) / slice.length; const std = calculateStdDev(slice, mean); if (std === 0) return 0; return (prices[prices.length - 1] - mean) / std; }
function calculateHurst(prices) { if (prices.length < 100) return 0.5; const returns = []; for (let i = 1; i < prices.length; i++) { const r = Math.log(prices[i] / prices[i - 1]); if (isFinite(r)) returns.push(r); } if (returns.length < 80) return 0.5; const maxLag = Math.floor(returns.length / 2), minLag = 10; const lags = [], rsVals = []; for (let lag = minLag; lag <= maxLag; lag = Math.floor(lag * 1.5)) { const sections = Math.floor(returns.length / lag); if (sections < 2) continue; let rsSum = 0, count = 0; for (let s = 0; s < sections; s++) { const slice = returns.slice(s * lag, (s + 1) * lag); const mean = slice.reduce((a, b) => a + b, 0) / slice.length; let cum = 0, maxCum = -Infinity, minCum = Infinity; for (const v of slice) { cum += v - mean; if (cum > maxCum) maxCum = cum; if (cum < minCum) minCum = cum; } const R = maxCum - minCum; const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length; const S = Math.sqrt(variance); if (S > 0 && R > 0) { rsSum += R / S; count++; } } if (count > 0) { const avg = rsSum / count; if (avg > 0) { lags.push(Math.log(lag)); rsVals.push(Math.log(avg)); } } } if (lags.length < 3) return 0.5; const n = lags.length; const sumX = lags.reduce((a, b) => a + b, 0); const sumY = rsVals.reduce((a, b) => a + b, 0); const sumXY = lags.reduce((a, x, i) => a + x * rsVals[i], 0); const sumX2 = lags.reduce((a, x) => a + x * x, 0); const denom = n * sumX2 - sumX * sumX; if (denom === 0) return 0.5; return Math.max(0, Math.min(1, (n * sumXY - sumX * sumY) / denom)); }
function calculateATR(candles, period = 14) { if (candles.length < period + 1) return 0; const tr = []; for (let i = 1; i < candles.length; i++) { const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close; tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); } let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period; for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period; return atr; }
function calculateATRSeries(candles, period = 14) { const n = candles.length; const out = new Array(n).fill(null); if (n < period + 1) return out; const tr = []; for (let i = 1; i < n; i++) { const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close; tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); } let atr = 0; for (let k = 0; k < period; k++) atr += tr[k]; atr /= period; out[period] = atr; for (let i = period; i < tr.length; i++) { atr = (atr * (period - 1) + tr[i]) / period; out[i + 1] = atr; } return out; }
function calculateVolatilityPercentile(candles, lookback = 100, period = 14) { const n = candles.length; if (n < period + 20) return null; const atrSeries = calculateATRSeries(candles, period); const atrPct = []; for (let i = period; i < n; i++) { if (atrSeries[i] == null) continue; const price = candles[i].close; if (price > 0 && atrSeries[i] > 0) atrPct.push(atrSeries[i] / price); } if (atrPct.length < 20) return null; const current = atrPct[atrPct.length - 1]; const hist = atrPct.slice(-lookback); let below = 0; for (const v of hist) if (v < current) below++; const percentile = (below / hist.length) * 100; let regime; if (percentile >= 90) regime = 'EXTREME_HIGH'; else if (percentile >= 75) regime = 'HIGH'; else if (percentile >= 50) regime = 'ELEVATED'; else if (percentile >= 25) regime = 'NORMAL'; else if (percentile >= 10) regime = 'LOW'; else regime = 'EXTREME_LOW'; return { percentile: +percentile.toFixed(1), regime }; }
function calculateVWAP(candles, lookback = 20) { const slice = candles.slice(-lookback); if (slice.length === 0) return candles[candles.length - 1].close; let pvSum = 0, volSum = 0; for (const c of slice) { const typical = (c.high + c.low + c.close) / 3; const vol = c.volume > 0 ? c.volume : 1; pvSum += typical * vol; volSum += vol; } return volSum > 0 ? pvSum / volSum : candles[candles.length - 1].close; }
function calculateVWAPBands(candles, lookback = 20) { const slice = candles.slice(-lookback); if (slice.length === 0) return null; let pvSum = 0, volSum = 0; for (const c of slice) { const typical = (c.high + c.low + c.close) / 3; const vol = c.volume > 0 ? c.volume : 1; pvSum += typical * vol; volSum += vol; } if (volSum <= 0) return null; const vwap = pvSum / volSum; let varSum = 0; for (const c of slice) { const typical = (c.high + c.low + c.close) / 3; const vol = c.volume > 0 ? c.volume : 1; varSum += vol * (typical - vwap) ** 2; } const std = Math.sqrt(varSum / volSum); return { vwap: +vwap.toFixed(5), upper1: +(vwap + std).toFixed(5), upper2: +(vwap + 2 * std).toFixed(5), lower1: +(vwap - std).toFixed(5), lower2: +(vwap - 2 * std).toFixed(5) }; }
function calculateAnchoredVWAP(candles) { const n = candles.length; if (n < 30) return null; const swings = findLastSwing(candles, 5, 5); let anchorIdx = Math.max(0, n - 40); if (swings.swingLow && swings.swingHigh) anchorIdx = Math.max(swings.swingLow.idx, swings.swingHigh.idx); else if (swings.swingLow) anchorIdx = swings.swingLow.idx; else if (swings.swingHigh) anchorIdx = swings.swingHigh.idx; if (anchorIdx >= n - 5) anchorIdx = Math.max(0, n - 40); let pvSum = 0, volSum = 0; for (let i = anchorIdx; i < n; i++) { const c = candles[i]; const typical = (c.high + c.low + c.close) / 3; const vol = c.volume > 0 ? c.volume : 1; pvSum += typical * vol; volSum += vol; } if (volSum <= 0) return null; return { avwap: +(pvSum / volSum).toFixed(5) }; }
function findLastSwing(candles, leftBars = 5, rightBars = 5) { const n = candles.length; let swingHigh = null, swingLow = null; for (let i = n - rightBars - 1; i >= leftBars; i--) { const h = candles[i].high, l = candles[i].low; let isHigh = true, isLow = true; for (let j = i - leftBars; j <= i + rightBars; j++) { if (j === i) continue; if (candles[j].high >= h) isHigh = false; if (candles[j].low <= l) isLow = false; } if (isHigh && swingHigh === null) swingHigh = { idx: i, price: h }; if (isLow && swingLow === null) swingLow = { idx: i, price: l }; if (swingHigh && swingLow) break; } return { swingHigh, swingLow }; }
function calculateFibonacci(candles) { const { swingHigh, swingLow } = findLastSwing(candles); const last = candles[candles.length - 1].close; const high = swingHigh ? swingHigh.price : Math.max(...candles.map(c => c.high)); const low = swingLow ? swingLow.price : Math.min(...candles.map(c => c.low)); const diff = high - low; const direction = (swingHigh && swingLow && swingHigh.idx > swingLow.idx) ? 'UP' : 'DOWN'; const levels = { fib_0: low, fib_0_236: low + diff * 0.236, fib_0_382: low + diff * 0.382, fib_0_5: low + diff * 0.5, fib_0_618: low + diff * 0.618, fib_0_786: low + diff * 0.786, fib_1: high }; return { high, low, direction, ...levels }; }
function calculateValueArea(candles, bins = 20, vaPercent = 0.70, voidThreshold = 0.20) { const slice = candles.slice(-100); if (slice.length < 20) return null; const minP = Math.min(...slice.map(c => c.low)); const maxP = Math.max(...slice.map(c => c.high)); const rangeP = maxP - minP; if (rangeP <= 0) return null; const binSize = rangeP / bins; const profile = new Array(bins).fill(0); for (const c of slice) { const typical = (c.high + c.low + c.close) / 3; const idx = Math.min(bins - 1, Math.floor((typical - minP) / binSize)); profile[idx] += c.volume > 0 ? c.volume : 1; } const totalVol = profile.reduce((a, b) => a + b, 0); const maxVol = Math.max(...profile); const pocIdx = profile.indexOf(maxVol); const poc = minP + (pocIdx + 0.5) * binSize; let lowerIdx = pocIdx, upperIdx = pocIdx; let captured = profile[pocIdx]; const target = totalVol * vaPercent; while (captured < target && (lowerIdx > 0 || upperIdx < bins - 1)) { const upVol = upperIdx < bins - 1 ? profile[upperIdx + 1] : -1; const downVol = lowerIdx > 0 ? profile[lowerIdx - 1] : -1; if (upVol >= downVol) { upperIdx++; captured += profile[upperIdx]; } else { lowerIdx--; captured += profile[lowerIdx]; } } const vah = minP + (upperIdx + 0.5) * binSize; const val = minP + (lowerIdx + 0.5) * binSize; const thresh = maxVol * voidThreshold; const voids = []; for (let i = 0; i < bins; i++) { if (i === pocIdx) continue; if (profile[i] >= thresh) continue; if (voids.length && voids[voids.length - 1].endIdx === i - 1) { voids[voids.length - 1].endIdx = i; voids[voids.length - 1].high = minP + (i + 1) * binSize; voids[voids.length - 1].vol += profile[i]; } else { voids.push({ startIdx: i, endIdx: i, low: minP + i * binSize, high: minP + (i + 1) * binSize, vol: profile[i] }); } } const price = candles[candles.length - 1].close; voids.sort((a, b) => Math.abs((a.low + a.high)/2 - price) - Math.abs((b.low + b.high)/2 - price)); return { poc: +poc.toFixed(5), vah: +vah.toFixed(5), val: +val.toFixed(5), voids: voids.slice(0, 3).map(v => ({ low: +v.low.toFixed(5), high: +v.high.toFixed(5), vol: +v.vol.toFixed(0) })) }; }
function detectNakedPOC(candles, segmentSize = 25) { const n = candles.length; if (n < segmentSize * 2) return []; const segments = []; for (let start = 0; start <= n - segmentSize; start += segmentSize) { const end = Math.min(start + segmentSize, n); const seg = candles.slice(start, end); if (seg.length < segmentSize / 2) continue; const minP = Math.min(...seg.map(c => c.low)); const maxP = Math.max(...seg.map(c => c.high)); const range = maxP - minP; if (range <= 0) continue; const bins = 15; const binSize = range / bins; const profile = new Array(bins).fill(0); for (const c of seg) { const typical = (c.high + c.low + c.close) / 3; const idx = Math.min(bins - 1, Math.floor((typical - minP) / binSize)); profile[idx] += c.volume > 0 ? c.volume : 1; } const pocIdx = profile.indexOf(Math.max(...profile)); const poc = minP + (pocIdx + 0.5) * binSize; segments.push({ end, poc, start }); } const nakedPOCs = []; for (const seg of segments) { let tested = false; for (let i = seg.end; i < n; i++) { const c = candles[i]; if (seg.poc >= c.low && seg.poc <= c.high) { tested = true; break; } } if (!tested && seg.end < n - 3) { nakedPOCs.push({ price: +seg.poc.toFixed(5), barsAgo: n - seg.end }); } } return nakedPOCs.slice(-3); }
function detectVolumeImbalance(candles, lookback = 20, mult = 1.5) { const n = candles.length; if (n < lookback + 1) return null; const last = candles[n - 1]; const body = Math.abs(last.close - last.open); if (body <= 0) return null; const dir = last.close > last.open ? 'BULL_IMBALANCE' : 'BEAR_IMBALANCE'; const lastVol = last.volume > 0 ? last.volume : 1; const slice = candles.slice(-lookback - 1, -1); const avgBodyVol = slice.reduce((a, c) => a + Math.abs(c.close - c.open) * (c.volume > 0 ? c.volume : 1), 0) / slice.length; if (avgBodyVol <= 0) return null; const ratio = (body * lastVol) / avgBodyVol; if (ratio < mult) return null; return { direction: dir, ratio: +ratio.toFixed(2) }; }
function detectBPR(candles) { const n = candles.length; if (n < 10) return null; let upFVG = null, downFVG = null; for (let i = n - 2; i >= Math.max(1, n - 15); i--) { const c0 = candles[i - 1], c2 = candles[i + 1]; if (!c2) continue; const high1 = Math.max(c0.open, c0.close), low1 = Math.min(c0.open, c0.close); const high2 = Math.max(c2.open, c2.close), low2 = Math.min(c2.open, c2.close); if (!upFVG && low2 > high1) upFVG = { top: low2, bottom: high1, idx: i }; if (!downFVG && high2 < low1) downFVG = { top: low1, bottom: high2, idx: i }; if (upFVG && downFVG) break; } if (!upFVG || !downFVG) return null; const top = Math.min(upFVG.top, downFVG.top); const bottom = Math.max(upFVG.bottom, downFVG.bottom); if (top <= bottom) return null; return { top: +top.toFixed(5), bottom: +bottom.toFixed(5), size: +(top - bottom).toFixed(5), sequence: upFVG.idx > downFVG.idx ? 'DOWN_THEN_UP' : 'UP_THEN_DOWN' }; }
function detectLiquiditySweep(candles, lookback = 20) { const n = candles.length; if (n < lookback + 3) return null; for (let off = 1; off <= 3; off++) { const sweepBar = candles[n - off]; const lookbackEnd = n - off - 1; const lookbackStart = Math.max(0, lookbackEnd - lookback); const prior = candles.slice(lookbackStart, lookbackEnd); if (prior.length < 5) continue; const priorHigh = Math.max(...prior.map(c => c.high)); const priorLow = Math.min(...prior.map(c => c.low)); if (sweepBar.low < priorLow && sweepBar.close > priorLow) { return { type: 'BULLISH_SWEEP', sweptLevel: priorLow, wickSize: +(priorLow - sweepBar.low).toFixed(5), barsAgo: off }; } if (sweepBar.high > priorHigh && sweepBar.close < priorHigh) { return { type: 'BEARISH_SWEEP', sweptLevel: priorHigh, wickSize: +(sweepBar.high - priorHigh).toFixed(5), barsAgo: off }; } } return null; }
function calculatePremiumDiscount(candles) { const n = candles.length; if (n < 20) return null; const recent = candles.slice(-30); const high = Math.max(...recent.map(c => c.high)); const low = Math.min(...recent.map(c => c.low)); const eq = (high + low) / 2; const price = candles[n - 1].close; let zone = 'EQ'; if (price > eq + (high - eq) * 0.5) zone = 'PREMIUM_HIGH'; else if (price > eq) zone = 'PREMIUM'; else if (price < eq - (eq - low) * 0.5) zone = 'DISCOUNT_LOW'; else if (price < eq) zone = 'DISCOUNT'; return { high: +high.toFixed(5), low: +low.toFixed(5), eq: +eq.toFixed(5), zone }; }
function calculateOTE(candles) { const n = candles.length; if (n < 30) return null; const { swingHigh, swingLow } = findLastSwing(candles, 5, 5); if (!swingHigh || !swingLow) return null; const diff = swingHigh.price - swingLow.price; if (diff <= 0) return null; if (swingHigh.idx > swingLow.idx) { const ote62 = swingHigh.price - diff * 0.62; const ote79 = swingHigh.price - diff * 0.79; return { type: 'BULLISH_OTE', zoneLow: +ote79.toFixed(5), zoneHigh: +ote62.toFixed(5), midPoint: +((ote62 + ote79) / 2).toFixed(5) }; } else { const ote62 = swingLow.price + diff * 0.62; const ote79 = swingLow.price + diff * 0.79; return { type: 'BEARISH_OTE', zoneLow: +ote62.toFixed(5), zoneHigh: +ote79.toFixed(5), midPoint: +((ote62 + ote79) / 2).toFixed(5) }; } }
function detectInducement(candles) { const n = candles.length; if (n < 30) return null; const last5 = candles.slice(-5); const priorRange = candles.slice(-20, -5); const priorHigh = Math.max(...priorRange.map(c => c.high)); const priorLow = Math.min(...priorRange.map(c => c.low)); for (const c of last5) { if (c.high > priorHigh && c.close < priorHigh) return { type: 'BEARISH_INDUCEMENT', level: +priorHigh.toFixed(5) }; if (c.low < priorLow && c.close > priorLow) return { type: 'BULLISH_INDUCEMENT', level: +priorLow.toFixed(5) }; } return null; }
function detectDisplacement(candles, atr) { const n = candles.length; if (n < 2 || !atr) return null; const last = candles[n - 1]; const body = Math.abs(last.close - last.open); const range = last.high - last.low; const bodyRatio = range > 0 ? body / range : 0; if (body > atr * 1.5 && bodyRatio > 0.65) { return { type: last.close > last.open ? 'BULLISH_DISPLACEMENT' : 'BEARISH_DISPLACEMENT', magnitude: +(body / atr).toFixed(2) }; } return null; }
function detectMitigationBlocks(candles) { const n = candles.length; if (n < 40) return []; const blocks = []; for (let i = Math.max(0, n - 40); i < n - 5; i++) { const c = candles[i]; const body = Math.abs(c.close - c.open); const localRange = Math.max(...candles.slice(Math.max(0, i - 2), Math.min(n, i + 3)).map(x => x.high)) - Math.min(...candles.slice(Math.max(0, i - 2), Math.min(n, i + 3)).map(x => x.low)); if (localRange <= 0 || body < localRange * 0.5) continue; const top = Math.max(c.high, c.open, c.close); const bottom = Math.min(c.low, c.open, c.close); let mitigated = false; for (let j = i + 1; j < n; j++) { if (candles[j].low <= top && candles[j].high >= bottom) { mitigated = true; break; } } if (mitigated) { blocks.push({ type: c.close > c.open ? 'BULLISH_BREAKER' : 'BEARISH_BREAKER', top: +top.toFixed(5), bottom: +bottom.toFixed(5) }); } } return blocks.slice(-2); }
function detectQuasimodo(candles) { const n = candles.length; if (n < 40) return null; const swings = findLastSwing(candles, 5, 5); if (!swings.swingHigh || !swings.swingLow) return null; return { lastSwingHigh: +swings.swingHigh.price.toFixed(5), lastSwingLow: +swings.swingLow.price.toFixed(5), direction: swings.swingHigh.idx > swings.swingLow.idx ? 'HIGHER_THEN_LOWER' : 'LOWER_THEN_HIGHER' }; }
function detectCVD(candles) { const n = candles.length; if (n < 20) return null; const delta = new Array(n).fill(0); let cumulative = 0; for (let i = 0; i < n; i++) { const c = candles[i]; const range = c.high - c.low; const vol = c.volume > 0 ? c.volume : 1; if (range <= 0) { delta[i] = 0; } else { delta[i] = (((c.close - c.low) - (c.high - c.close)) / range) * vol; } cumulative += delta[i]; } const slopeStart = candles[n - 11] ? candles[n - 11].close : 0; return { cvd: +cumulative.toFixed(0), lastDelta: +delta[n - 1].toFixed(0) }; }
function detectAbsorption(candles, atr) { const n = candles.length; if (n < 21 || !atr) return null; const last = candles[n - 1]; const lastVol = last.volume > 0 ? last.volume : 1; const prior = candles.slice(-21, -1); const avgVol = prior.reduce((a, c) => a + (c.volume > 0 ? c.volume : 1), 0) / 20; const body = Math.abs(last.close - last.open); const range = last.high - last.low; const bodyRatio = range > 0 ? body / range : 0; if (lastVol > avgVol * 2 && bodyRatio < 0.4 && range < atr) { const closeLoc = range > 0 ? (last.close - last.low) / range : 0.5; if (closeLoc > 0.6) return { type: 'ABSORPTION_BULL', volRatio: +(lastVol / avgVol).toFixed(2) }; if (closeLoc < 0.4) return { type: 'ABSORPTION_BEAR', volRatio: +(lastVol / avgVol).toFixed(2) }; return { type: 'ABSORPTION_NEUTRAL', volRatio: +(lastVol / avgVol).toFixed(2) }; } if (lastVol < avgVol * 0.6 && body > atr * 1.2) { return { type: last.close > last.open ? 'EXHAUSTION_BULL' : 'EXHAUSTION_BEAR', volRatio: +(lastVol / avgVol).toFixed(2) }; } return null; }
function calculateADX(candles, period = 14) { const n = candles.length; if (n < period * 2 + 1) return null; const tr = [], plusDM = [], minusDM = []; for (let i = 1; i < n; i++) { const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close; const ph = candles[i - 1].high, pl = candles[i - 1].low; tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); const upMove = h - ph; const downMove = pl - l; plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0); minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0); } let atrSmooth = tr.slice(0, period).reduce((a, b) => a + b, 0); let plusDMSmooth = plusDM.slice(0, period).reduce((a, b) => a + b, 0); let minusDMSmooth = minusDM.slice(0, period).reduce((a, b) => a + b, 0); const plusDI = [], minusDI = [], dx = []; for (let i = period; i < tr.length; i++) { atrSmooth = atrSmooth - atrSmooth / period + tr[i]; plusDMSmooth = plusDMSmooth - plusDMSmooth / period + plusDM[i]; minusDMSmooth = minusDMSmooth - minusDMSmooth / period + minusDM[i]; const pDI = atrSmooth > 0 ? (plusDMSmooth / atrSmooth) * 100 : 0; const mDI = atrSmooth > 0 ? (minusDMSmooth / atrSmooth) * 100 : 0; plusDI.push(pDI); minusDI.push(mDI); const sumDI = pDI + mDI; dx.push(sumDI > 0 ? Math.abs(pDI - mDI) / sumDI * 100 : 0); } if (dx.length < period) return null; let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period; for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period; const lastPlus = plusDI[plusDI.length - 1]; const lastMinus = minusDI[minusDI.length - 1]; let strength = 'WEAK'; if (adx > 40) strength = 'VERY_STRONG'; else if (adx > 25) strength = 'STRONG'; else if (adx > 20) strength = 'MODERATE'; let direction = 'NEUTRAL'; if (lastPlus > lastMinus) direction = 'BULLISH'; else if (lastMinus > lastPlus) direction = 'BEARISH'; return { adx: +adx.toFixed(1), plusDI: +lastPlus.toFixed(1), minusDI: +lastMinus.toFixed(1), strength, direction }; }

// ═══════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/api/calendar', async (req, res) => {
  try {
    const now = new Date(), from = new Date(now); from.setDate(from.getDate() - 1);
    const to = new Date(now); to.setDate(to.getDate() + 14);
    const { data, error } = await db.admin.from('calendar_events').select('*')
      .gte('event_date', from.toISOString().slice(0, 10)).lte('event_date', to.toISOString().slice(0, 10))
      .order('event_timestamp', { ascending: true, nullsFirst: false });
    if (error) throw error;
    const events = (data || []).map(e => ({
      date: new Date(e.event_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
      time: e.event_time || '—', timestamp: e.event_timestamp, currency: e.currency, impact: e.impact, event: e.title, actual: e.actual, forecast: e.forecast, previous: e.previous, beatMiss: e.beat_miss,
    }));
    res.json({ count: events.length, events });
  } catch (err) { res.status(500).json({ error: err.message, events: [] }); }
});

app.get('/api/news', (req, res) => {
  try { res.type('json').send(fs.readFileSync(path.join(DATA_DIR, 'investing_news.json'), 'utf8')); } 
  catch (err) { res.json({ items: [] }); }
});

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

          // MATH CALCULATIONS
          const rsi = calculateRSI(prices, 14);
          const macd = calculateMACD(prices);
          const zScore = calculateZScore(prices, 20);
          const hurst = calculateHurst(prices);
          const atr = calculateATR(candles, 14);
          const vwap = calculateVWAP(candles, 20);
          const vwapBands = calculateVWAPBands(candles, 20);
          const anchoredVwap = calculateAnchoredVWAP(candles);
          const fib = calculateFibonacci(candles);
          const valueArea = calculateValueArea(candles);
          const nakedPOCs = detectNakedPOC(candles);
          const imbalance = detectVolumeImbalance(candles);
          const bpr = detectBPR(candles);
          const sweep = detectLiquiditySweep(candles);
          const premiumDiscount = calculatePremiumDiscount(candles);
          const ote = calculateOTE(candles);
          const inducement = detectInducement(candles);
          const displacement = detectDisplacement(candles, atr);
          const mitigationBlocks = detectMitigationBlocks(candles);
          const quasimodo = detectQuasimodo(candles);
          const cvd = detectCVD(candles);
          const absorption = detectAbsorption(candles, atr);
          const adx = calculateADX(candles);
          const volRegime = calculateVolatilityPercentile(candles);

          mtfDataStr += `\n[${tf.toUpperCase()} TIMEFRAME]\n`;
          mtfDataStr += `Price: ${cp.toFixed(4)} | ATR: ${atr.toFixed(4)} | RSI: ${rsi.toFixed(1)} | MACD: ${macd.histogram > 0 ? 'BULL' : 'BEAR'}\n`;
          mtfDataStr += `Hurst: ${hurst.toFixed(2)} | VWAP: ${vwap.toFixed(4)}`;
          if (anchoredVwap) mtfDataStr += ` | Anchored VWAP: ${anchoredVwap.avwap.toFixed(4)}`;
          mtfDataStr += `\n`;
          
          if (vwapBands) mtfDataStr += `VWAP Bands: +2σ ${vwapBands.upper2.toFixed(4)} | +1σ ${vwapBands.upper1.toFixed(4)} | -1σ ${vwapBands.lower1.toFixed(4)} | -2σ ${vwapBands.lower2.toFixed(4)}\n`;
          mtfDataStr += `Fib 38.2%: ${fib.fib_0_382.toFixed(4)} | 50%: ${fib.fib_0_5.toFixed(4)} | 61.8%: ${fib.fib_0_618.toFixed(4)}\n`;
          
          if (valueArea) {
            mtfDataStr += `Value Area: VAL ${valueArea.val.toFixed(4)} | POC ${valueArea.poc.toFixed(4)} | VAH ${valueArea.vah.toFixed(4)}\n`;
            if (valueArea.voids.length > 0) {
              mtfDataStr += `Liquidity Voids: ` + valueArea.voids.map(v => `${v.low.toFixed(4)}-${v.high.toFixed(4)}`).join(', ') + `\n`;
            }
          }
          if (nakedPOCs.length > 0) mtfDataStr += `Naked POC (magnet): ` + nakedPOCs.map(n => n.price.toFixed(4)).join(', ') + `\n`;
          if (imbalance) mtfDataStr += `Volume Imbalance: ${imbalance.direction} (${imbalance.ratio}x)\n`;
          if (bpr) mtfDataStr += `BPR: ${bpr.bottom.toFixed(4)} - ${bpr.top.toFixed(4)}\n`;
          if (cvd) mtfDataStr += `CVD: ${cvd.cvd} | Delta: ${cvd.lastDelta}\n`;
          if (absorption) mtfDataStr += `Wyckoff Absorption: ${absorption.type}\n`;
          if (sweep) mtfDataStr += `Liquidity Sweep: ${sweep.type} at ${sweep.sweptLevel.toFixed(4)}\n`;
          if (premiumDiscount) mtfDataStr += `PD Zone: ${premiumDiscount.zone} (EQ: ${premiumDiscount.eq.toFixed(4)})\n`;
          if (ote) mtfDataStr += `OTE: ${ote.type} between ${ote.zoneLow.toFixed(4)} - ${ote.zoneHigh.toFixed(4)}\n`;
          if (inducement) mtfDataStr += `Inducement: ${inducement.type} at ${inducement.level.toFixed(4)}\n`;
          if (displacement) mtfDataStr += `Displacement: ${displacement.type} (${displacement.magnitude}x ATR)\n`;
          if (mitigationBlocks.length > 0) mtfDataStr += `Breaker Blocks: ` + mitigationBlocks.map(m => `${m.type} ${m.bottom.toFixed(4)}-${m.top.toFixed(4)}`).join(', ') + `\n`;
          if (quasimodo) mtfDataStr += `Quasimodo: SwingH ${quasimodo.lastSwingHigh.toFixed(4)} | SwingL ${quasimodo.lastSwingLow.toFixed(4)}\n`;
          if (adx) mtfDataStr += `ADX: ${adx.adx} (${adx.strength}) | DI+ ${adx.plusDI} | DI- ${adx.minusDI}\n`;
          if (volRegime) mtfDataStr += `Volatility Regime: ${volRegime.percentile}% (${volRegime.regime})\n`;
        }
      } catch (e) { console.error(`[signal] Failed to fetch ${tf}`); }
    }

    if (!mtfDataStr) return res.status(400).json({ error: "Could not fetch market data for this symbol." });

    const prompt = `You are an elite institutional quantitative trader. Analyze this multi-timeframe data for ${targetSymbol}.
    
    ${contextStr ? `CONTEXT:\n${contextStr}\n` : 'Pure technical analysis.'}
    
    MULTI-TIMEFRAME DATA:
    ${mtfDataStr}
    
    Based on the data above, provide a comprehensive BUY/SELL/HOLD signal. 
    You MUST explicitly cite the smart money concepts (SMC) and order flow metrics in your analysis.
    Explain exactly what the CVD is doing, where the Order Blocks and Fair Value Gaps (Voids) are, and how the price is interacting with the POC, Fib, and VWAP.
    
    Include Entry, Stop-Loss (place outside the recent swing/ATR), and Take-Profit (place at next POC, Fib, or Liquidity Void). 
    Explain your reasoning clearly.`;

    const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mistralKey}` },
      body: JSON.stringify({ model: 'open-mistral-7b', messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 2500 })
    });
    const mistralData = await mistralRes.json();
    if (!mistralRes.ok) throw new Error(mistralData.error?.message || 'Mistral Error');
    
    res.json({ signal: mistralData.choices[0].message.content });

  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
app.post('/api/auth/signup', authLimiter, async (req, res) => { try { res.json(await auth.signup(req.body)); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/auth/login', authLimiter, async (req, res) => { try { res.json({ session: await auth.login(req.body) }); } catch (err) { res.status(401).json({ error: err.message }); } });
app.post('/api/auth/forgot', authLimiter, async (req, res) => { try { res.json(await auth.forgotPin(req.body.username)); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/auth/reset-pin', authLimiter, async (req, res) => { try { res.json(await auth.resetPinWithToken(req.body.accessToken, req.body.newPin)); } catch (err) { res.status(400).json({ error: err.message }); } });
app.get('/api/auth/me', async (req, res) => { try { const token = (req.headers.authorization || '').replace('Bearer ', '').trim(); res.json({ profile: await auth.getProfile(token) }); } catch (err) { res.status(401).json({ error: err.message }); } });
app.put('/api/auth/profile', async (req, res) => { try { const token = (req.headers.authorization || '').replace('Bearer ', '').trim(); res.json({ profile: await auth.updateProfile(token, req.body) }); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/auth/refresh', async (req, res) => { try { res.json({ session: await auth.refresh(req.body.refreshToken) }); } catch (err) { res.status(401).json({ error: err.message }); } });

// ═══════════════════════════════════════════════════════════
//  TELEGRAM & PUSH
// ═══════════════════════════════════════════════════════════
app.post('/api/telegram/webhook', async (req, res) => { try { const msg = req.body?.message || req.body?.edited_message; if (msg) await tg.handleMessage(msg); } catch (err) { console.error('[webhook]', err.message); } res.sendStatus(200); });

app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { subscription, userId } = req.body || {};
    if (!subscription?.endpoint || !subscription?.keys) return res.status(400).json({ error: 'Invalid subscription' });
    await db.admin.from('push_subscriptions').upsert({
      endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, user_id: userId || null,
    }, { onConflict: 'endpoint' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function sendPushToAll(payload) {
  if (!webpush) return { sent: 0 };
  const { data: subs } = await db.admin.from('push_subscriptions').select('*');
  let sent = 0, toDelete = [];
  for (const sub of (subs || [])) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload));
      sent++;
    } catch (err) { if (err.statusCode === 410 || err.statusCode === 404) toDelete.push(sub.endpoint); }
  }
  if (toDelete.length) await db.admin.from('push_subscriptions').delete().in('endpoint', toDelete);
  return { sent };
}
global.sendPushToAll = sendPushToAll;

app.get('/api/push/test', async (req, res) => { res.json(await sendPushToAll({ title: "Will's AI — Test", body: 'Push notifications are working!', url: '/' })); });

// ═══════════════════════════════════════════════════════════
//  CRON JOBS
// ═══════════════════════════════════════════════════════════
cron.schedule('0 4 * * *', async () => { try { await require('./ffScraper').scrape(); } catch (e) { console.error('[cron] scrape:', e.message); } });
cron.schedule('*/30 * * * *', async () => { try { await require('./newsScraper').fetchAll(); } catch (e) { console.error('[cron] news:', e.message); } });
cron.schedule('* * * * *', () => { alerts.runAll().catch(e => console.error('[cron] alerts:', e.message)); });
cron.schedule('0 3 * * *', async () => {
  try { await require('./ffScraper').cleanup(); } catch (e) { console.error('[cron] cleanup ff:', e.message); }
  try { await alerts.cleanupOldLogs(); } catch (e) { console.error('[cron] cleanup logs:', e.message); }
});

setTimeout(async () => {
  try { await require('./ffScraper').scrape(); } catch (e) {}
  try { await require('./newsScraper').fetchAll(); } catch (e) {}
  try { await alerts.runAll(); } catch (e) {}
}, 5000);

// ═══════════════════════════════════════════════════════════
//  SPA CATCH-ALL & SERVER START
// ═══════════════════════════════════════════════════════════
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Will's AI running on port ${PORT}`);
  if (process.env.PUBLIC_URL && tg.hasToken && tg.useWebhook) {
    tg.setWebhook(process.env.PUBLIC_URL).catch(err => console.error('[tg] webhook setup failed:', err.message));
  }
});