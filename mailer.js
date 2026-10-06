const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT) || 465;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const FROM_ADDRESS = process.env.FROM_ADDRESS || (SMTP_USER ? `Will's AI <${SMTP_USER}>` : '');
const APP_URL = process.env.PUBLIC_URL || 'http://localhost:3500';
const TELEGRAM_BOT_URL = 'https://t.me/Wills_AI_Alert_bot';

let transporter = null;
if (SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS.replace(/\s+/g, '') },
  });
  console.log('[mailer] ready');
} else {
  console.warn('[mailer] SMTP not configured');
}

function baseTemplate(title, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
<style>
body{font-family:-apple-system,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:0;line-height:1.5}
.wrap{max-width:560px;margin:0 auto;padding:24px 20px}
.card{background:#161b22;border:1px solid #2d333b;border-radius:14px;padding:24px;margin-bottom:16px}
.brand{font-size:15px;font-weight:700;color:#00f5a0;margin-bottom:20px}
h1{font-size:20px;font-weight:700;margin:0 0 12px;color:#e6edf3}
p{font-size:14px;color:#8b949e;margin:0 0 14px}
.kv{display:flex;justify-content:space-between;padding:8px 0;font-size:13px;border-bottom:1px solid #21262d}
.kv .k{color:#8b949e}.kv .v{color:#e6edf3;font-weight:600}
.cta{display:inline-block;background:linear-gradient(135deg,#00f5a0,#00d4ff);color:#0d1117!important;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:10px;margin:8px 0;font-size:14px}
.cta.tg{background:linear-gradient(135deg,#2AABEE,#229ED9);color:white!important}
.event{padding:12px;border-radius:8px;background:#0d1117;margin:8px 0;border-left:4px solid #d29922}
.event.high{border-left-color:#f85149}
.event .label{font-size:10px;text-transform:uppercase;letter-spacing:.6px;font-weight:700;color:#8b949e;margin-bottom:4px}
.event .name{font-size:14px;font-weight:700;color:#e6edf3}
.event .time{font-size:11px;color:#8b949e;margin-top:2px}
.footer{font-size:11px;color:#57606a;text-align:center;margin-top:20px}
</style></head><body><div class="wrap"><div class="brand">◈ Will's AI</div>${bodyHtml}
<div class="footer">You received this because you signed up at Will's AI.<br><a href="${APP_URL}" style="color:#8b949e">${APP_URL}</a></div>
</div></body></html>`;
}

function welcomeEmail(profile, upcomingEvents) {
  const username = profile.username || 'trader';
  const email = profile.email || '—';
  const eventsHtml = (upcomingEvents || []).slice(0, 3).map(e => {
    const impact = (e.impact || 'low').toLowerCase();
    const label = impact === 'high' ? 'HIGH' : 'MEDIUM';
    const time = new Date(e.event_timestamp).toLocaleString('en-GB', {
      timeZone: profile.timezone || 'UTC',
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    return `<div class="event ${impact}"><div class="label">${label} · ${e.currency}</div><div class="name">${e.title}</div><div class="time">${time}</div></div>`;
  }).join('') || '<p>No upcoming events right now.</p>';

  const body = `
    <div class="card">
      <h1>Welcome to Will's AI, ${username}! 👋</h1>
      <p>Your account is ready. You'll receive alerts for high and medium impact events, 15 minutes before they fire.</p>
      <div style="margin-top:16px;">
        <div class="kv"><span class="k">Username</span><span class="v">${username}</span></div>
        <div class="kv"><span class="k">Email</span><span class="v">${email}</span></div>
      </div>
      <p style="margin-top:20px;">Connect on Telegram for instant alerts:</p>
      <a href="${TELEGRAM_BOT_URL}" class="cta tg">Open @Wills_AI_Alert_bot →</a>
      <p style="margin-top:24px;">📊 <strong style="color:#e6edf3;">Your next 3 upcoming events:</strong></p>
      ${eventsHtml}
      <p style="margin-top:20px;">Customize your preferences:</p>
      <a href="${APP_URL}" class="cta">Open preferences</a>
    </div>`;
  return { subject: `Welcome to Will's AI, ${username}`, html: baseTemplate("Welcome", body) };
}

function eventAlertEmail(profile, event, minutesUntil) {
  const impact = (event.impact || 'low').toLowerCase();
  const label = impact === 'high' ? 'HIGH IMPACT' : 'MEDIUM IMPACT';
  const emoji = impact === 'high' ? '⚠️' : '🔔';
  const time = new Date(event.timestamp || event.event_timestamp).toLocaleString('en-GB', {
    timeZone: profile.timezone || 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const body = `
    <div class="card">
      <h1>${emoji} ${label} in ${minutesUntil} min</h1>
      <div class="event ${impact}">
        <div class="label">${label} · ${event.currency}</div>
        <div class="name">${event.event || event.title}</div>
        <div class="time">${time}</div>
      </div>
      <div class="kv"><span class="k">Forecast</span><span class="v">${event.forecast || '—'}</span></div>
      <div class="kv"><span class="k">Previous</span><span class="v">${event.previous || '—'}</span></div>
      <a href="${APP_URL}" class="cta">Open Calendar →</a>
    </div>`;
  return { subject: `${emoji} ${event.currency} ${event.event || event.title} in ${minutesUntil} min`, html: baseTemplate('Alert', body) };
}

function newsAlertEmail(profile, items) {
  const newsHtml = items.map(n => `<div style="padding:10px 0;border-bottom:1px solid #21262d"><div style="font-size:9px;color:#8b949e;text-transform:uppercase">${n.category}</div><a href="${n.link}" style="color:#e6edf3;text-decoration:none;font-size:14px;font-weight:600">${n.title}</a></div>`).join('');
  const body = `<div class="card"><h1>📰 ${items.length} new article${items.length===1?'':'s'}</h1>${newsHtml}<a href="${APP_URL}" class="cta">Open News →</a></div>`;
  return { subject: `📰 ${items.length} new: ${items[0].title.slice(0,50)}`, html: baseTemplate('News', body) };
}

async function sendEmail({ to, subject, html }) {
  if (!transporter) { console.log(`[mailer] SKIP: ${subject} → ${to}`); return { skipped: true }; }
  try {
    const info = await transporter.sendMail({ from: FROM_ADDRESS, to, subject, html });
    console.log(`[mailer] sent → ${to}`);
    return { ok: true, id: info.messageId };
  } catch (err) {
    console.error(`[mailer] FAILED → ${to}:`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendEmail, welcomeEmail, eventAlertEmail, newsAlertEmail };
