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

// ─── Veritasium Indicators Math ───
const { calculateRawIndicators } = require('./indicators');

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

const cache = new Map(), TTL = 30_000; 
async function cachedFetch(url) {
  const hit = cache.get(url); if (hit && hit.expires > Date.now()) return hit.data;
  const resp = await fetch(url); if (!resp.ok) throw new Error(`Biquote Error: ${resp.status}`);
  const data = await resp.json(); cache.set(url, { data, expires: Date.now() + TTL }); return data;
}

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

// ─── SIGNAL AI ROUTE (Biquote 7-TF + Smart Events + Chart Data) ───
app.post('/api/signal', async (req, res) => {
  try {
    const { symbol, timeframe, text, contextMode } = req.body;
    const mistralKey = process.env.MISTRAL_API_KEY;
    if (!mistralKey) return res.status(500).json({ error: 'Mistral API key missing.' });

    let targetSymbol = symbol;
    if (!targetSymbol || targetSymbol === "GENERAL") {
      const lower = (text || "").toLowerCase();
      if (lower.includes('gold') || lower.includes('xau')) targetSymbol = 'XAUUSD';
      else if (lower.includes('eur')) targetSymbol = 'EURUSD';
      else if (lower.includes('gbp')) targetSymbol = 'GBPUSD';
      else if (lower.includes('btc')) targetSymbol = 'BTCUSD';
      else if (lower.includes('silver') || lower.includes('xag')) targetSymbol = 'XAGUSD';
    }

    // 1. Handle standard chat (no market analysis)
    if (!targetSymbol && text) {
      const chatRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${mistralKey}`
  },
  body: JSON.stringify({
    model: 'mistral-small-latest',
    messages: [
      { role: 'user', content: text }
    ],
    temperature: 0.3
  })
});

const chatData = await chatRes.json();

if (!chatRes.ok) {
  throw new Error(
    chatData.error?.message || `Mistral API error: ${chatRes.status}`
  );
}

const chatMessage = chatData.choices?.[0]?.message?.content;

if (!chatMessage) {
  throw new Error('Mistral returned an empty response.');
}

return res.json({
  signal: chatMessage,
  isDataAnalysis: false
});

    if (!targetSymbol) return res.json({ signal: "Select a symbol or ask a question.", isDataAnalysis: false });

    // 2. Fetch 7 Timeframes from Biquote
    const timeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
    const tfData = {};
    const allChartCandles = {}; // Store candles for the chart
    
    await Promise.all(timeframes.map(async (tf) => {
      try {
        const url = `https://biquote.io/api/${targetSymbol}/ohlc?interval=${tf}&limit=150`;
        const ohlcData = await cachedFetch(url);
        
        if (ohlcData && ohlcData.bars && ohlcData.bars.length >= 60) {
          const candles = ohlcData.bars.map(b => ({
            open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0, time: b.time
          }));
          const calculated = calculateRawIndicators(candles);
          
          if (calculated) {
            tfData[tf] = calculated;
            allChartCandles[tf] = candles; // Save for chart
          }
        }
      } catch (e) { console.warn(`Failed to fetch ${tf} for ${targetSymbol}:`, e.message); }
    }));

    if (Object.keys(tfData).length === 0) {
  const fallbackRes = await fetch(
    'https://api.mistral.ai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${mistralKey}`
      },
      body: JSON.stringify({
        model: 'mistral-small-latest',
        messages: [
          {
            role: 'system',
            content: `You are the AI assistant for Will's AI trading platform.

Live market data is currently unavailable from the market data provider.

Do not invent prices, candles, indicators, market conditions, entry prices, stop losses, take profits, or BUY/SELL signals.

Explain clearly that a verified live trading analysis cannot be produced without market data.

You may still answer general questions about trading, mathematics, technical analysis, and financial markets.`
          },
          {
            role: 'user',
            content: text || `I requested a trading analysis for ${targetSymbol}, but live market data is unavailable. Explain what this means.`
          }
        ],
        temperature: 0.2
      })
    }
  );

  const fallbackData = await fallbackRes.json();

  if (!fallbackRes.ok) {
    throw new Error(
      fallbackData.error?.message || 'Mistral fallback request failed.'
    );
  }

  const fallbackMessage = fallbackData.choices?.[0]?.message?.content;

  if (!fallbackMessage) {
    throw new Error('Mistral returned an empty fallback response.');
  }

  return res.json({
    signal: fallbackMessage,
    isDataAnalysis: false,
    marketDataUnavailable: true,
    symbol: targetSymbol
  });
}

    // 3. Build the Macro Context (News & Events)
    let contextStr = "";
    if (contextMode === 'events' || contextMode === 'both') {
      const today = new Date().toISOString().slice(0, 10);
      const { data: events } = await db.admin.from('calendar_events')
        .select('currency, title, impact, actual, forecast, previous, beat_miss')
        .eq('event_date', today).in('impact', ['high', 'medium']).limit(8); 
        
      if (events && events.length > 0) {
        contextStr += "ECONOMIC EVENTS TODAY:\n";
        events.forEach(e => { 
          let details = [];
          if (e.previous && e.previous.trim() !== '' && e.previous !== '—') details.push(`Previous: ${e.previous}`);
          if (e.forecast && e.forecast.trim() !== '' && e.forecast !== '—') details.push(`Forecast: ${e.forecast}`);
          if (e.actual && e.actual.trim() !== '' && e.actual !== '—') details.push(`Actual: ${e.actual}`);
          if (e.beat_miss && e.beat_miss.trim() !== '') details.push(`Result: ${e.beat_miss}`);
          
          let dataString = details.length > 0 ? details.join(' | ') : 'No numerical data released yet';
          contextStr += `- ${e.currency} ${e.title} (${e.impact.toUpperCase()}): ${dataString}\n`; 
        });
      } else {
        contextStr += "ECONOMIC EVENTS TODAY: None reported yet.\n";
      }
    }

    if (contextMode === 'both') {
      try {
        const newsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'investing_news.json'), 'utf8'));
        const latestNews = (newsData.items || []).slice(0, 3); 
        if (latestNews.length > 0) { 
          contextStr += "\nLATEST MACRO NEWS:\n"; 
          latestNews.forEach(n => { contextStr += `- ${n.title}\n`; }); 
        }
      } catch (e) {
        console.warn("Could not read news file for AI context:", e.message);
      }
    }

    // 4. Build the STRICT Institutional Prompt for Mistral
    let prompt = `SYMBOL: ${targetSymbol}\n`;
    if (contextStr) {
      prompt += `\n--- MACRO CONTEXT ---\n${contextStr}\n---------------------\n\n`;
    } else {
      prompt += `\n--- MACRO CONTEXT ---\nUser requested PRICE ACTION ONLY.\n---------------------\n\n`;
    }

    prompt += `RAW MULTI-TF DATA + QUANT + ORDER FLOW + VOLUME PROFILE\n\n`;
    for (const [tf, data] of Object.entries(tfData)) {
      if (!data) continue;
      prompt += `⏱ ${tf.toUpperCase()} TIMEFRAME\n`;
      prompt += `Price: $${data.price.toFixed(4)} | ATR: $${data.atr.toFixed(4)}\n`;
      if (data.volatilityPercentile) prompt += `Vol Regime: ${data.volatilityPercentile.regime} (${data.volatilityPercentile.percentile}%ile)\n`;
      prompt += `RSI: ${data.rsi.toFixed(1)} | MACD Hist: ${data.macd.histogram.toFixed(4)} | Z-Score: ${data.zScore.toFixed(2)} | Hurst: ${data.hurst.toFixed(2)}\n`;
      if (data.cvd) prompt += `CVD Trend: ${data.cvd.trend}\n`;
      if (data.valueArea) prompt += `Value Area: VAL $${data.valueArea.val} | POC $${data.valueArea.poc} | VAH $${data.valueArea.vah}\n`;
      prompt += `\n`;
    }

    const systemPrompt = `You are a ruthless, institutional algorithmic trader. You do NOT guess. You only trade when there is absolute confluence. 

RULES FOR YOUR ANALYSIS:
1. TIMEFRAME SELECTION: Scan all 7 timeframes. Choose the ONE "Primary Timeframe" that offers the clearest trend, best volume profile alignment, and safest Stop Loss placement.
2. You MUST output your chosen timeframe exactly like this on the first line: "PRIMARY TIMEFRAME: [1m|5m|15m|30m|1h|4h|1d]".
3. HTF DOMINANCE: The 1D and 4h trend ALWAYS overrules the 1m and 5m. If 1D is bearish, you only look for SELL setups.
4. CONFLICT = HOLD: If the technicals disagree with the Volume Profile, or if the HTF disagrees with LTF, you MUST output HOLD.
5. NEWS FILTER: If a High Impact event is pending (Actual is missing), DO NOT trade. Output HOLD.
6. RISK PROTOCOL: Your Stop Loss must be placed behind a recent swing high/low or the POC/ orderblock/1 ATR. 
7. BEHAVIOR: perfect analysis, don't make wrong decisions 
8. STRICT FORMATTING: At the VERY END of your response, you MUST output the trade levels EXACTLY in this format (replace X with numbers). If the signal is HOLD, put "0" for all numbers:
---TRADE LEVELS---
ENTRY: X
SL: X
TP: X`;

    const userPrompt = `Data for ${targetSymbol}:\n${prompt}\n\nAnalyze the data. Pick the best Primary Timeframe, then output a signal (BUY, SELL, or HOLD) with the strict trade levels format.`;

    // 5. Send to Mistral (Mixtral 8x7B)
    const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST', 
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mistralKey}` },
      body: JSON.stringify({ 
        model: 'open-mixtral-8x7b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ], 
        temperature: 0.1 
      })
    });
    
    const mistralData = await mistralRes.json();
    if (!mistralRes.ok) throw new Error(mistralData.error?.message || 'Mistral error');
    
    // 6. Send Response Back to Frontend
    res.json({ 
      signal: mistralData.choices[0].message.content, 
      isDataAnalysis: true,
      rawData: tfData,
      symbol: targetSymbol,
      allChartCandles: allChartCandles
    });

  } catch (err) { 
    console.error("Signal API Error:", err);
    res.status(500).json({ error: err.message }); 
  }
});

// ─── AUTH & OTHER ROUTES ───
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
app.post('/api/auth/signup', authLimiter, async (req, res) => { try { res.json(await auth.signup(req.body)); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/auth/login', authLimiter, async (req, res) => { try { res.json({ session: await auth.login(req.body) }); } catch (err) { res.status(401).json({ error: err.message }); } });
app.post('/api/auth/forgot', authLimiter, async (req, res) => { try { res.json(await auth.forgotPin(req.body.username)); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/auth/reset-pin', authLimiter, async (req, res) => { try { res.json(await auth.resetPinWithToken(req.body.accessToken, req.body.newPin)); } catch (err) { res.status(400).json({ error: err.message }); } });
app.get('/api/auth/me', async (req, res) => { try { const token = (req.headers.authorization || '').replace('Bearer ', '').trim(); res.json({ profile: await auth.getProfile(token) }); } catch (err) { res.status(401).json({ error: err.message }); } });
app.put('/api/auth/profile', async (req, res) => { try { const token = (req.headers.authorization || '').replace('Bearer ', '').trim(); res.json({ profile: await auth.updateProfile(token, req.body) }); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/auth/refresh', async (req, res) => { try { res.json({ session: await auth.refresh(req.body.refreshToken) }); } catch (err) { res.status(401).json({ error: err.message }); } });

app.post('/api/telegram/webhook', async (req, res) => { try { const msg = req.body?.message || req.body?.edited_message; if (msg) await tg.handleMessage(msg); } catch (err) {} res.sendStatus(200); });
app.post('/api/push/subscribe', async (req, res) => { try { const { subscription, userId } = req.body || {}; await db.admin.from('push_subscriptions').upsert({ endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, user_id: userId || null }, { onConflict: 'endpoint' }); res.json({ ok: true }); } catch (err) { res.status(500).json({ error: err.message }); } });
async function sendPushToAll(payload) {
  if (!webpush) return { sent: 0 };
  const { data: subs } = await db.admin.from('push_subscriptions').select('*'); let sent = 0, toDelete = [];
  for (const sub of (subs || [])) { try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload)); sent++; } catch (err) { if (err.statusCode === 410 || err.statusCode === 404) toDelete.push(sub.endpoint); } }
  if (toDelete.length) await db.admin.from('push_subscriptions').delete().in('endpoint', toDelete); return { sent };
}
global.sendPushToAll = sendPushToAll;
app.get('/api/push/test', async (req, res) => { res.json(await sendPushToAll({ title: "Will's AI — Test", body: 'Push notifications are working!', url: '/' })); });

// CRON JOBS
cron.schedule('0 4 * * *', async () => { try { await require('./ffScraper').scrape(); } catch (e) {} });
cron.schedule('*/30 * * * *', async () => { try { await require('./newsScraper').fetchAll(); } catch (e) {} });
cron.schedule('* * * * *', () => { alerts.runAll().catch(e => console.error('[cron] alerts:', e.message)); });
cron.schedule('0 3 * * *', async () => { try { await require('./ffScraper').cleanup(); } catch (e) {} try { await alerts.cleanupOldLogs(); } catch (e) {} });

setTimeout(async () => { try { await require('./ffScraper').scrape(); } catch (e) {} try { await require('./newsScraper').fetchAll(); } catch (e) {} try { await alerts.runAll(); } catch (e) {} }, 5000);

app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.listen(PORT, '0.0.0.0', () => { console.log(`Will's AI running on port ${PORT}`); if (process.env.PUBLIC_URL && tg.hasToken && tg.useWebhook) tg.setWebhook(process.env.PUBLIC_URL); });
