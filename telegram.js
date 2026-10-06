const _tgm = require('node-telegram-bot-api');
const TelegramBot = _tgm.TelegramBot || _tgm.default || _tgm;

if (typeof TelegramBot !== 'function') {
  throw new Error('TelegramBot not a constructor');
}

const { admin } = require('./db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const useWebhook = !!PUBLIC_URL;
const hasToken = BOT_TOKEN.length > 10;

let bot = null;
if (hasToken) {
  try {
    bot = new TelegramBot(BOT_TOKEN, { polling: !useWebhook });
    if (!useWebhook) {
      bot.on('message', (msg) => handleMessage(msg).catch(e => console.error('[tg]', e.message)));
      bot.on('polling_error', (err) => {
        if (!err.message.includes('EAI_AGAIN') && !err.message.includes('ECONNABORTED') && !err.message.includes('404')) {
          console.error('[tg] polling:', err.message);
        }
      });
      console.log('[telegram] POLLING mode');
    } else {
      console.log('[telegram] WEBHOOK mode');
    }
  } catch (err) {
    console.error('[telegram] init failed:', err.message);
    bot = null;
  }
} else {
  console.warn('[telegram] no token');
}

async function getUpcomingEvents(limit = 3) {
  try {
    const nowIso = new Date().toISOString();
    const { data } = await admin.from('calendar_events')
      .select('title, currency, impact, event_timestamp')
      .in('impact', ['high', 'medium'])
      .gt('event_timestamp', nowIso)
      .order('event_timestamp', { ascending: true })
      .limit(limit);
    return data || [];
  } catch { return []; }
}

async function handleMessage(msg) {
  if (!msg || !msg.text) return;
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const tgUser = msg.from?.username || null;
  const firstName = msg.from?.first_name || null;

  if (text === '/start' || text.startsWith('/start@')) {
    await admin.from('telegram_subscribers').upsert({
      chat_id: chatId, username: tgUser, first_name: firstName, active: true,
    }, { onConflict: 'chat_id' });

    const events = await getUpcomingEvents(3);
    let body = `✅ <b>Subscribed to Will's AI alerts</b>\n\n`;
    body += `You'll receive:\n`;
    body += `• ⚠️ High-impact events — 15 min before\n`;
    body += `• 🔔 Medium-impact events — 15 min before\n`;
    body += `• 📰 Fresh forex news\n\n`;

    if (events.length) {
      body += `📊 <b>Your next ${events.length} event${events.length === 1 ? '' : 's'}:</b>\n\n`;
      for (const e of events) {
        const impact = (e.impact || '').toLowerCase();
        const emoji = impact === 'high' ? '⚠️' : '🔔';
        const label = impact === 'high' ? 'HIGH' : 'MED';
        const when = new Date(e.event_timestamp).toLocaleString('en-GB', {
          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
        });
        body += `${emoji} <b>${label}</b> · ${e.currency} — ${e.title}\n   ${when}\n\n`;
      }
    }

    body += `To stop: /stop`;
    await sendTelegram(chatId, body);
    console.log(`[tg] +subscriber ${chatId}`);
    return;
  }

  if (text === '/stop') {
    await admin.from('telegram_subscribers').update({ active: false }).eq('chat_id', chatId);
    await sendTelegram(chatId, '🔕 Unsubscribed.');
    return;
  }

  if (text === '/help') {
    await sendTelegram(chatId, `Will's AI Alerts\n\n/start — subscribe\n/stop — unsubscribe`);
    return;
  }

  await sendTelegram(chatId, 'Send /start to subscribe.');
}

async function sendTelegram(chatId, text) {
  if (!bot) return { skipped: true };
  try {
    const r = await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
    return { ok: true, id: r.message_id };
  } catch (err) {
    if (err.response?.body?.error_code === 403) {
      await admin.from('telegram_subscribers').update({ active: false }).eq('chat_id', chatId);
    }
    return { ok: false, error: err.message };
  }
}

async function broadcast(text) {
  if (!bot) return { sent: 0, failed: 0 };
  const { data: subs } = await admin.from('telegram_subscribers').select('chat_id').eq('active', true);
  if (!subs?.length) return { sent: 0, failed: 0 };
  let sent = 0, failed = 0;
  for (const sub of subs) {
    const r = await sendTelegram(sub.chat_id, text);
    if (r.ok) sent++; else failed++;
    await new Promise(res => setTimeout(res, 40));
  }
  console.log(`[tg] broadcast: ${sent} sent`);
  return { sent, failed };
}

function eventMessage(event, minutesUntil) {
  const impact = (event.impact || 'low').toLowerCase();
  const emoji = impact === 'high' ? '⚠️' : '🔔';
  const label = impact === 'high' ? 'HIGH IMPACT' : 'MEDIUM IMPACT';
  const time = new Date(event.timestamp || event.event_timestamp).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  return `${emoji} <b>${label}</b> · ${event.currency}\n<b>${event.event || event.title}</b>\nin ${minutesUntil} min · ${time}\n\nForecast: <code>${event.forecast || '—'}</code>\nPrevious: <code>${event.previous || '—'}</code>`;
}

function newsMessage(items) {
  const header = `📰 <b>${items.length} new article${items.length === 1 ? '' : 's'}</b>\n`;
  const lines = items.slice(0, 5).map(n => `• <a href="${n.link}">${n.title}</a>`).join('\n');
  return header + '\n' + lines;
}

async function setWebhook(publicUrl) {
  if (!bot || !useWebhook) return;
  try {
    await bot.setWebHook(`${publicUrl}/api/telegram/webhook`);
    console.log('[telegram] webhook set');
  } catch (err) { console.error('[tg] webhook failed:', err.message); }
}

module.exports = { sendTelegram, broadcast, eventMessage, newsMessage, handleMessage, setWebhook, hasToken, useWebhook };
