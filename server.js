require('dotenv').config({ path: './.env.local' });

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');
const vm = require('node:vm');

const auth = require('./auth');
const db = require('./db');
const alerts = require('./alerts');
const tg = require('./telegram');

const app = express();
const PORT = process.env.PORT || 3500;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

function formatDateLabel(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

// ═══════════════════════════════════════════════════════════
//  CORE APIs
// ═══════════════════════════════════════════════════════════

app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: db.SUPABASE_URL,
    supabasePublishableKey: db.PUBLISHABLE,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
  });
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

let newsCache = { data: [], timestamp: 0 };
app.get('/api/news', async (req, res) => {
  try {
    const now = Date.now();
    if (newsCache.data.length > 0 && (now - newsCache.timestamp) < 15 * 60 * 1000) {
      return res.json({ items: newsCache.data });
    }
    const response = await fetch(`https://biquote.io/api/news/market?maxResults=30`);
    const data = await response.json();
    if (!Array.isArray(data)) return res.json({ items: [] });
    
    const formattedNews = data.map(item => ({
      title: item.title || 'Market Update', link: item.url || '#',
      pubDate: item.publishedDate || new Date().toISOString(),
      snippet: item.description || '', category: 'forex' 
    }));
    newsCache = { data: formattedNews, timestamp: now };
    res.json({ items: formattedNews });
  } catch (err) {
    res.json({ items: newsCache.data || [] });
  }
});

// ═══════════════════════════════════════════════════════════
//  AUTH & PUSH APIs
// ═══════════════════════════════════════════════════════════

app.post('/api/auth/signup', async (req, res) => {
  try { res.json(await auth.signup(req.body)); } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/auth/login', async (req, res) => {
  try { res.json({ session: await auth.login(req.body) }); } catch (err) { res.status(401).json({ error: err.message }); }
});
app.get('/api/auth/me', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    res.json({ profile: await auth.getProfile(token) });
  } catch (err) { res.status(401).json({ error: err.message }); }
});

app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { subscription, userId } = req.body || {};
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
    await db.admin.from('push_subscriptions').upsert({
      endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth, user_id: userId || null,
    }, { onConflict: 'endpoint' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function sendPushToAll(payload) {
  if (!webpush) return { sent: 0, failed: 0 };
  const { data: subs } = await db.admin.from('push_subscriptions').select('*');
  if (!subs?.length) return { sent: 0, failed: 0 };
  let sent = 0, failed = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload));
      sent++;
    } catch (err) { failed++; }
  }
  return { sent, failed };
}
global.sendPushToAll = sendPushToAll;

// ═══════════════════════════════════════════════════════════
//  TELEGRAM WEBHOOK (Restored)
// ═══════════════════════════════════════════════════════════
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const msg = req.body?.message || req.body?.edited_message;
    if (msg) await tg.handleMessage(msg);
  } catch (err) { console.error('[webhook]', err.message); }
  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════
//  STRATEGIES APIs & CRON ENGINE
// ═══════════════════════════════════════════════════════════
// (Keep your existing strategy routes here: /api/strategies, /api/strategies/toggle)
// ... 
cron.schedule('* * * * *', async () => {
  // Strategy engine logic here...
});
// ...

// ═══════════════════════════════════════════════════════════
//  CRONS & BOOT (Restored Alerts & Scraper)
// ═══════════════════════════════════════════════════════════

cron.schedule('0 4 * * *', async () => {
  try { const { scrape } = require('./ffScraper'); await scrape(); } catch (e) {}
});

// This runs your alerts every minute!
cron.schedule('* * * * *', () => {
  alerts.runAll().catch(e => console.error('[cron] alerts:', e.message));
});

cron.schedule('0 3 * * *', async () => {
  try { const { cleanup } = require('./ffScraper'); await cleanup(); } catch {}
  try { await alerts.cleanupOldLogs(); } catch {}
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Will's AI → http://localhost:${PORT}`);
  
  // Restore Telegram polling/webhook on boot
  const PUBLIC_URL = process.env.PUBLIC_URL || '';
  if (PUBLIC_URL && tg.hasToken && tg.useWebhook) {
    tg.setWebhook(PUBLIC_URL).catch(() => {});
  } else if (tg.hasToken && !tg.useWebhook) {
    console.log('[boot] Telegram POLLING');
  }

  setTimeout(async () => {
    console.log('[boot] initial fetch');
    try { const { scrape } = require('./ffScraper'); await scrape(); } catch (e) { console.error('[boot] cal:', e.message); }
    try { await alerts.runAll(); } catch (e) { console.error('[boot] alerts:', e.message); }
  }, 5000);
});
