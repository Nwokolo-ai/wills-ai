const fs = require('fs');
const path = require('path');
const { admin } = require('./db');
const { sendEmail, eventAlertEmail, newsAlertEmail } = require('./mailer');
const tg = require('./telegram');

function parseNum(v) {
  if (v == null) return null;
  const s = String(v).replace(/[^\d.\-]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ═══════════════════════════════════════════════════════════
//  PRE-EVENT ALERTS — 15 min before (or user's preference)
// ═══════════════════════════════════════════════════════════
async function checkEventAlerts() {
  const now = Date.now();
  const from = new Date(now - 5 * 60 * 1000).toISOString();
  const to = new Date(now + 60 * 60 * 1000).toISOString();

  const { data: events } = await admin.from('calendar_events')
    .select('*')
    .in('impact', ['high', 'medium'])
    .gte('event_timestamp', from)
    .lte('event_timestamp', to);

  if (!events?.length) return;

  // ── FIX #1: fetch email users ONCE per cron tick (not per-event) ──
  const { data: users } = await admin.from('profiles')
    .select('id, username, email, timezone, email_alerts, alert_minutes, currencies, alert_impact')
    .eq('email_alerts', true)
    .not('email', 'is', null);

  const emailUsers = users || [];

  for (const ev of events) {
    const evTime = new Date(ev.event_timestamp).getTime();
    if (!evTime) continue;
    const minutesUntil = Math.round((evTime - now) / 60000);
    if (minutesUntil < 0 || minutesUntil > 60) continue;

    const refId = ev.event_key;

    // ── Telegram broadcast at the 15-min mark ──
    if (minutesUntil >= 14 && minutesUntil <= 16) {
      const { data: existing } = await admin.from('alert_log')
        .select('id')
        .eq('kind', 'event')
        .eq('ref_id', refId)
        .limit(1)
        .maybeSingle();

      if (!existing) {
        try {
          const text = tg.eventMessage({ ...ev, timestamp: ev.event_timestamp }, minutesUntil);
          await tg.broadcast(text);
          await admin.from('alert_log').insert({
            user_id: null,
            kind: 'event',
            ref_id: refId,
          });
        } catch (e) {
          console.error('[alerts] tg broadcast failed:', e.message);
        }
      }
    }

    // ── Email alerts per user (uses pre-fetched list) ──
    if (!emailUsers.length) continue;

    for (const user of emailUsers) {
      const userMin = user.alert_minutes || 15;
      if (Math.abs(minutesUntil - userMin) > 1) continue;

      const pref = user.alert_impact || 'high_medium';
      const evImp = (ev.impact || '').toLowerCase();
      if (pref === 'high' && evImp !== 'high') continue;
      if (pref === 'high_medium' && evImp !== 'high' && evImp !== 'medium') continue;

      const wanted = user.currencies || ['USD', 'EUR', 'GBP'];
      if (!wanted.includes(ev.currency)) continue;

      const userRefId = `${refId}|${user.id}`;
      const { data: existing } = await admin.from('alert_log')
        .select('id')
        .eq('user_id', user.id)
        .eq('kind', 'event-email')
        .eq('ref_id', userRefId)
        .maybeSingle();
      if (existing) continue;

      try {
        const { subject, html } = eventAlertEmail(
          user,
          { ...ev, timestamp: ev.event_timestamp },
          minutesUntil
        );
        const r = await sendEmail({ to: user.email, subject, html });
        if (r.ok) {
          await admin.from('alert_log').insert({
            user_id: user.id,
            kind: 'event-email',
            ref_id: userRefId,
          });
        }
      } catch (e) {
        console.error(`[alerts] email to ${user.email} failed:`, e.message);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  NEWS ALERTS
// ═══════════════════════════════════════════════════════════
async function checkNewsAlerts() {
  let news = [];
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'data', 'investing_news.json'), 'utf8');
    news = JSON.parse(raw).items || [];
  } catch {
    return;
  }

  const now = Date.now();
  const fresh = news.filter(n => {
    const t = new Date(n.pubDate || 0).getTime();
    return t > now - 15 * 60 * 1000 && t < now;
  });
  if (!fresh.length) return;

  const toSend = [];
  for (const item of fresh) {
    const refId = item.link || item.title;
    const { data: existing } = await admin.from('alert_log')
      .select('id')
      .eq('kind', 'news')
      .eq('ref_id', refId)
      .limit(1)
      .maybeSingle();
    if (!existing) toSend.push(item);
  }
  if (!toSend.length) return;

  const batch = toSend.slice(0, 5);

  try {
    await tg.broadcast(tg.newsMessage(batch));
  } catch (e) {
    console.error('[alerts] news tg failed:', e.message);
  }

  for (const item of batch) {
    await admin.from('alert_log').insert({
      user_id: null,
      kind: 'news',
      ref_id: item.link || item.title,
    });
  }

  const { data: users } = await admin.from('profiles')
    .select('id, email, email_alerts, news_categories')
    .eq('email_alerts', true)
    .not('email', 'is', null);

  for (const user of users || []) {
    const wanted = user.news_categories || ['forex'];
    const matched = batch.filter(n => wanted.includes(n.category));
    if (!matched.length) continue;
    try {
      const { subject, html } = newsAlertEmail(user, matched);
      await sendEmail({ to: user.email, subject, html });
    } catch (e) {
      console.error(`[alerts] news email to ${user.email} failed:`, e.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  POST-EVENT NOTIFICATION — actual released
// ═══════════════════════════════════════════════════════════
async function notifyNewActuals(events) {
  if (!events?.length) return;

  for (const ev of events) {
    if (!ev.actual) continue;
    const impact = (ev.impact || '').toLowerCase();
    if (impact !== 'high' && impact !== 'medium') continue;

    // ── FIX #2: idempotency guard so restarts don't flood ──
    // Include actual value so revised numbers still get notified once.
    const refId = `${ev.event_key}|${ev.actual}`;
    const { data: existing } = await admin.from('alert_log')
      .select('id')
      .eq('kind', 'event-actual')
      .eq('ref_id', refId)
      .limit(1)
      .maybeSingle();
    if (existing) continue;

    const emoji = impact === 'high' ? '⚠️' : '🔔';
    const label = impact === 'high' ? 'HIGH' : 'MED';
    const beat = ev.beat_miss ? ` · ${ev.beat_miss}` : '';

    const title = `${emoji} ${ev.currency} ${ev.title}`;
    const body = `Actual: ${ev.actual} · Forecast: ${ev.forecast || '—'}${beat}`;

    // Telegram
    try {
      const text =
        `${emoji} <b>${label} IMPACT — RELEASED</b>\n` +
        `<b>${ev.currency} ${ev.title}</b>\n\n` +
        `Actual: <b>${ev.actual}</b>\n` +
        `Forecast: ${ev.forecast || '—'}\n` +
        `Previous: ${ev.previous || '—'}` +
        (beat ? `\n\n${beat}` : '');
      await tg.broadcast(text);
    } catch (e) {
      console.error('[notify] tg failed:', e.message);
    }

    // Push
    try {
      if (global.sendPushToAll) {
        await global.sendPushToAll({
          title,
          body,
          url: '/',
          tag: `event-${ev.event_key}`,
        });
      }
    } catch (e) {
      console.error('[notify] push failed:', e.message);
    }

    // Log AFTER successful broadcast so a crash mid-send will retry
    try {
      await admin.from('alert_log').insert({
        user_id: null,
        kind: 'event-actual',
        ref_id: refId,
      });
    } catch (e) {
      console.error('[notify] log failed:', e.message);
    }

    console.log(`[notify] sent: ${ev.currency} ${ev.title}`);
  }
}

// ═══════════════════════════════════════════════════════════
//  CLEANUP
// ═══════════════════════════════════════════════════════════
async function cleanupOldLogs() {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  await admin.from('alert_log').delete().lt('sent_at', cutoff);
  console.log('[alerts] old logs cleaned');
}

// ═══════════════════════════════════════════════════════════
//  MAIN LOOP (called by cron every minute)
// ═══════════════════════════════════════════════════════════
async function runAll() {
  try {
    await checkEventAlerts();
  } catch (e) {
    console.error('[alerts:event]', e.message);
  }
  try {
    await checkNewsAlerts();
  } catch (e) {
    console.error('[alerts:news]', e.message);
  }
}

module.exports = { runAll, cleanupOldLogs, notifyNewActuals };
