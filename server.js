require('dotenv').config({ path: './.env.local' });

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');

// Import Biquote for the Signal Generator
const BiquoteModule = require('biquote');
const Biquote = BiquoteModule.Biquote || BiquoteModule.default || BiquoteModule;

const auth = require('./auth');
const db = require('./db');
const alerts = require('./alerts');
const tg = require('./telegram');

const app = express();
const PORT = process.env.PORT || 3500;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

// ── Web Push setup ──
let webpush = null;
try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@wills-ai.local',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    console.log('[push] configured');
  } else { webpush = null; }
} catch (e) { webpush = null; }

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '100kb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many attempts, please try again in 15 minutes.' },
  standardHeaders: true, legacyHeaders: false,
});

app.use(express.static(PUBLIC_DIR, {
  etag: false, lastModified: false,
  setHeaders: (res, fp) => { if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); },
}));

(function ensureDataFiles() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const newsFile = path.join(DATA_DIR, 'investing_news.json');
    if (!fs.existsSync(newsFile)) fs.writeFileSync(newsFile, JSON.stringify({ items: [] }));
  } catch (e) {}
})();

function formatDateLabel(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(String(iso).length === 10 ? `${iso}T00:00:00Z` : iso);
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  } catch { return iso; }
}

// ═══════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/api/config', (req, res) => res.json({
  supabaseUrl: db.SUPABASE_URL, supabasePublishableKey: db.PUBLISHABLE, vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
}));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/calendar', async (req, res) => {
  try {
    const now = new Date();
    const from = new Date(now); from.setDate(from.getDate() - 1);
    const to = new Date(now); to.setDate(to.getDate() + 14);
    const { data, error } = await db.admin.from('calendar_events')
      .select('*').gte('event_date', from.toISOString().slice(0, 10)).lte('event_date', to.toISOString().slice(0, 10))
      .order('event_timestamp', { ascending: true, nullsFirst: false });
    if (error) throw error;

    const events = (data || []).map(e => ({
      date: formatDateLabel(e.event_date), time: e.event_time || '—', timestamp: e.event_timestamp,
      currency: e.currency, impact: e.impact, event: e.title, actual: e.actual, forecast: e.forecast, previous: e.previous, beatMiss: e.beat_miss,
    }));
    res.json({ count: events.length, events });
  } catch (err) { res.status(500).json({ error: err.message, events: [] }); }
});

app.get('/api/news', (req, res) => {
  try { res.type('json').send(fs.readFileSync(path.join(DATA_DIR, 'investing_news.json'), 'utf8')); } 
  catch (err) { res.json({ items: [] }); }
});

// ═══════════════════════════════════════════════════════════
//  SIGNAL AI ROUTE (BIQUOTE + MISTRAL)
// ═══════════════════════════════════════════════════════════
app.post('/api/signal', async (req, res) => {
  try {
    const { symbol, timeframe } = req.body;
    const mistralKey = process.env.MISTRAL_API_KEY;

    if (!mistralKey) return res.status(500).json({ error: 'Mistral API key missing on server. Please add MISTRAL_API_KEY to .env.local' });
    if (!symbol || !timeframe) return res.status(400).json({ error: 'Symbol and timeframe required' });

    // 1. Fetch data from Biquote
    const bq = new Biquote();
    
    // Biquote uses string symbols usually like "BTCUSD" or "EURUSD"
    const ohlcData = await bq.ohlc(symbol, { interval: timeframe, limit: 150 }).catch(() => null);
    
    if (!ohlcData || !ohlcData.bars || ohlcData.bars.length < 10) {
      return res.status(400).json({ error: 'Could not fetch enough market data from Biquote for this symbol.' });
    }

    // Reverse to chronological order (oldest to newest)
    const candles = ohlcData.bars.reverse().map(b => ({
      open: b.open, high: b.high, low: b.low, close: b.close,
      volume: b.volume || 0, tickVolume: b.tickVolume || 1 
    }));

    const prices = candles.map(c => c.close);
    const n = prices.length;
    const cp = prices[n-1];

    // 2. Simple Math
    const recentHigh = Math.max(...prices.slice(-20));
    const recentLow = Math.min(...prices.slice(-20));
    const avgTickVol = candles.slice(-20, -1).reduce((a, c) => a + c.tickVolume, 0) / Math.max(1, (n - 1));
    const volumeSpike = candles[n-1].tickVolume > avgTickVol * 1.8;

    // 3. Build Prompt (Hiding Strategies)
    const prompt = `
      You are a professional quantitative trader. Analyze this market data for ${symbol} on the ${timeframe} timeframe.
      
      Current Price: ${cp}
      Recent 20-period High: ${recentHigh}
      Recent 20-period Low: ${recentLow}
      Unusual Volume Spike Detected: ${volumeSpike ? 'YES' : 'NO'}
      
      Based on this data, provide a BUY, SELL, or HOLD signal. Include a recommended Entry price, Stop-Loss, and Take-Profit.
      Keep your explanation brief.
      
      CRITICAL INSTRUCTION: Do NOT mention technical indicator names like "Hurst", "RSI", "MACD", or "Z-Score". 
      Instead, describe the market conditions using plain English (e.g., "The market is strongly trending", "Momentum is shifting", "Price is overbought").
    `;

    // 4. Call Mistral
    const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${mistralKey}` 
      },
      body: JSON.stringify({
        model: 'open-mistral-7b',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5
      })
    });

    const mistralData = await mistralRes.json();
    if (!mistralRes.ok) throw new Error(mistralData.error?.message || 'Mistral API Error');
    
    res.json({ signal: mistralData.choices[0].message.content });

  } catch (err) {
    console.error('[signal]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  try { res.json(await auth.signup(req.body || {})); } 
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try { res.json({ session: await auth.login(req.body || {}) }); } 
  catch (err) { res.status(401).json({ error: err.message }); }
});

app.post('/api/auth/forgot', authLimiter, async (req, res) => {
  try { res.json(await auth.forgotPin(req.body.username)); } 
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/auth/reset-pin', authLimiter, async (req, res) => {
  try {
    const { accessToken, newPin } = req.body;
    res.json(await auth.resetPinWithToken(accessToken, newPin));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/auth/refresh', async (req, res) => {
  try { res.json({ session: await auth.refresh(req.body.refreshToken) }); } 
  catch (err) { res.status(401).json({ error: err.message }); }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });
    res.json({ profile: await auth.getProfile(token) });
  } catch (err) { res.status(401).json({ error: err.message }); }
});

app.put('/api/auth/profile', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });
    res.json({ profile: await auth.updateProfile(token, req.body || {}) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
//  TELEGRAM & PUSH
// ═══════════════════════════════════════════════════════════
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const msg = req.body?.message || req.body?.edited_message;
    if (msg) await tg.handleMessage(msg);
  } catch (err) {}
  res.sendStatus(200);
});

app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { subscription, userId } = req.body || {};
    if (!subscription?.endpoint || !subscription?.keys) return res.status(400).json({ error: 'Invalid' });
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

app.get('/api/push/test', async (req, res) => {
  const result = await sendPushToAll({ title: "Will's AI — Test", body: 'Push notifications are working!', url: '/' });
  res.json(result);
});

// ═══════════════════════════════════════════════════════════
//  CRON JOBS
// ═══════════════════════════════════════════════════════════
cron.schedule('0 4 * * *', async () => { try { await require('./ffScraper').scrape(); } catch (e) {} });
cron.schedule('*/30 * * * *', async () => { try { await require('./newsScraper').fetchAll(); } catch (e) {} });
cron.schedule('* * * * *', () => { alerts.runAll().catch(e => console.error('[cron] alerts:', e.message)); });
cron.schedule('0 3 * * *', async () => {
  try { await require('./ffScraper').cleanup(); } catch (e) {}
  try { await alerts.cleanupOldLogs(); } catch (e) {}
});

setTimeout(async () => {
  try { await require('./ffScraper').scrape(); } catch (e) {}
  try { await require('./newsScraper').fetchAll(); } catch (e) {}
}, 5000);

// SPA Catch-All
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Will's AI running on port ${PORT}`);
  if (process.env.PUBLIC_URL && tg.hasToken && tg.useWebhook) tg.setWebhook(process.env.PUBLIC_URL);
});
