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
const IS_PROD = process.env.NODE_ENV === 'production';

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
  } else {
    console.warn('[push] VAPID keys missing');
    webpush = null;
  }
} catch (e) {
  console.warn('[push] web-push unavailable:', e.message);
  webpush = null;
}

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  setHeaders: (res, fp) => {
    if (fp.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    }
  },
}));

// ── Ensure data dir + news file exist (prevents /api/news 500 on cold start) ──
(function ensureDataFiles() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const newsFile = path.join(DATA_DIR, 'investing_news.json');
    if (!fs.existsSync(newsFile)) {
      fs.writeFileSync(newsFile, JSON.stringify({ items: [], fetched_at: new Date().toISOString() }, null, 2));
      console.log('[boot] seeded empty investing_news.json');
    }
  } catch (e) {
    console.warn('[boot] ensureDataFiles failed:', e.message);
  }
})();

function formatDateLabel(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(String(iso).length === 10 ? `${iso}T00:00:00Z` : iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  } catch { return iso; }
}

// ═══════════════════════════════════════════════════════════
//  PUBLIC CONFIG / HEALTH
// ═══════════════════════════════════════════════════════════
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: db.SUPABASE_URL,
    supabasePublishableKey: db.PUBLISHABLE,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    mode: process.env.MODE || 'scrape',
    uptime: Math.round(process.uptime()),
  });
});

// ═══════════════════════════════════════════════════════════
//  CALENDAR
// ═══════════════════════════════════════════════════════════
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
      timestamp: e.event_timestamp,
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
    console.error('[api/calendar]', err.message);
    res.status(500).json({ error: err.message, events: [] });
  }
});

// ═══════════════════════════════════════════════════════════
//  NEWS
// ═══════════════════════════════════════════════════════════
app.get('/api/news', (req, res) => {
  const file = path.join(DATA_DIR, 'investing_news.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    res.type('json').send(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Cold start — return empty, not 500
      return res.json({ items: [], fetched_at: null, note: 'not yet scraped' });
    }
    console.error('[api/news]', err.message);
    res.status(500).json({ error: err.message, items: [] });
  }
});

// ═══════════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════════
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, pin, email } = req.body || {};
    res.json(await auth.signup({ username, pin, email }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, pin } = req.body || {};
    res.json({ session: await auth.login({ username, pin }) });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    res.json({ session: await auth.refresh(refreshToken) });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });
    res.json({ profile: await auth.getProfile(token) });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.put('/api/auth/profile', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });
    res.json({ profile: await auth.updateProfile(token, req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  TELEGRAM WEBHOOK
// ═══════════════════════════════════════════════════════════
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const msg = req.body?.message || req.body?.edited_message;
    if (msg) await tg.handleMessage(msg);
  } catch (err) {
    console.error('[webhook]', err.message);
  }
  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════
//  PUSH SUBSCRIPTIONS
// ═══════════════════════════════════════════════════════════
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { subscription, userId } = req.body || {};
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    const row = {
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      user_id: userId || null,
    };
    const { error } = await db.admin.from('push_subscriptions').upsert(row, { onConflict: 'endpoint' });
    if (error) throw error;
    console.log('[push] subscribed');
    res.json({ ok: true });
  } catch (err) {
    console.error('[push] subscribe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function sendPushToAll(payload) {
  if (!webpush) return { sent: 0, failed: 0 };
  const { data: subs, error } = await db.admin.from('push_subscriptions').select('*');
  if (error) {
    console.error('[push] fetch subs failed:', error.message);
    return { sent: 0, failed: 0 };
  }
  if (!subs?.length) return { sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  const toDelete = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 410 || err.statusCode === 404) toDelete.push(sub.endpoint);
    }
  }
  if (toDelete.length) {
    await db.admin.from('push_subscriptions').delete().in('endpoint', toDelete);
  }
  console.log(`[push] sent=${sent} failed=${failed}`);
  return { sent, failed };
}

global.sendPushToAll = sendPushToAll;

// Test endpoint — requires secret to avoid public abuse
app.get('/api/push/test', async (req, res) => {
  const secret = process.env.PUSH_TEST_SECRET;
  if (!secret || req.query.secret !== secret) {
    return res.status(404).json({ error: 'Not found' });
  }
  const result = await sendPushToAll({
    title: "Will's AI — Test",
    body: 'Push notifications are working!',
    url: '/',
  });
  res.json(result);
});

// ═══════════════════════════════════════════════════════════
//  CRON JOBS
// ═══════════════════════════════════════════════════════════
cron.schedule('0 4 * * *', async () => {
  console.log('[cron] daily calendar refresh');
  try {
    const { scrape } = require('./ffScraper');
    await scrape();
  } catch (e) {
    console.error('[cron] calendar:', e.message);
  }
});

cron.schedule('*/30 * * * *', async () => {
  console.log('[cron] news fetch');
  try {
    const { fetchAll } = require('./newsScraper');
    await fetchAll();
  } catch (e) {
    console.error('[cron] news:', e.message);
  }
});

// Alerts loop — every minute. Runs once per minute, not per-event.
cron.schedule('* * * * *', () => {
  alerts.runAll().catch(e => console.error('[cron] alerts:', e.message));
});

cron.schedule('0 3 * * *', async () => {
  try {
    const { cleanup } = require('./ffScraper');
    await cleanup();
  } catch (e) { console.error('[cron] ff cleanup:', e.message); }
  try {
    await alerts.cleanupOldLogs();
  } catch (e) { console.error('[cron] alerts cleanup:', e.message); }
});

// ═══════════════════════════════════════════════════════════
//  BOOT — initial fetch (delayed so server can start)
// ═══════════════════════════════════════════════════════════
setTimeout(async () => {
  console.log('[boot] initial fetch');
  try {
    const { scrape } = require('./ffScraper');
    await scrape();
  } catch (e) {
    console.error('[boot] cal:', e.message);
  }
  try {
    const { fetchAll } = require('./newsScraper');
    await fetchAll();
  } catch (e) {
    console.error('[boot] news:', e.message);
  }
  try {
    await alerts.runAll();
    console.log('[boot] alert check done');
  } catch (e) {
    console.error('[boot] alerts:', e.message);
  }
}, 5000);

// ═══════════════════════════════════════════════════════════
//  SPA CATCH-ALL — must NOT intercept /api/*
// ═══════════════════════════════════════════════════════════
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Explicit 404 for unknown /api routes so JSON clients get JSON back
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// ═══════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Will's AI → http://localhost:${PORT}`);
  console.log(`MODE: ${process.env.MODE || 'scrape'}`);
  console.log(`ENV: ${process.env.NODE_ENV || 'development'}`);

  const PUBLIC_URL = process.env.PUBLIC_URL || '';
  if (PUBLIC_URL && tg.hasToken && tg.useWebhook) {
    tg.setWebhook(PUBLIC_URL).catch(() => {});
  } else if (tg.hasToken && !tg.useWebhook) {
    console.log('[boot] Telegram POLLING');
  }
});

// ═══════════════════════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
