// ═══════════════════════════════════════════════════════════
//  app.js — Will's AI Frontend
//  Handles calendar, news, auth, preferences, timezone toggle
// ═══════════════════════════════════════════════════════════

let allEvents = [];
let allNews = [];
let dayFilter = 'today';
let newsCat = 'all';
let newsSearch = '';

const $ = id => document.getElementById(id);

// ═══════════════════════════════════════════════════════════
//  TIMEZONE STATE
//  'utc' = Biquote/source time (default)
//  'local' = browser's local timezone
// ═══════════════════════════════════════════════════════════
const TZ_KEY = 'wills_timezone_mode';
let timezoneMode = localStorage.getItem(TZ_KEY) || 'utc';

function getShortTimezoneLabel() {
  if (timezoneMode === 'utc') return 'UTC';
  try {
    const parts = new Date().toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ');
    const abbr = parts[parts.length - 1];
    if (abbr && abbr.length <= 5) return abbr;
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
  } catch {
    return 'Local';
  }
}

function formatTimeInMode(isoTimestamp, fallback = '—') {
  if (!isoTimestamp) return fallback;
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) return fallback;

  if (timezoneMode === 'utc') {
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC',
    }).replace(/\s+/g, '').toLowerCase();
  }
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace(/\s+/g, '').toLowerCase();
}

function formatDateInMode(isoTimestamp, fallback = '') {
  if (!isoTimestamp) return fallback;
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) return fallback;

  if (timezoneMode === 'utc') {
    return d.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  }
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function dateKeyInMode(isoTimestamp) {
  if (!isoTimestamp) return null;
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) return null;

  if (timezoneMode === 'utc') {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function todayKeyInMode(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  if (timezoneMode === 'utc') {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function updateTzButton() {
  const btn = $('tzToggle');
  if (!btn) return;
  btn.textContent = `🌍 ${getShortTimezoneLabel()}`;
}

// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

function impactKey(i) {
  const k = (i || '').toLowerCase();
  return ['high','medium','low'].includes(k) ? k : 'none';
}

// Filter events by the active day filter (respects timezone mode)
function filterByDay(events) {
  if (dayFilter === 'today') {
    return events.filter(e => e.timestamp && dateKeyInMode(e.timestamp) === todayKeyInMode(0));
  }
  if (dayFilter === 'tomorrow') {
    return events.filter(e => e.timestamp && dateKeyInMode(e.timestamp) === todayKeyInMode(1));
  }
  if (dayFilter === 'week') {
    return events.filter(e => {
      if (!e.timestamp) return false;
      const d = new Date(e.timestamp);
      const now = new Date();
      const start = new Date(now);
      start.setDate(now.getDate() - now.getDay());
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(start.getDate() + 7);
      return d >= start && d < end;
    });
  }
  return events;
}

// ═══════════════════════════════════════════════════════════
//  TABS
// ═══════════════════════════════════════════════════════════
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('panel-' + btn.dataset.tab).classList.add('active');
  });
});

// ═══════════════════════════════════════════════════════════
//  THEME
// ═══════════════════════════════════════════════════════════
function applyTheme(theme) {
  document.body.dataset.theme = theme;
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === theme);
  });
  localStorage.setItem('wills_theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const colors = { dark: '#0d1117', light: '#f6f8fa', ocean: '#0a1929', sunset: '#1a0b14' };
    meta.setAttribute('content', colors[theme] || '#0d1117');
  }
}
document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
});
applyTheme(localStorage.getItem('wills_theme') || 'dark');

// ═══════════════════════════════════════════════════════════
//  CALENDAR RENDER
// ═══════════════════════════════════════════════════════════
function renderCalendar() {
  const tbody = $('tbody');
  const events = filterByDay(allEvents);

  if (!events.length) {
    const label = dayFilter === 'today' ? 'today' :
                  dayFilter === 'tomorrow' ? 'tomorrow' :
                  dayFilter === 'week' ? 'this week' : '';
    tbody.innerHTML = `<tr><td colspan="7" class="empty">No events ${label}</td></tr>`;
    return;
  }

  // Sort by timestamp
  const sorted = [...events].sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });

  // Group by day (in current timezone mode)
  const groups = [];
  const seen = new Set();
  for (const e of sorted) {
    const key = e.timestamp ? dateKeyInMode(e.timestamp) : (e.date || '?');
    if (!seen.has(key)) {
      seen.add(key);
      groups.push({
        key,
        label: e.timestamp ? formatDateInMode(e.timestamp) : e.date,
        list: [],
      });
    }
    groups[groups.length - 1].list.push(e);
  }

  let html = '';
  for (const g of groups) {
    const isTodayGroup = g.key === todayKeyInMode(0);
    const todayTag = isTodayGroup ? '<span class="today">Today</span>' : '';
    html += `<tr class="day"><td colspan="7">${esc(g.label)}${todayTag}</td></tr>`;

    for (const e of g.list) {
      const ik = impactKey(e.impact);
      const bm = (e.beatMiss || '').toLowerCase();
      let actualCls = 'actual', actualTag = '';
      if (bm === 'beat') { actualCls += ' beat'; actualTag = '<span class="tag beat">BEAT</span>'; }
      else if (bm === 'miss') { actualCls += ' miss'; actualTag = '<span class="tag miss">MISS</span>'; }

      const displayTime = e.timestamp ? formatTimeInMode(e.timestamp) : (e.time || '—');

      html += `<tr class="impact-${ik}">
        <td class="col-time">${esc(displayTime)}</td>
        <td class="col-ccy">${esc(e.currency || '—')}</td>
        <td class="col-imp"><span class="impact-dot ${ik}"></span><span class="impact-lbl ${ik}">${ik}</span></td>
        <td class="col-event">${esc(e.event || '')}</td>
        <td class="col-num ${actualCls}">${esc(e.actual || '—')}${actualTag}</td>
        <td class="col-num forecast">${esc(e.forecast || '—')}</td>
        <td class="col-num previous">${esc(e.previous || '—')}</td>
      </tr>`;
    }
  }
  tbody.innerHTML = html;
}

function renderStats() {
  const filtered = filterByDay(allEvents);
  $('statTotal').textContent = filtered.length;
  $('statHigh').textContent = filtered.filter(e => impactKey(e.impact) === 'high').length;
  $('statMedium').textContent = filtered.filter(e => impactKey(e.impact) === 'medium').length;
}

// ═══════════════════════════════════════════════════════════
//  NEWS RENDER
// ═══════════════════════════════════════════════════════════
function renderNews() {
  const grid = $('newsGrid');
  let items = allNews.slice();

  if (newsCat !== 'all') items = items.filter(n => n.category === newsCat);
  if (newsSearch) {
    const s = newsSearch.toLowerCase();
    items = items.filter(n => (n.title || '').toLowerCase().includes(s));
  }

  if (!items.length) {
    grid.innerHTML = '<div class="empty">No news match</div>';
    return;
  }

  const counter = `<div class="news-counter">Showing ${items.length} of ${allNews.length} articles</div>`;
  const cards = items.map(n => {
    const date = n.pubDate ? new Date(n.pubDate).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    }) : '';
    return `
      <div class="news-card">
        <h3><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a></h3>
        ${n.snippet ? `<p>${esc(n.snippet)}</p>` : ''}
        <div class="news-meta">
          <span class="news-tag ${esc(n.category)}">${esc(n.category)}</span>
          <span>${esc(date)}</span>
        </div>
      </div>`;
  }).join('');

  grid.innerHTML = counter + cards;
}

// ═══════════════════════════════════════════════════════════
//  DATA LOADING
// ═══════════════════════════════════════════════════════════
async function loadCalendar() {
  try {
    const res = await fetch('/api/calendar');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allEvents = data.events || [];
    renderStats();
    renderCalendar();
    return allEvents.length;
  } catch (err) {
    $('tbody').innerHTML = `<tr><td colspan="7" class="empty">Failed: ${esc(err.message)}</td></tr>`;
    throw err;
  }
}

async function loadNews() {
  try {
    const res = await fetch('/api/news');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allNews = data.items || [];
    renderNews();
    return allNews.length;
  } catch (err) {
    $('newsGrid').innerHTML = `<div class="empty">Failed: ${esc(err.message)}</div>`;
    throw err;
  }
}

async function refreshAll() {
  await Promise.all([loadCalendar(), loadNews()]);
}

// ═══════════════════════════════════════════════════════════
//  FILTERS
// ═══════════════════════════════════════════════════════════
document.querySelectorAll('[data-day]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-day]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    dayFilter = btn.dataset.day;
    renderCalendar();
    renderStats();
  });
});

document.querySelectorAll('[data-cat]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-cat]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    newsCat = btn.dataset.cat;
    renderNews();
  });
});

$('newsSearch').addEventListener('input', e => {
  newsSearch = e.target.value.trim();
  renderNews();
});

// Timezone toggle
$('tzToggle')?.addEventListener('click', () => {
  timezoneMode = timezoneMode === 'utc' ? 'local' : 'utc';
  localStorage.setItem(TZ_KEY, timezoneMode);
  updateTzButton();
  renderCalendar();
  renderStats();
});

// ═══════════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════════
const authPanel = $('authPanel');
const authOverlay = $('authOverlay');
const authArea = $('authArea');
const prefPanel = $('prefPanel');

function openAuth(view = 'login') {
  authPanel.classList.add('open');
  authOverlay.classList.add('open');
  showAuthView(view);
}
function closeAuth() {
  authPanel.classList.remove('open');
  authOverlay.classList.remove('open');
  $('loginError').classList.remove('show');
  $('signupError').classList.remove('show');
}
function showAuthView(view) {
  document.querySelectorAll('.auth-view').forEach(v => v.classList.remove('active'));
  $('view' + view.charAt(0).toUpperCase() + view.slice(1)).classList.add('active');
}

$('authClose').addEventListener('click', closeAuth);
authOverlay.addEventListener('click', () => { closeAuth(); closePrefs(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeAuth(); closePrefs(); }
});

$('toSignup').addEventListener('click', () => showAuthView('signup'));
$('toLogin').addEventListener('click', () => showAuthView('login'));

// Signup submit
$('formSignup').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = $('signupError');
  errEl.classList.remove('show');

  const username = $('signupUsername').value.trim();
  const pin = $('signupPin').value.trim();
  const email = $('signupEmail').value.trim();

  const btn = $('signupSubmit');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    await Auth.signup(username, pin, email);
    renderAuthArea();
    closeAuth();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create account';
  }
});

// Login submit
$('formLogin').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = $('loginError');
  errEl.classList.remove('show');

  const username = $('loginUsername').value.trim();
  const pin = $('loginPin').value.trim();

  const btn = $('loginSubmit');
  btn.disabled = true;
  btn.textContent = 'Logging in…';

  try {
    await Auth.login(username, pin);
    renderAuthArea();
    closeAuth();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Log in';
  }
});

function renderAuthArea() {
  if (!Auth.isLoggedIn) {
    authArea.innerHTML = `<button class="btn-signin" id="btnSignin">Sign in</button>`;
    $('btnSignin').addEventListener('click', () => openAuth('login'));
    return;
  }

  const p = Auth.profile;
  const initial = (p?.username || '?').charAt(0).toUpperCase();

  authArea.innerHTML = `
    <div style="position:relative">
      <div class="user-pill" id="userPill">
        <div class="user-avatar">${initial}</div>
        <div class="user-name">${esc(p?.username || '')}</div>
      </div>
      <div class="user-menu" id="userMenu">
        <div class="menu-header">
          <div class="name">${esc(p?.username || '')}</div>
          ${p?.email ? `<div class="email">${esc(p.email)}</div>` : ''}
        </div>
        <button id="menuPref" class="pref-btn">⚙️ Preferences</button>
        <button id="menuLogout" class="danger">Log out</button>
      </div>
    </div>
  `;

  $('userPill').addEventListener('click', () => {
    $('userMenu').classList.toggle('open');
  });

  document.addEventListener('click', e => {
    const menu = $('userMenu');
    const pill = $('userPill');
    if (menu && pill && !menu.contains(e.target) && !pill.contains(e.target)) {
      menu.classList.remove('open');
    }
  });

  $('menuPref').addEventListener('click', () => {
    $('userMenu').classList.remove('open');
    openPrefs();
  });

  $('menuLogout').addEventListener('click', () => {
    Auth.logout();
    renderAuthArea();
  });
}

// ═══════════════════════════════════════════════════════════
//  PREFERENCES
// ═══════════════════════════════════════════════════════════
function openPrefs() {
  if (!Auth.isLoggedIn) return;
  prefPanel.classList.add('open');
  authOverlay.classList.add('open');
  renderPrefs();
}

function closePrefs() {
  prefPanel.classList.remove('open');
  authOverlay.classList.remove('open');
}

$('prefClose').addEventListener('click', closePrefs);

const ALL_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'CNY'];
const ALL_CATEGORIES = ['forex', 'forex_news', 'crypto', 'commodities', 'economy', 'stocks', 'markets'];
const TELEGRAM_BOT_URL = 'https://t.me/Wills_AI_Alert_bot';

async function renderPrefs() {
  const content = $('prefContent');
  content.innerHTML = '<div class="pref-loading">Loading…</div>';

  let profile;
  try {
    profile = await Auth.fetchProfile();
  } catch (err) {
    content.innerHTML = `<div class="pref-loading">Failed: ${esc(err.message)}</div>`;
    return;
  }

  const p = profile || {};
  const currencies = new Set(p.currencies || ['USD', 'EUR', 'GBP']);
  const categories = new Set(p.news_categories || ['forex']);
  const emailAlerts = p.email_alerts !== false;
  const alertMinutes = p.alert_minutes || 15;
  const alertImpact = p.alert_impact || 'high_medium';
  const userEmail = p.email || '';
  const hasTelegram = !!p.telegram_chat_id;

  content.innerHTML = `
    <div class="pref-section">
      <label class="title">Email</label>
      <input type="email" id="prefEmail" class="pref-input"
             placeholder="you@example.com" value="${esc(userEmail)}" />
      <p style="font-size:11px;color:var(--text-dim);margin-top:6px;">
        Used for event alerts and account recovery.
      </p>
    </div>

    <div class="pref-section">
      <label class="title">Telegram</label>
      <a href="${TELEGRAM_BOT_URL}" target="_blank" rel="noopener" class="pref-telegram-btn">
        ${hasTelegram ? '✅ Connected · Open bot' : '📱 Open @Wills_AI_Alert_bot'}
      </a>
      <p style="font-size:11px;color:var(--text-dim);margin-top:6px;line-height:1.5;">
        ${hasTelegram
          ? 'You are receiving Telegram alerts.'
          : 'Open the bot and send /start to receive instant alerts.'}
      </p>
    </div>

    <div class="pref-section">
      <div class="pref-toggle">
        <span>📧 Email alerts</span>
        <div class="switch ${emailAlerts ? 'on' : ''}" id="prefEmailToggle"></div>
      </div>
    </div>

    <div class="pref-section">
      <label class="title">Alert me this many minutes before</label>
      <select class="pref-select" id="prefMinutes">
        <option value="5"  ${alertMinutes === 5  ? 'selected' : ''}>5 minutes</option>
        <option value="15" ${alertMinutes === 15 ? 'selected' : ''}>15 minutes</option>
        <option value="30" ${alertMinutes === 30 ? 'selected' : ''}>30 minutes</option>
        <option value="60" ${alertMinutes === 60 ? 'selected' : ''}>60 minutes</option>
      </select>
    </div>

    <div class="pref-section">
      <label class="title">Impact level</label>
      <select class="pref-select" id="prefImpact">
        <option value="high_medium" ${alertImpact === 'high_medium' ? 'selected' : ''}>High + Medium</option>
        <option value="high"        ${alertImpact === 'high'        ? 'selected' : ''}>High only</option>
      </select>
    </div>

    <div class="pref-section">
      <label class="title">Currencies</label>
      <div class="chip-grid" id="prefCurrencies">
        ${ALL_CURRENCIES.map(c => `<div class="chip ${currencies.has(c) ? 'active' : ''}" data-val="${c}">${c}</div>`).join('')}
      </div>
    </div>

    <div class="pref-section">
      <label class="title">News categories</label>
      <div class="chip-grid" id="prefCategories">
        ${ALL_CATEGORIES.map(c => `<div class="chip ${categories.has(c) ? 'active' : ''}" data-val="${c}">${c}</div>`).join('')}
      </div>
    </div>

    <button class="pref-save" id="prefSave">Save preferences</button>
    <div class="pref-saved" id="prefSaved"></div>
  `;

  let emailOn = emailAlerts;
  $('prefEmailToggle').addEventListener('click', () => {
    emailOn = !emailOn;
    $('prefEmailToggle').classList.toggle('on', emailOn);
  });

  document.querySelectorAll('#prefCurrencies .chip').forEach(c =>
    c.addEventListener('click', () => c.classList.toggle('active')));
  document.querySelectorAll('#prefCategories .chip').forEach(c =>
    c.addEventListener('click', () => c.classList.toggle('active')));

  $('prefSave').addEventListener('click', async () => {
    const btn = $('prefSave');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    const newEmail = $('prefEmail').value.trim();
    const chosenCurrencies = [...document.querySelectorAll('#prefCurrencies .chip.active')].map(c => c.dataset.val);
    const chosenCategories = [...document.querySelectorAll('#prefCategories .chip.active')].map(c => c.dataset.val);

    if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      $('prefSaved').textContent = '❌ Invalid email';
      $('prefSaved').style.color = '#ff6b6b';
      btn.disabled = false;
      btn.textContent = 'Save preferences';
      return;
    }

    try {
      const updated = await Auth.updateProfile({
        email: newEmail || null,
        email_alerts: emailOn,
        alert_minutes: parseInt($('prefMinutes').value),
        alert_impact: $('prefImpact').value,
        currencies: chosenCurrencies.length ? chosenCurrencies : ['USD'],
        news_categories: chosenCategories.length ? chosenCategories : ['forex'],
      });
      Auth.saveProfile(updated);
      renderAuthArea();
      $('prefSaved').textContent = '✅ Saved';
      $('prefSaved').style.color = 'var(--accent)';
      setTimeout(() => $('prefSaved').textContent = '', 3000);
    } catch (err) {
      $('prefSaved').textContent = '❌ ' + err.message;
      $('prefSaved').style.color = '#ff6b6b';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save preferences';
    }
  });
}

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════
(async function init() {
  // Refresh token if expired
  if (Auth.isLoggedIn) {
    await Auth.ensureFresh();
  }
  updateTzButton();
  renderAuthArea();
  await refreshAll();
  setInterval(refreshAll, 60000);
  setInterval(() => Auth.ensureFresh(), 60000);
})();
