Server.js

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
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

// ── API ──
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: db.SUPABASE_URL,
    supabasePublishableKey: db.PUBLISHABLE,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
  });
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

// ── Auth ──
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

// ── Telegram webhook ──
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const msg = req.body?.message || req.body?.edited_message;
    if (msg) await tg.handleMessage(msg);
  } catch (err) { console.error('[webhook]', err.message); }
  res.sendStatus(200);
});

// ── Push ──
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { subscription, userId } = req.body || {};
    if (!subscription?.endpoint || !subscription?.keys) {
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
  const { data: subs } = await db.admin.from('push_subscriptions').select('*');
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

app.get('/api/push/test', async (req, res) => {
  const result = await sendPushToAll({
    title: "Will's AI — Test",
    body: 'Push notifications are working!',
    url: '/',
  });
  res.json(result);
});

// ── Cron ──
cron.schedule('0 4 * * *', async () => {
  console.log('[cron] daily refresh');
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

// ── Boot ──
setTimeout(async () => {
  console.log('[boot] initial fetch');
  try { const { scrape } = require('./ffScraper'); await scrape(); }
  catch (e) { console.error('[boot] cal:', e.message); }
  try { const { fetchAll } = require('./newsScraper'); await fetchAll(); }
  catch (e) { console.error('[boot] news:', e.message); }
  try { await alerts.runAll(); console.log('[boot] alert check done'); }
  catch (e) { console.error('[boot] alerts:', e.message); }
}, 5000);

app.get(/.*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Will's AI → http://localhost:${PORT}`);
  console.log(`MODE: ${process.env.MODE || 'scrape'}`);

  const PUBLIC_URL = process.env.PUBLIC_URL || '';
  if (PUBLIC_URL && tg.hasToken && tg.useWebhook) {
    tg.setWebhook(PUBLIC_URL).catch(() => {});
  } else if (tg.hasToken && !tg.useWebhook) {
    console.log('[boot] Telegram POLLING');
  }
});

Package.json

{
  "name": "wills-ai",
  "version": "1.0.0",
  "description": "Will's AI — Live economic calendar, news, and event alerts",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "scrape": "node ffScraper.js",
    "news": "node newsScraper.js"
  },
  "engines": { "node": ">=20.0.0" },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "biquote": "^0.3.0",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "node-cron": "^3.0.3",
    "node-telegram-bot-api": "^0.66.0",
    "nodemailer": "^6.9.0",
    "rss-parser": "^3.13.0",
    "web-push": "^3.6.7"
  },
  "author": "Nwokolo",
  "license": "ISC"
}

db.js

require('dotenv').config({ path: './.env.local' });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const PUBLISHABLE = process.env.SUPABASE_PUBLISHABLE_KEY;
const SECRET = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !PUBLISHABLE || !SECRET) {
  throw new Error('db.js: missing SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, or SUPABASE_SECRET_KEY');
}

const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function anonClient() {
  return createClient(SUPABASE_URL, PUBLISHABLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function userClient(accessToken) {
  return createClient(SUPABASE_URL, PUBLISHABLE, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

module.exports = { admin, anonClient, userClient, SUPABASE_URL, PUBLISHABLE };

ffscrapper.js

const BiquoteModule = require('biquote');
const Biquote = BiquoteModule.Biquote || BiquoteModule.default || BiquoteModule;
const { admin } = require('./db');

const MODE = process.env.MODE || 'scrape';
let nextTimer = null;
let retryTimers = [];
let previousActuals = new Map();

function parseNumber(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/[^\d.\-]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function beatMiss(actual, forecast) {
  const a = parseNumber(actual);
  const f = parseNumber(forecast);
  if (a == null || f == null) return null;
  if (a > f) return 'BEAT';
  if (a < f) return 'MISS';
  return 'IN_LINE';
}

function normalizeImpact(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'high') return 'high';
  if (v === 'medium') return 'medium';
  if (v === 'low') return 'low';
  return 'none';
}

function toIsoDate(isoTime) {
  if (!isoTime) return null;
  const d = new Date(isoTime);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function toTimeString(isoTime) {
  if (!isoTime) return '';
  const d = new Date(isoTime);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC',
  }).toLowerCase().replace(/\s+/g, '');
}

function makeKey(isoTime, currency, name) {
  const t = (isoTime || '').toLowerCase();
  const c = (currency || '').toLowerCase();
  const n = (name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${t}|${c}|${n}`;
}

function toDbRow(e) {
  const isoTime = e.time || null;
  const name = (e.name || '').trim();
  const currency = (e.currency || '').toUpperCase().trim();
  return {
    event_key: makeKey(isoTime, currency, name),
    event_date: toIsoDate(isoTime),
    event_time: toTimeString(isoTime),
    event_timestamp: isoTime,
    currency,
    impact: normalizeImpact(e.importance),
    title: name,
    actual: e.actual != null ? String(e.actual) : null,
    forecast: e.forecast != null ? String(e.forecast) : null,
    previous: e.previous != null ? String(e.previous) : null,
    beat_miss: beatMiss(e.actual, e.forecast),
    source: e.source || 'biquote',
    updated_at: new Date().toISOString(),
  };
}

function validateRows(rows) {
  return rows.filter(r => {
    if (!r.event_key || r.event_key.length < 8) return false;
    if (!r.event_date) return false;
    if (!r.currency || r.currency.length < 3) return false;
    if (!r.title || r.title.length < 2) return false;
    if (!/^[A-Z]{2,4}$/.test(r.currency) && r.currency !== 'ALL') return false;
    return true;
  });
}

async function pushToSupabase(rows) {
  if (!rows.length) return 0;
  const BATCH = 200;
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await admin.from('calendar_events').upsert(batch, { onConflict: 'event_key' });
    if (error) throw new Error('Upsert failed: ' + error.message);
    total += batch.length;
  }
  return total;
}

async function fetchBiquote() {
  const bq = new Biquote();
  const now = new Date();
  const from = now.toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  console.log(`[ff] biquote fetch ${from} → ${to}`);
  const events = await bq.calendar({ from, to, limit: 500 });
  if (!Array.isArray(events)) throw new Error('Biquote returned non-array');
  console.log(`[ff] biquote returned ${events.length}`);
  return events.map(toDbRow);
}

function detectNewActuals(rows) {
  const fresh = [];
  for (const row of rows) {
    const previous = previousActuals.get(row.event_key);
    if (row.actual && !previous) fresh.push(row);
    else if (row.actual && previous && row.actual !== previous) fresh.push({ ...row, revised: true });
  }
  for (const row of rows) if (row.actual) previousActuals.set(row.event_key, row.actual);
  return fresh;
}

async function notifyActuals(newActuals) {
  if (!newActuals.length) return;
  console.log(`[ff] ${newActuals.length} new actuals`);
  try {
    const { notifyNewActuals } = require('./alerts');
    if (notifyNewActuals) await notifyNewActuals(newActuals);
  } catch (e) { console.error('[ff] notify failed:', e.message); }
}

async function scrape() {
  if (MODE === 'read') { console.log('[ff] MODE=read — skip'); return; }
  const t0 = Date.now();
  try {
    const allRows = await fetchBiquote();
    if (!allRows.length) { scheduleNextEventRefresh(); return; }

    const deduped = [...new Map(allRows.map(r => [r.event_key, r])).values()];
    const valid = validateRows(deduped);
    console.log(`[ff] ${valid.length} valid rows`);

    const newActuals = detectNewActuals(valid);
    await pushToSupabase(valid);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`[ff] pushed ${valid.length} — ${elapsed}s`);

    await notifyActuals(newActuals);
    scheduleNextEventRefresh();
  } catch (err) {
    console.error('[ff] error:', err.message);
    if (nextTimer) clearTimeout(nextTimer);
    nextTimer = setTimeout(scrape, 5 * 60 * 1000);
  }
}

async function targetedRefresh() {
  if (MODE === 'read') return false;
  try {
    const allRows = await fetchBiquote();
    const deduped = [...new Map(allRows.map(r => [r.event_key, r])).values()];
    const valid = validateRows(deduped);
    const newActuals = detectNewActuals(valid);
    await pushToSupabase(valid);
    if (newActuals.length) {
      await notifyActuals(newActuals);
      return true;
    }
    return false;
  } catch (err) {
    console.error('[ff] targeted refresh error:', err.message);
    return false;
  }
}

async function fireRetriesForNextEvent() {
  retryTimers.forEach(t => clearTimeout(t));
  retryTimers = [];

  const now = Date.now();
  const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
  const twoMinAhead = new Date(now + 2 * 60 * 1000).toISOString();

  const { data } = await admin.from('calendar_events')
    .select('event_key, event_timestamp, title, currency')
    .is('actual', null)
    .gte('event_timestamp', fiveMinAgo)
    .lte('event_timestamp', twoMinAhead)
    .order('event_timestamp', { ascending: true })
    .limit(1);

  if (!data?.length) { console.log('[ff] no due events for retry'); return; }

  const target = data[0];
  console.log(`[ff] retry loop for ${target.currency} ${target.title}`);

  const delays = [1000, 30000, 60000, 120000, 240000, 480000];

  delays.forEach((delay, idx) => {
    const timer = setTimeout(async () => {
      const found = await targetedRefresh();
      if (found) {
        console.log(`[ff] actual found on retry #${idx + 1}`);
        retryTimers.forEach(t => clearTimeout(t));
        retryTimers = [];
      }
    }, delay);
    retryTimers.push(timer);
  });
}

async function scheduleNextEventRefresh() {
  if (nextTimer) clearTimeout(nextTimer);
  if (MODE === 'read') return;

  try {
    const nowIso = new Date().toISOString();
    const { data } = await admin.from('calendar_events')
      .select('event_timestamp, title, currency')
      .is('actual', null)
      .gt('event_timestamp', nowIso)
      .order('event_timestamp', { ascending: true })
      .limit(1);

    if (!data?.length) {
      console.log('[ff] no upcoming events — 6h');
      nextTimer = setTimeout(scrape, 6 * 3600 * 1000);
      return;
    }

    const next = data[0];
    const targetMs = new Date(next.event_timestamp).getTime() + 1000;
    const delay = targetMs - Date.now();

    if (delay < 0) { await fireRetriesForNextEvent(); return; }

    const capped = Math.min(delay, 6 * 3600 * 1000);
    const minUntil = Math.round(capped / 60000);
    console.log(`[ff] next: ${next.currency} ${next.title} in ${minUntil} min`);

    nextTimer = setTimeout(async () => {
      console.log('[ff] EVENT FIRED — starting retry loop');
      await fireRetriesForNextEvent();
    }, capped);
  } catch (err) { console.error('[ff] schedule error:', err.message); }
}

async function cleanup() {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await admin.from('calendar_events').delete().lt('event_date', cutoff);
  console.log('[ff] cleanup done');
}

module.exports = { scrape, cleanup, scheduleNextEventRefresh };
