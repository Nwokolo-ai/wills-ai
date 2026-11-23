// indicators.js
function linregSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  for (let i = period - 1; i < values.length; i++) {
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let j = 0; j < period; j++) {
      const x = j, y = values[i - period + 1 + j];
      sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
    }
    const denom = period * sumXX - sumX * sumX;
    if (denom === 0) { out[i] = values[i]; continue; }
    const slope = (period * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / period;
    out[i] = intercept + slope * (period - 1);
  }
  return out;
}

function calculateStdDev(values, mean) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += (v - mean) ** 2;
  return Math.sqrt(sum / values.length);
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d >= 0) gainSum += d; else lossSum -= d;
  }
  let avgGain = gainSum / period, avgLoss = lossSum / period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calculateMACD(prices) {
  if (prices.length < 35) return { macd: 0, signal: 0, histogram: 0 };
  const lr12 = linregSeries(prices, 12);
  const lr26 = linregSeries(prices, 26);
  const macdLine = [];
  for (let i = 25; i < prices.length; i++) {
    if (lr12[i] !== null && lr26[i] !== null) macdLine.push(lr12[i] - lr26[i]);
  }
  if (macdLine.length < 9) return { macd: macdLine[macdLine.length - 1] || 0, signal: macdLine[macdLine.length - 1] || 0, histogram: 0 };
  const signalSeries = linregSeries(macdLine, 9);
  const macd = macdLine[macdLine.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  return { macd, signal, histogram: macd - signal };
}

function calculateZScore(prices, lookback = 20) {
  if (prices.length < lookback) return 0;
  const slice = prices.slice(-lookback);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const std = calculateStdDev(slice, mean);
  if (std === 0) return 0;
  return (prices[prices.length - 1] - mean) / std;
}

function calculateHurst(prices) {
  if (prices.length < 100) return 0.5;
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    const r = Math.log(prices[i] / prices[i - 1]);
    if (isFinite(r)) returns.push(r);
  }
  if (returns.length < 80) return 0.5;
  const maxLag = Math.floor(returns.length / 2), minLag = 10;
  const lags = [], rsVals = [];
  for (let lag = minLag; lag <= maxLag; lag = Math.floor(lag * 1.5)) {
    const sections = Math.floor(returns.length / lag);
    if (sections < 2) continue;
    let rsSum = 0, count = 0;
    for (let s = 0; s < sections; s++) {
      const slice = returns.slice(s * lag, (s + 1) * lag);
      const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
      let cum = 0, maxCum = -Infinity, minCum = Infinity;
      for (const v of slice) {
        cum += v - mean;
        if (cum > maxCum) maxCum = cum;
        if (cum < minCum) minCum = cum;
      }
      const R = maxCum - minCum;
      const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
      const S = Math.sqrt(variance);
      if (S > 0 && R > 0) { rsSum += R / S; count++; }
    }
    if (count > 0) {
      const avg = rsSum / count;
      if (avg > 0) { lags.push(Math.log(lag)); rsVals.push(Math.log(avg)); }
    }
  }
  if (lags.length < 3) return 0.5;
  const n = lags.length;
  const sumX = lags.reduce((a, b) => a + b, 0);
  const sumY = rsVals.reduce((a, b) => a + b, 0);
  const sumXY = lags.reduce((a, x, i) => a + x * rsVals[i], 0);
  const sumX2 = lags.reduce((a, x) => a + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0.5;
  return Math.max(0, Math.min(1, (n * sumXY - sumX * sumY) / denom));
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return atr;
}

function calculateATRSeries(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;
  const tr = [];
  for (let i = 1; i < n; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = atr;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i + 1] = atr;
  }
  return out;
}

function calculateVolatilityPercentile(candles, lookback = 100, period = 14) {
  const n = candles.length;
  if (n < period + 20) return null;
  const atrSeries = calculateATRSeries(candles, period);
  const atrPct = [];
  for (let i = period; i < n; i++) {
    if (atrSeries[i] == null) continue;
    const price = candles[i].close;
    if (price > 0 && atrSeries[i] > 0) atrPct.push(atrSeries[i] / price);
  }
  if (atrPct.length < 20) return null;
  const current = atrPct[atrPct.length - 1];
  const hist = atrPct.slice(-lookback);
  let below = 0;
  for (const v of hist) if (v < current) below++;
  const percentile = (below / hist.length) * 100;
  let regime = 'NORMAL';
  if (percentile >= 90) regime = 'EXTREME_HIGH';
  else if (percentile >= 75) regime = 'HIGH';
  else if (percentile >= 50) regime = 'ELEVATED';
  else if (percentile >= 25) regime = 'NORMAL';
  else if (percentile >= 10) regime = 'LOW';
  else regime = 'EXTREME_LOW';
  return { percentile: +percentile.toFixed(1), regime };
}

function calculateValueArea(candles, bins = 20, vaPercent = 0.70) {
  const slice = candles.slice(-100);
  if (slice.length < 20) return null;
  const minP = Math.min(...slice.map(c => c.low));
  const maxP = Math.max(...slice.map(c => c.high));
  const rangeP = maxP - minP;
  if (rangeP <= 0) return null;
  const binSize = rangeP / bins;
  const profile = new Array(bins).fill(0);
  for (const c of slice) {
    const typical = (c.high + c.low + c.close) / 3;
    const idx = Math.min(bins - 1, Math.floor((typical - minP) / binSize));
    profile[idx] += c.volume > 0 ? c.volume : 1;
  }
  const totalVol = profile.reduce((a, b) => a + b, 0);
  const maxVol = Math.max(...profile);
  const pocIdx = profile.indexOf(maxVol);
  const poc = minP + (pocIdx + 0.5) * binSize;

  let lowerIdx = pocIdx, upperIdx = pocIdx, captured = profile[pocIdx];
  const target = totalVol * vaPercent;
  while (captured < target && (lowerIdx > 0 || upperIdx < bins - 1)) {
    const upVol = upperIdx < bins - 1 ? profile[upperIdx + 1] : -1;
    const downVol = lowerIdx > 0 ? profile[lowerIdx - 1] : -1;
    if (upVol >= downVol) { upperIdx++; captured += profile[upperIdx]; } 
    else { lowerIdx--; captured += profile[lowerIdx]; }
  }
  const vah = minP + (upperIdx + 0.5) * binSize;
  const val = minP + (lowerIdx + 0.5) * binSize;
  return { poc: +poc.toFixed(5), vah: +vah.toFixed(5), val: +val.toFixed(5) };
}

function calculateCVD(candles) {
  const n = candles.length;
  if (n < 20) return null;
  const delta = new Array(n).fill(0);
  let cumulative = 0;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const range = c.high - c.low;
    const vol = c.volume > 0 ? c.volume : 1;
    if (range > 0) delta[i] = (((c.close - c.low) - (c.high - c.close)) / range) * vol;
    cumulative += delta[i];
  }
  const cvdChange = cumulative - candles.slice(-11, -1).reduce((a, c) => a + (((c.close - c.low) - (c.high - c.close)) / (c.high - c.low || 1)) * (c.volume || 1), 0);
  const avgDelta = delta.slice(-20).reduce((a, b) => a + Math.abs(b), 0) / 20 || 1;
  
  let trend = 'FLAT';
  if (cvdChange > avgDelta) trend = 'STRONG_BULLISH';
  else if (cvdChange > 0) trend = 'BULLISH';
  else if (cvdChange < -avgDelta) trend = 'STRONG_BEARISH';
  else if (cvdChange < 0) trend = 'BEARISH';
  return { cvd: +cumulative.toFixed(0), trend };
}

function calculateVWAPBands(candles, lookback = 20) {
  const slice = candles.slice(-lookback);
  if (slice.length === 0) return null;
  let pvSum = 0, volSum = 0;
  for (const c of slice) {
    const typical = (c.high + c.low + c.close) / 3;
    const vol = c.volume > 0 ? c.volume : 1;
    pvSum += typical * vol;
    volSum += vol;
  }
  if (volSum <= 0) return null;
  const vwap = pvSum / volSum;
  return { vwap: +vwap.toFixed(5) };
}

function calculateRawIndicators(candles) {
  if (!candles || candles.length < 60) return null;
  const prices = candles.map(c => c.close);
  const n = prices.length;
  const cp = prices[n - 1];
  
  return {
    price: cp,
    rsi: calculateRSI(prices, 14),
    macd: calculateMACD(prices),
    zScore: calculateZScore(prices, 20),
    hurst: calculateHurst(prices),
    atr: calculateATR(candles, 14),
    volatilityPercentile: calculateVolatilityPercentile(candles, 100, 14),
    valueArea: calculateValueArea(candles, 20, 0.70),
    cvd: calculateCVD(candles),
    vwapBands: calculateVWAPBands(candles, 20)
  };
}

module.exports = { calculateRawIndicators };
