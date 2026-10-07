// ═══════════════════════════════════════════════════════════
//  app.js — Will's AI Frontend
// ═══════════════════════════════════════════════════════════

let allEvents = [];
let allNews = [];
let dayFilter = 'today';
let newsCat = 'all';
let newsSearch = '';
let autoScrollDone = false;

const $ = id => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

function impactKey(i) {
  const k = (i || '').toLowerCase();
  return ['high','medium','low'].includes(k) ? k : 'none';
}

function parseEventDate(dateStr) {
  if (!dateStr) return null;
  const clean = String(dateStr).trim().replace(/\s+/g, ' ').replace(/^[A-Za-z]+,\s*/, '');
  const year = new Date().getFullYear();
  let d = new Date(`${clean} ${year}`);
  if (!isNaN(d.getTime())) return d;
  d = new Date(clean);
  return isNaN(d.getTime()) ? null : d;
}

function dateKey(dateStr) {
  const d = parseEventDate(dateStr);
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function todayKey(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function isToday(s) { return dateKey(s) === todayKey(0); }
function isTomorrow(s) { return dateKey(s) === todayKey(1); }
function isThisWeek(s) {
  const d = parseEventDate(s);
  if (!d) return false;
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay());
  start.setHours(0,0,0,0);
  const end = new Date(start); end.setDate(start.getDate() + 7);
  return d >= start && d < end;
}

function filterByDay(events) {
  if (dayFilter === 'today') return events.filter(e => isToday(e.date));
  if (dayFilter === 'tomorrow') return events.filter(e => isTomorrow(e.date));
  if (dayFilter === 'week') return events.filter(e => isThisWeek(e.date));
  return events;
}

// ── Tabs ──
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('panel-' + btn.dataset.tab).classList.add('active');
  });
});

// ── Theme ──
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
//  AUTO SCROLL TO LAST PAST EVENT
// ═══════════════════════════════════════════════════════════
function autoScrollToLastPast() {
  if (autoScrollDone) return;
  const tbody = $('tbody');
  if (!tbody) return;

  const now = Date.now();
  const rows = tbody.querySelectorAll('tr');

  let lastPastRow = null;
  let lastPastTimestamp = 0;

  for (const row of rows) {
    if (row.classList.contains('day')) continue;
    const timeCell = row.querySelector('.col-time');
    if (!timeCell) continue;

    const timeText = timeCell.textContent.trim();
    if (!/\d/.test(timeText)) continue;

    // Get the date from the nearest day header above
    let dayLabel = '';
    let prev = row.previousElementSibling;
    while (prev) {
      if (prev.classList.contains('day')) {
        dayLabel = prev.textContent.replace('Today', '').trim();
        break;
      }
      prev = prev.previousElementSibling;
    }
    if (!dayLabel) continue;

    const parsed = parseEventDate(dayLabel);
    if (!parsed) continue;

    const m = timeText.match(/(\d+):(\d+)\s*(am|pm)/i);
    if (!m) continue;

    let h = parseInt(m[1]);
    const min = parseInt(m[2]);
    if (m[3].toLowerCase() === 'pm' && h !== 12) h += 12;
    if (m[3].toLowerCase() === 'am' && h === 12) h = 0;
    parsed.setHours(h, min, 0, 0);

    const ts = parsed.getTime();
    if (ts <= now && ts > lastPastTimestamp) {
      lastPastTimestamp = ts;
      lastPastRow = row;
    }
  }

  if (lastPastRow) {
    setTimeout(() => {
      lastPastRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      lastPastRow.style.transition = 'background 0.5s ease';
      lastPastRow.style.background = 'rgba(0, 245, 160, 0.14)';
      setTimeout(() => {
        lastPastRow.style.background = '';
      }, 2400);
    }, 300);
    autoScrollDone = true;
  }
}

// ── Calendar render ──
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

  const timeSort = t => {
    const s = String(t || '').toLowerCase().trim();
    if (s.includes('all day')) return -1;
    if (s.includes('tentative')) return -0.5;
    const m = s.match(/(\d+):(\d+)\s*(am|pm)/);
    if (!m) return 9999;
    let h = parseInt(m[1]);
    const min = parseInt(m[2]);
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return h * 60 + min;
  };

  const groups = [];
  const seen = new Set();
  for (const e of events) {
    const key = e.date || '?';
    if (!seen.has(key)) { seen.add(key); groups.push({ date: key, list: [] }); }
    groups[groups.length - 1].list.push(e);
  }
  groups.forEach(g => g.list.sort((a,b) => timeSort(a.time) - timeSort(b.time)));

  let html = '';
  for (const g of groups) {
    const todayTag = isToday(g.date) ? '<span class="today">Today</span>' : '';
    html += `<tr class="day"><td colspan="7">${esc(g.date)}${todayTag}</td></tr>`;
    for (const e of g.list) {
      const ik = impactKey(e.impact);
      const bm = (e.beatMiss || '').toLowerCase();
      let actualCls = 'actual', actualTag = '';
      if (bm === 'beat') { actualCls += ' beat'; actualTag = '<span class="tag beat">BEAT</span>'; }
      else if (bm === 'miss') { actualCls += ' miss'; actualTag = '<span class="tag miss">MISS</span>'; }

      html += `<tr class="impact-${ik}">
        <td class="col-time">${esc(e.time || '—')}</td>
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

  setTimeout(autoScrollToLastPast, 100);
}

function renderStats() {
  const filtered = filterByDay(allEvents);
  $('statTotal').textContent = filtered.length;
  $('statHigh').textContent = filtered.filter(e => impactKey(e.impact) === 'high').length;
  $('statMedium').textContent = filtered.filter(e => impactKey(e.impact) === 'medium').length;
}

// ── News render ──
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
    return `<div class="news-card">
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

// ── Data loaders ──
async function loadCalendar() {
  try {
    const res = await fetch('/api/calendar');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allEvents = data.events || [];
    renderStats();
    renderCalendar();
  } catch (err) {
    $('tbody').innerHTML = `<tr><td colspan="7" class="empty">Failed: ${esc(err.message)}</td></tr>`;
  }
}

async function loadNews() {
  try {
    const res = await fetch('/api/news');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allNews = data.items || [];
    renderNews();
  } catch (err) {
    $('newsGrid').innerHTML = `<div class="empty">Failed: ${esc(err.message)}</div>`;
  }
}

async function refreshAll() {
  await Promise.all([loadCalendar(), loadNews()]);
}

// ── Filters ──
document.querySelectorAll('[data-day]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-day]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    dayFilter = btn.dataset.day;
    autoScrollDone = false;
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

$('formSignup').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = $('signupError'); errEl.classList.remove('show');
  const username = $('signupUsername').value.trim();
  const pin = $('signupPin').value.trim();
  const email = $('signupEmail').value.trim();
  const btn = $('signupSubmit');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    await Auth.signup(username, pin, email);
    renderAuthArea();
    closeAuth();
  } catch (err) {
    errEl.textContent = err.message; errEl.classList.add('show');
  } finally {
    btn.disabled = false; btn.textContent = 'Create account';
  }
});

$('formLogin').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = $('loginError'); errEl.classList.remove('show');
  const username = $('loginUsername').value.trim();
  const pin = $('loginPin').value.trim();
  const btn = $('loginSubmit');
  btn.disabled = true; btn.textContent = 'Logging in…';
  try {
    await Auth.login(username, pin);
    renderAuthArea();
    closeAuth();
  } catch (err) {
    errEl.textContent = err.message; errEl.classList.add('show');
  } finally {
    btn.disabled = false; btn.textContent = 'Log in';
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
    </div>`;
  $('userPill').addEventListener('click', () => $('userMenu').classList.toggle('open'));
  document.addEventListener('click', e => {
    const menu = $('userMenu'); const pill = $('userPill');
    if (menu && pill && !menu.contains(e.target) && !pill.contains(e.target)) menu.classList.remove('open');
  });
  $('menuPref').addEventListener('click', () => { $('userMenu').classList.remove('open'); openPrefs(); });
  $('menuLogout').addEventListener('click', () => { Auth.logout(); renderAuthArea(); });
}

// ── Preferences ──
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

const ALL_CURRENCIES = ['USD','EUR','GBP','JPY','AUD','NZD','CAD','CHF','CNY'];
const ALL_CATEGORIES = ['forex','forex_news','crypto','commodities','economy','stocks','markets'];
const TELEGRAM_BOT_URL = 'https://t.me/Wills_AI_Alert_bot';

async function renderPrefs() {
  const content = $('prefContent');
  content.innerHTML = '<div class="pref-loading">Loading…</div>';
  let profile;
  try { profile = await Auth.fetchProfile(); }
  catch (err) { content.innerHTML = `<div class="pref-loading">Failed: ${esc(err.message)}</div>`; return; }

  const p = profile || {};
  const currencies = new Set(p.currencies || ['USD','EUR','GBP']);
  const categories = new Set(p.news_categories || ['forex']);
  const emailAlerts = p.email_alerts !== false;
  const alertMinutes = p.alert_minutes || 15;
  const alertImpact = p.alert_impact || 'high_medium';
  const userEmail = p.email || '';
  const hasTelegram = !!p.telegram_chat_id;

  content.innerHTML = `
    <div class="pref-section">
      <label class="title">Email</label>
      <input type="email" id="prefEmail" class="pref-input" placeholder="you@example.com" value="${esc(userEmail)}" />
    </div>
    <div class="pref-section">
      <label class="title">Telegram</label>
      <a href="${TELEGRAM_BOT_URL}" target="_blank" rel="noopener" class="pref-telegram-btn">
        ${hasTelegram ? '✅ Connected · Open bot' : '📱 Open @Wills_AI_Alert_bot'}
      </a>
      <p style="font-size:11px;color:var(--text-dim);margin-top:6px;">
        ${hasTelegram ? 'You are receiving Telegram alerts.' : 'Send /start to the bot for instant alerts.'}
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
        <option value="5" ${alertMinutes === 5 ? 'selected' : ''}>5 minutes</option>
        <option value="15" ${alertMinutes === 15 ? 'selected' : ''}>15 minutes</option>
        <option value="30" ${alertMinutes === 30 ? 'selected' : ''}>30 minutes</option>
        <option value="60" ${alertMinutes === 60 ? 'selected' : ''}>60 minutes</option>
      </select>
    </div>
    <div class="pref-section">
      <label class="title">Impact level</label>
      <select class="pref-select" id="prefImpact">
        <option value="high_medium" ${alertImpact === 'high_medium' ? 'selected' : ''}>High + Medium</option>
        <option value="high" ${alertImpact === 'high' ? 'selected' : ''}>High only</option>
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
    <div class="pref-saved" id="prefSaved"></div>`;

  let emailOn = emailAlerts;
  $('prefEmailToggle').addEventListener('click', () => {
    emailOn = !emailOn;
    $('prefEmailToggle').classList.toggle('on', emailOn);
  });

  document.querySelectorAll('#prefCurrencies .chip').forEach(c => c.addEventListener('click', () => c.classList.toggle('active')));
  document.querySelectorAll('#prefCategories .chip').forEach(c => c.addEventListener('click', () => c.classList.toggle('active')));

  $('prefSave').addEventListener('click', async () => {
    const btn = $('prefSave');
    btn.disabled = true; btn.textContent = 'Saving…';

    const newEmail = $('prefEmail').value.trim();
    const chosenCurrencies = [...document.querySelectorAll('#prefCurrencies .chip.active')].map(c => c.dataset.val);
    const chosenCategories = [...document.querySelectorAll('#prefCategories .chip.active')].map(c => c.dataset.val);

    if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      $('prefSaved').textContent = '❌ Invalid email';
      $('prefSaved').style.color = '#ff6b6b';
      btn.disabled = false; btn.textContent = 'Save preferences';
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
      btn.disabled = false; btn.textContent = 'Save preferences';
    }
  });
}

// ── Init ──
(async function init() {
  renderAuthArea();
  await refreshAll();
  setInterval(refreshAll, 60000);
  setInterval(() => Auth.ensureFresh(), 60000);
})();
