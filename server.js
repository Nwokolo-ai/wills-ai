require('dotenv').config({ path: './.env.local' });

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit'); // NEW

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
  } else {
    console.warn('[push] VAPID keys missing');
    webpush = null;
  }
} catch (e) { webpush = null; }

app.set('trust proxy', 1); // Required for rate-limit on Render/Railway
app.use(cors());
app.use(express.json({ limit: '100kb' }));

// ── Rate Limiting ──
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 login attempts per window
  message: { error: 'Too many attempts, please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.static(PUBLIC_DIR, {
  etag: false, lastModified: false,
  setHeaders: (res, fp) => {
    if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

// Data safety check
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
  supabaseUrl: db.SUPABASE_URL,
  supabasePublishableKey: db.PUBLISHABLE,
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
}));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

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

    res.json({ count: events.length, events });
  } catch (err) {
    res.status(500).json({ error: err.message, events: [] });
  }
});

app.get('/api/news', (req, res) => {
  try { res.type('json').send(fs.readFileSync(path.join(DATA_DIR, 'investing_news.json'), 'utf8')); } 
  catch (err) { res.json({ items: [] }); }
});

// ── Auth Routes ──
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  try { res.json(await auth.signup(req.body || {})); } 
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try { res.json({ session: await auth.login(req.body || {}) }); } 
  catch (err) { res.status(401).json({ error: err.message }); }
});

// NEW: Forgot PIN Route
app.post('/api/auth/forgot', authLimiter, async (req, res) => {
  try { res.json(await auth.forgotPin(req.body.username)); } 
  catch (err) { res.status(400).json({ error: err.message }); }
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

// ── Push & Telegram ──
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
      endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth, user_id: userId || null,
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

// ═══════════════════════════════════════════════════════════
//  CRON JOBS (Auto Cleanup & Scraping)
// ═══════════════════════════════════════════════════════════
cron.schedule('0 4 * * *', async () => {
  try { await require('./ffScraper').scrape(); } catch (e) {}
});

cron.schedule('*/30 * * * *', async () => {
  try { await require('./newsScraper').fetchAll(); } catch (e) {}
});

cron.schedule('* * * * *', () => {
  alerts.runAll().catch(e => console.error('[cron] alerts:', e.message));
});

// NEW: Daily Cleanup at 3 AM (Removes old events & logs)
cron.schedule('0 3 * * *', async () => {
  console.log('[cron] Daily database cleanup running...');
  try { await require('./ffScraper').cleanup(); } catch (e) { console.error(e.message); }
  try { await alerts.cleanupOldLogs(); } catch (e) { console.error(e.message); }
});

// Boot
setTimeout(async () => {
  try { await require('./ffScraper').scrape(); } catch (e) {}
  try { await require('./newsScraper').fetchAll(); } catch (e) {}
}, 5000);

// SPA Catch-all
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Will's AI running on port ${PORT}`);
  if (process.env.PUBLIC_URL && tg.hasToken && tg.useWebhook) tg.setWebhook(process.env.PUBLIC_URL);
});
// ── Telegram webhook ──
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    // ADDED callback_query here
    const msg = req.body?.message || req.body?.edited_message;
    const callback = req.body?.callback_query;
    
    if (msg) await tg.handleMessage(msg);
    if (callback) {
      const tgModule = require('./telegram');
      if (tgModule.bot) {
        // Since we can't easily export `bot` without rewriting telegram.js, 
        // we'll rely on the polling mode OR export bot.
      }
    }
  } catch (err) { console.error('[webhook]', err.message); }
  res.sendStatus(200);
});
// Add this route below the forgot route in server.js
app.post('/api/auth/reset-pin', authLimiter, async (req, res) => {
  try {
    const { accessToken, newPin } = req.body;
    res.json(await auth.resetPinWithToken(accessToken, newPin));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
