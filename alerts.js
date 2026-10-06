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

function getEventTime(e) {
  return new Date(e.event_timestamp).getTime();
}

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

  const { data: users } = await admin.from('profiles')
    .select('id, username, email, timezone, email_alerts, alert_minutes, currencies, alert_impact, alert_channels, telegram_chat_id')
    .eq('email_alerts', true);

  for (const ev of events) {
    const evTime = getEventTime(ev);
    if (!evTime) continue;
    const minutesUntil = Math.round((evTime - now) / 60000);
    if (minutesUntil < 0 || minutesUntil > 60) continue;

    const refId = ev.event_key;

    // ── Telegram broadcast to everyone ──
    if (minutesUntil >= 14 && minutesUntil <= 16) {
      const { data: existing } = await admin.from('alert_log')
        .select('id').eq('kind', 'event').eq('ref_id', refId).limit(1).maybeSingle();

      if (!existing) {
        const text = tg.eventMessage({ ...ev, timestamp: ev.event_timestamp }, minutesUntil);
        await tg.broadcast(text);
        await admin.from('alert_log').insert({ user_id: null, kind: 'event', ref_id: refId });
      }
    }

    // ── Per-user email alerts ──
    for (const user of users || []) {
      const userMin = user.alert_minutes || 15;
      if (Math.abs(minutesUntil - userMin) > 1) continue;

      const pref = user.alert_impact || 'high_medium';
      const evImp = (ev.impact || '').toLowerCase();
      if (pref === 'high' && evImp !== 'high') continue;
      if (pref === 'high_medium' && evImp !== 'high' && evImp !== 'medium') continue;

      const wanted = user.currencies || ['USD','EUR','GBP'];
      if (!wanted.includes(ev.currency)) continue;

      const userRefId = `${refId}|${user.id}`;
      const { data: existing } = await admin.from('alert_log')
        .select('id').eq('user_id', user.id).eq('kind', 'event-email').eq('ref_id', userRefId).maybeSingle();
      if (existing) continue;

      if (user.email) {
        const { subject, html } = eventAlertEmail(user, { ...ev, timestamp: ev.event_timestamp }, minutesUntil);
        const r = await sendEmail({ to: user.email, subject, html });
        if (r.ok) {
          await admin.from('alert_log').insert({ user_id: user.id, kind: 'event-email', ref_id: userRefId });
        }
      }
    }
  }
}

async function checkNewsAlerts() {
  const fs = require('fs');
  const path = require('path');
  let news = [];
  try {
    news = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'investing_news.json'), 'utf8')).items || [];
  } catch { return; }

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
      .select('id').eq('kind', 'news').eq('ref_id', refId).limit(1).maybeSingle();
    if (!existing) toSend.push(item);
  }
  if (!toSend.length) return;

  const batch = toSend.slice(0, 5);
  await tg.broadcast(tg.newsMessage(batch));

  for (const item of batch) {
    await admin.from('alert_log').insert({ user_id: null, kind: 'news', ref_id: item.link || item.title });
  }

  const { data: users } = await admin.from('profiles')
    .select('id, email, email_alerts, news_categories')
    .eq('email_alerts', true).not('email', 'is', null);

  for (const user of users || []) {
    const wanted = user.news_categories || ['forex'];
    const matched = batch.filter(n => wanted.includes(n.category));
    if (!matched.length) continue;
    const { subject, html } = newsAlertEmail(user, matched);
    await sendEmail({ to: user.email, subject, html });
  }
}

async function cleanupOldLogs() {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  await admin.from('alert_log').delete().lt('sent_at', cutoff);
}

async function runAll() {
  try { await checkEventAlerts(); } catch (e) { console.error('[alerts:event]', e.message); }
  try { await checkNewsAlerts(); } catch (e) { console.error('[alerts:news]', e.message); }
}

module.exports = { runAll, cleanupOldLogs };
