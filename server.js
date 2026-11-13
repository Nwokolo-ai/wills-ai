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
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@wills-ai.local', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  }
} catch (e) {}

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '100kb' }));

app.use(express.static(PUBLIC_DIR, {
  etag: false, lastModified: false,
  setHeaders: (res, fp) => { if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); },
}));

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

// API Routes
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
    const { symbol, timeframe, text, contextMode } = req.body;
    const mistralKey = process.env.MISTRAL_API_KEY;
    if (!mistralKey) return res.status(500).json({ error: 'Mistral API key missing.' });

    let contextStr = "";
    if (contextMode === 'events' || contextMode === 'both') {
      const today = new Date().toISOString().slice(0, 10);
      const { data: events } = await db.admin.from('calendar_events')
        .select('currency, title, impact, actual, forecast').eq('event_date', today).in('impact', ['high', 'medium']).limit(5);
      if (events && events.length > 0) {
        contextStr += "ECONOMIC EVENTS TODAY:\n";
        events.forEach(e => { contextStr += `- ${e.currency} ${e.title} (${e.impact}): F ${e.forecast || 'N/A'}, A ${e.actual || 'Pending'}\n`; });
      }
    }
    if (contextMode === 'both') {
      try {
        const newsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'investing_news.json'), 'utf8'));
        const latestNews = (newsData.items || []).slice(0, 3);
        if (latestNews.length > 0) {
          contextStr += "\nLATEST NEWS:\n";
          latestNews.forEach(n => { contextStr += `- ${n.title}\n`; });
        }
      } catch (e) {}
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
      const chatRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mistralKey}` },
        body: JSON.stringify({ model: 'open-mistral-7b', messages: [{ role: 'system', content: `You are Will's AI. Context:\n${contextStr}` }, { role: 'user', content: text }] })
      });
      const chatData = await chatRes.json();
      return res.json({ signal: chatData.choices[0].message.content });
    }

    if (!targetSymbol) return res.json({ signal: "Select a symbol or ask a question." });

    const url = `https://biquote.io/api/${targetSymbol}/ohlc?interval=${timeframe}&limit=150`;
    const ohlcData = await cachedFetch(url).catch((e) => { throw new Error(`Could not fetch market data: ${e.message}`); });
    if (!ohlcData || !ohlcData.bars || ohlcData.bars.length < 10) return res.status(400).json({ error: `Not enough market data.` });

    const prices = ohlcData.bars.map(b => b.close).reverse();
    const cp = prices[prices.length-1];
    const prompt = `Analyze ${targetSymbol} (${timeframe}).\nContext:\n${contextStr || 'Pure technical'}\nPrice: ${cp}\n20H: ${Math.max(...prices.slice(-20))}\n20L: ${Math.min(...prices.slice(-20))}\nProvide BUY/SELL/HOLD with Entry, SL, TP. Keep it brief.`;

    const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mistralKey}` },
      body: JSON.stringify({ model: 'open-mistral-7b', messages: [{ role: 'user', content: prompt }], temperature: 0.5 })
    });
    const mistralData = await mistralRes.json();
    if (!mistralRes.ok) throw new Error(mistralData.error?.message || 'Mistral Error');
    res.json({ signal: mistralData.choices[0].message.content });

  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Auth & Webhook Routes
app.post('/api/auth/signup', async (req, res) => { try { res.json(await auth.signup(req.body)); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/auth/login', async (req, res) => { try { res.json({ session: await auth.login(req.body) }); } catch (err) { res.status(401).json({ error: err.message }); } });
app.post('/api/auth/forgot', async (req, res) => { try { res.json(await auth.forgotPin(req.body.username)); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/auth/reset-pin', async (req, res) => { try { res.json(await auth.resetPinWithToken(req.body.accessToken, req.body.newPin)); } catch (err) { res.status(400).json({ error: err.message }); } });
app.get('/api/auth/me', async (req, res) => { try { const token = (req.headers.authorization || '').replace('Bearer ', '').trim(); res.json({ profile: await auth.getProfile(token) }); } catch (err) { res.status(401).json({ error: err.message }); } });
app.put('/api/auth/profile', async (req, res) => { try { const token = (req.headers.authorization || '').replace('Bearer ', '').trim(); res.json({ profile: await auth.updateProfile(token, req.body) }); } catch (err) { res.status(400).json({ error: err.message }); } });

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
    await db.admin.from('push_subscriptions').upsert({ endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, user_id: userId || null }, { onConflict: 'endpoint' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CRON JOBS (This fixes emails & Telegram)
cron.schedule('0 4 * * *', async () => { try { await require('./ffScraper').scrape(); } catch (e) {} });
cron.schedule('*/30 * * * *', async () => { try { await require('./newsScraper').fetchAll(); } catch (e) {} });
cron.schedule('* * * * *', () => { alerts.runAll().catch(e => console.error('[cron] alerts:', e.message)); });
cron.schedule('0 3 * * *', async () => { try { await require('./ffScraper').cleanup(); } catch (e) {} try { await alerts.cleanupOldLogs(); } catch (e) {} });

setTimeout(async () => {
  try { await require('./ffScraper').scrape(); } catch (e) {}
  try { await require('./newsScraper').fetchAll(); } catch (e) {}
  try { await alerts.runAll(); } catch (e) {}
}, 5000);

app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Will's AI running on port ${PORT}`);
  if (process.env.PUBLIC_URL && tg.hasToken && tg.useWebhook) tg.setWebhook(process.env.PUBLIC_URL);
});
