require('dotenv').config({ path: './.env.local' });

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');

const auth = require('./auth');
const db = require('./db');
const alerts = require('./alerts');
const tg = require('./telegram');

const app = express();
const PORT = process.env.PORT || 3500;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(PUBLIC_DIR, {
  etag: false, lastModified: false,
  setHeaders: (res, fp) => {
    if (fp.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    }
  },
}));

function formatDateLabel(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

app.get('/api/config', (req, res) => {
  res.json({ supabaseUrl: db.SUPABASE_URL, supabasePublishableKey: db.PUBLISHABLE });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), mode: process.env.MODE || 'scrape' });
});

app.get('/api/calendar', async (req, res) => {
  try {
    const now = new Date();
    const from = new Date(now); from.setDate(from.getDate() - 1);
    const to = new Date(now); to.setDate(to.getDate() + 14);

    const { data, error } = await db.admin.from('calendar_events')
      .select('*')
      .gte('event_date', from.toISOString().slice(0, 10))
      .lte('event_date', to.toISOString().slice(0, 10))
      .order('event_timestamp', { ascending: true, nullsFirst: false });

    if (error) throw error;

    const events = (data || []).map(e => ({
      date: formatDateLabel(e.event_date),
      time: e.event_time || '—',
      currency: e.currency,
      impact: e.impact,
      event: e.title,
      actual: e.actual,
      forecast: e.forecast,
      previous: e.previous,
      beatMiss: e.beat_miss,
    }));

    res.json({
      scraped_at: new Date().toISOString(),
      month: now.toLocaleString('en-US', { month: 'short', year: 'numeric' }),
      count: events.length,
      events,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, events: [] });
  }
});

app.get('/api/news', (req, res) => {
  try {
    res.type('json').send(fs.readFileSync(path.join(DATA_DIR, 'investing_news.json'), 'utf8'));
  } catch (err) {
    res.status(500).json({ error: err.message, items: [] });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, pin, email } = req.body || {};
    res.json(await auth.signup({ username, pin, email }));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, pin } = req.body || {};
    res.json({ session: await auth.login({ username, pin }) });
  } catch (err) { res.status(401).json({ error: err.message }); }
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    res.json({ session: await auth.refresh(refreshToken) });
  } catch (err) { res.status(401).json({ error: err.message }); }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    res.json({ profile: await auth.getProfile(token) });
  } catch (err) { res.status(401).json({ error: err.message }); }
});

app.put('/api/auth/profile', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    res.json({ profile: await auth.updateProfile(token, req.body || {}) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const msg = req.body?.message || req.body?.edited_message;
    if (msg) await tg.handleMessage(msg);
  } catch (err) { console.error('[webhook]', err.message); }
  res.sendStatus(200);
});

cron.schedule('0 */6 * * *', async () => {
  console.log('[cron] calendar fetch');
  try { const { scrape } = require('./ffScraper'); await scrape(); }
  catch (e) { console.error('[cron] calendar:', e.message); }
});

cron.schedule('*/30 * * * *', async () => {
  console.log('[cron] news fetch');
  try { const { fetchAll } = require('./newsScraper'); await fetchAll(); }
  catch (e) { console.error('[cron] news:', e.message); }
});

cron.schedule('* * * * *', () => {
  alerts.runAll().catch(e => console.error('[cron] alerts:', e.message));
});

cron.schedule('0 3 * * *', async () => {
  try { const { cleanup } = require('./ffScraper'); await cleanup(); } catch {}
  try { await alerts.cleanupOldLogs(); } catch {}
});

setTimeout(async () => {
  console.log('[boot] initial fetch');
  try { const { scrape } = require('./ffScraper'); await scrape(); } catch (e) { console.error('[boot] cal:', e.message); }
  try { const { fetchAll } = require('./newsScraper'); await fetchAll(); } catch (e) { console.error('[boot] news:', e.message); }
  try { await alerts.runAll(); console.log('[boot] alert check done'); } catch (e) { console.error('[boot] alerts:', e.message); }
}, 5000);

app.get(/.*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Will's AI → http://localhost:${PORT}`);
  console.log(`MODE: ${process.env.MODE || 'scrape'}`);

  const PUBLIC_URL = process.env.PUBLIC_URL || '';
  if (PUBLIC_URL && tg.hasToken && tg.useWebhook) {
    tg.setWebhook(PUBLIC_URL).catch(() => {});
  } else if (tg.hasToken && !tg.useWebhook) {
    console.log('[boot] Telegram POLLING mode');
  }
});
