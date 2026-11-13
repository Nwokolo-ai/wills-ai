const _tgm = require('node-telegram-bot-api');
const TelegramBot = _tgm.TelegramBot || _tgm.default || _tgm;
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
      bot.on('callback_query', (query) => handleCallback(query).catch(e => console.error('[tg]', e.message)));
      bot.on('polling_error', (err) => {
        const m = err.message || '';
        if (!m.includes('EAI_AGAIN') && !m.includes('ECONNABORTED') && !m.includes('404') && !m.includes('409')) {
          console.error('[tg] polling:', m);
        }
      });
      console.log('[telegram] POLLING mode active');
    } else {
      console.log('[telegram] WEBHOOK mode active');
    }
  } catch (err) {
    console.error('[telegram] init failed:', err.message);
    bot = null;
  }
}

// ── Helper: Get events for a specific day offset (0 = today, 1 = tomorrow) ──
async function getEventsForDay(offset = 0) {
  try {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    const dateStr = d.toISOString().slice(0, 10);

    const { data } = await admin.from('calendar_events')
      .select('title, currency, impact, event_timestamp, actual, forecast, previous')
      .eq('event_date', dateStr)
      .in('impact', ['high', 'medium'])
      .order('event_timestamp', { ascending: true });
    return data || [];
  } catch { return []; }
}

// ── Helper: Format events into a nice text block ──
function formatEventsText(events, title) {
  if (!events.length) return `<b>${title}</b>\n\nNo high/medium impact events scheduled.`;
  
  let body = `<b>${title}</b>\n\n`;
  for (const e of events) {
    const impact = (e.impact || '').toLowerCase();
    const emoji = impact === 'high' ? '⚠️' : '🔔';
    const label = impact === 'high' ? 'HIGH' : 'MED';
    const time = new Date(e.event_timestamp).toLocaleString('en-GB', {
      hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
    });
    
    body += `${emoji} <b>${label}</b> · ${e.currency} — ${e.title}\n`;
    body += `   🕒 ${time} UTC`;
    if (e.actual) body += ` | A: <code>${e.actual}</code>`;
    else if (e.forecast) body += ` | F: <code>${e.forecast}</code>`;
    body += `\n\n`;
  }
  return body.trim();
}

// ── Handle Inline Buttons (Callback Queries) ──
async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === 'today') {
    const events = await getEventsForDay(0);
    const text = formatEventsText(events, "📅 Today's Events");
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
  } 
  else if (data === 'tomorrow') {
    const events = await getEventsForDay(1);
    const text = formatEventsText(events, "📅 Tomorrow's Events");
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
  }
  else if (data === 'status') {
    const { data: sub } = await admin.from('telegram_subscribers').select('active, subscribed_at').eq('chat_id', String(chatId)).maybeSingle();
    if (sub && sub.active) {
      const since = new Date(sub.subscribed_at).toLocaleDateString();
      await bot.sendMessage(chatId, `✅ <b>Status: Active</b>\nYou have been subscribed since ${since}.\n\nSend /stop to unsubscribe.`, { parse_mode: 'HTML' });
    } else {
      await bot.sendMessage(chatId, `❌ <b>Status: Inactive</b>\nSend /start to subscribe to alerts.`, { parse_mode: 'HTML' });
    }
  }

  // Always answer the callback query so the loading spinner on the button goes away
  await bot.answerCallbackQuery(query.id);
}

// ── Handle Text Commands ──
async function handleMessage(msg) {
  if (!msg || !msg.text) return;
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim().toLowerCase();

  if (text === '/start' || text.startsWith('/start@')) {
    await admin.from('telegram_subscribers').upsert({
      chat_id: chatId, username: msg.from?.username || null, first_name: msg.from?.first_name || null, active: true,
    }, { onConflict: 'chat_id' });

    const welcome = `👋 <b>Welcome to Will's AI Alerts!</b>\n\nYou are now subscribed to:\n• ⚠️ High-impact event alerts\n• 🔔 Medium-impact event alerts\n• 📊 Post-release actuals\n• 📰 News updates\n\nUse the menu below to explore:`;
    
    await bot.sendMessage(chatId, welcome, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: "📅 Today's Events", callback_data: 'today' }, { text: "📅 Tomorrow", callback_data: 'tomorrow' }],
          [{ text: "ℹ️ My Status", callback_data: 'status' }]
        ]
      }
    });
    return;
  }

  if (text === '/stop') {
    await admin.from('telegram_subscribers').update({ active: false }).eq('chat_id', chatId);
    await bot.sendMessage(chatId, '🔕 You have been unsubscribed from alerts. Send /start to re-enable.');
    return;
  }

  // Text command shortcuts
  if (text === '/today') {
    const events = await getEventsForDay(0);
    const txt = formatEventsText(events, "📅 Today's Events");
    await bot.sendMessage(chatId, txt, { parse_mode: 'HTML', disable_web_page_preview: true });
    return;
  }

  if (text === '/tomorrow') {
    const events = await getEventsForDay(1);
    const txt = formatEventsText(events, "📅 Tomorrow's Events");
    await bot.sendMessage(chatId, txt, { parse_mode: 'HTML', disable_web_page_preview: true });
    return;
  }

  // Fallback for unknown commands
  if (text.startsWith('/')) {
    await bot.sendMessage(chatId, 'Unknown command. Try /start, /today, or /stop.');
  }
}

// ── Send / Broadcast Functions ──
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
    await new Promise(res => setTimeout(res, 40)); // Prevent Telegram rate limits
  }
  return { sent, failed };
}

function eventMessage(event, minutesUntil) {
  const impact = (event.impact || 'low').toLowerCase();
  const emoji = impact === 'high' ? '⚠️' : '🔔';
  const label = impact === 'high' ? 'HIGH IMPACT' : 'MEDIUM IMPACT';
  const time = new Date(event.timestamp || event.event_timestamp).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
  return `${emoji} <b>${label}</b> · ${event.currency}\n<b>${event.event || event.title}</b>\nin ${minutesUntil} min · ${time} UTC\n\nForecast: <code>${event.forecast || '—'}</code>\nPrevious: <code>${event.previous || '—'}</code>`;
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
    console.log('[telegram] webhook set successfully');
  } catch (err) { console.error('[tg] webhook failed:', err.message); }
}

module.exports = { sendTelegram, broadcast, eventMessage, newsMessage, handleMessage, setWebhook, hasToken, useWebhook };
