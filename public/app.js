// ═══════════════════════════════════════════════════════════
//  app.js — Will's AI Frontend
// ═══════════════════════════════════════════════════════════

let allEvents = [];
let allNews = [];
let dayFilter = 'today';
let currencyFilter = 'all';
let watchlistOnly = false;
let newsCat = 'all';
let newsSearch = '';
let timezoneMode = localStorage.getItem('wills_timezone_mode') || 'utc';
let watchlist = [];
let autoScrollDone = false;
let lastLoadedAt = null;

const $ = id => document.getElementById(id);

const FLAGS = {
  USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵',
  AUD: '🇦🇺', NZD: '🇳🇿', CAD: '🇨🇦', CHF: '🇨🇭',
  CNY: '🇨🇳', ALL: '🌐',
};
function flag(code) { return FLAGS[(code || '').toUpperCase()] || '🏳️'; }

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

function formatCountdown(isoTimestamp) {
  if (!isoTimestamp) return '';
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) return '';
  const diffMs = d.getTime() - Date.now();
  const past = diffMs < 0;
  const abs = Math.abs(diffMs);
  const totalMin = Math.floor(abs / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  let text;
  if (days > 0) text = `${days}d ${hours}h`;
  else if (hours > 0) text = `${hours}h ${mins}m`;
  else text = `${mins}m`;
  return past ? `${text} ago` : `in ${text}`;
}

function getShortTimezoneLabel() {
  if (timezoneMode === 'utc') return 'UTC';
  try {
    const parts = new Date().toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ');
    const abbr = parts[parts.length - 1];
    return abbr && abbr.length <= 6 ? abbr : 'Local';
  } catch { return 'Local'; }
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

// ── Event key for watchlist ──
function eventKey(e) {
  return `${e.date}|${e.time}|${e.currency}|${e.event}`;
}

// ── Filter ──
function filterEvents(events) {
  let filtered = events;
  if (dayFilter === 'today') filtered = filtered.filter(e => isToday(e.date));
  else if (dayFilter === 'tomorrow') filtered = filtered.filter(e => isTomorrow(e.date));
  else if (dayFilter === 'week') filtered = filtered.filter(e => isThisWeek(e.date));
  if (currencyFilter !== 'all') {
    filtered = filtered.filter(e => (e.currency || '').toUpperCase() === currencyFilter);
  }
  if (watchlistOnly) {
    filtered = filtered.filter(e => watchlist.includes(eventKey(e)));
  }
  return filtered;
}

// ── Auto-scroll to last past event ──
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
      setTimeout(() => { lastPastRow.style.background = ''; }, 2400);
    }, 300);
    autoScrollDone = true;
  }
}

// ── Calendar render ──
function renderCalendar() {
  const tbody = $('tbody');
  const events = filterEvents(allEvents);

  if (!events.length) {
    let label = '';
    if (watchlistOnly) label = 'in your watchlist';
    else if (dayFilter === 'today') label = 'today';
    else if (dayFilter === 'tomorrow') label = 'tomorrow';
    else if (dayFilter === 'week') label = 'this week';
    tbody.innerHTML = `<tr><td colspan="4" class="empty">No events ${label}</td></tr>`;
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
    html += `<tr class="day"><td colspan="4">${esc(g.date)}${todayTag}</td></tr>`;

    for (const e of g.list) {
      const ik = impactKey(e.impact);
      const bm = (e.beatMiss || '').toLowerCase();
      const curFlag = flag(e.currency);
      const key = eventKey(e);
      const starred = watchlist.includes(key);

      let actualCls = 'val-actual';
      if (bm === 'beat') actualCls += ' beat';
      else if (bm === 'miss') actualCls += ' miss';

      const vals = [];
      if (e.actual && e.actual !== '—') vals.push(`<span class="${actualCls}">A ${esc(e.actual)}</span>`);
      if (e.forecast && e.forecast !== '—') vals.push(`<span class="val-forecast">F ${esc(e.forecast)}</span>`);
      if (e.previous && e.previous !== '—') vals.push(`<span class="val-previous">P ${esc(e.previous)}</span>`);
      const countdown = e.timestamp ? formatCountdown(e.timestamp) : '';
      if (countdown) vals.push(`<span class="countdown">${esc(countdown)}</span>`);

      const displayTime = e.timestamp ? formatTimeInMode(e.timestamp) : (e.time || '—');
      const starHTML = starred ? '<span class="star-icon">⭐</span>' : '';

      html += `<tr class="event-row impact-${ik}${starred ? ' starred' : ''}" data-key="${esc(key)}">
        <td class="col-time">${esc(displayTime)}</td>
        <td class="col-ccy"><span class="flag">${curFlag}</span>${esc(e.currency || '—')}</td>
        <td class="col-imp"><span class="impact-dot ${ik}"></span></td>
        <td class="col-event">
          <div class="ev-name">${starHTML}${esc(e.event || '')}</div>
          ${vals.length ? `<div class="ev-vals">${vals.join('')}</div>` : ''}
        </td>
      </tr>`;
    }
  }
  tbody.innerHTML = html;

  // Attach click handlers
  tbody.querySelectorAll('tr.event-row').forEach(row => {
    row.addEventListener('click', () => {
      const key = row.dataset.key;
      const ev = allEvents.find(e => eventKey(e) === key);
      if (ev) openEventModal(ev);
    });
  });

  setTimeout(autoScrollToLastPast, 100);
}

function renderStats() {
  const filtered = filterEvents(allEvents);
  $('statTotal').textContent = filtered.length;
  $('statHigh').textContent = filtered.filter(e => impactKey(e.impact) === 'high').length;
  $('statMedium').textContent = filtered.filter(e => impactKey(e.impact) === 'medium').length;
}

// ── Last updated ──
function updateLastUpdated() {
  const el = $('lastUpdated');
  if (!el || !lastLoadedAt) return;
  const seconds = Math.floor((Date.now() - lastLoadedAt) / 1000);
  if (seconds < 60) el.textContent = `⚡ live`;
  else if (seconds < 3600) el.textContent = `${Math.floor(seconds/60)}m ago`;
  else el.textContent = `${Math.floor(seconds/3600)}h ago`;
}

// ── News render (with ad injection) ──
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
  const cards = [];
  items.forEach((n, i) => {
    const date = n.pubDate ? new Date(n.pubDate).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    }) : '';
    cards.push(`<div class="news-card">
      <h3><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a></h3>
      ${n.snippet ? `<p>${esc(n.snippet)}</p>` : ''}
      <div class="news-meta">
        <span class="news-tag ${esc(n.category)}">${esc(n.category)}</span>
        <span>${esc(date)}</span>
      </div>
    </div>`);

    // Inject ad slot every 5 articles
    if ((i + 1) % 5 === 0) {
      cards.push(`<div class="ad-slot ad-slot-news"><span>Ad space · available</span></div>`);
    }
  });
  grid.innerHTML = counter + cards.join('');
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
    lastLoadedAt = Date.now();
    updateLastUpdated();
  } catch (err) {
    $('tbody').innerHTML = `<tr><td colspan="4" class="empty">Failed: ${esc(err.message)}</td></tr>`;
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

// ── Filter handlers ──
document.querySelectorAll('[data-day]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-day]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    dayFilter = btn.dataset.day;
    watchlistOnly = false;
    $('watchlistBtn').classList.remove('active');
    autoScrollDone = false;
    renderCalendar();
    renderStats();
  });
});

$('watchlistBtn')?.addEventListener('click', () => {
  watchlistOnly = !watchlistOnly;
  $('watchlistBtn').classList.toggle('active', watchlistOnly);
  autoScrollDone = false;
  renderCalendar();
  renderStats();
});

document.querySelectorAll('[data-cur]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-cur]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currencyFilter = btn.dataset.cur;
    autoScrollDone = false;
    renderCalendar();
    renderStats();
    saveCurrencyFilterToProfile();
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

// ── Save currency filter ──
let saveFilterTimeout = null;
function saveCurrencyFilterToProfile() {
  if (!Auth.isLoggedIn) return;
  if (saveFilterTimeout) clearTimeout(saveFilterTimeout);
  saveFilterTimeout = setTimeout(async () => {
    try { await Auth.updateProfile({ currency_filter: currencyFilter }); }
    catch (e) { console.warn('filter save failed:', e.message); }
  }, 800);
}

// ── Watchlist toggle ──
async function toggleWatchlist(ev) {
  if (!Auth.isLoggedIn) {
    alert('Log in to use watchlist');
    return;
  }
  const key = eventKey(ev);
  const idx = watchlist.indexOf(key);
  if (idx >= 0) watchlist.splice(idx, 1);
  else watchlist.push(key);

  try {
    await Auth.updateProfile({ watchlist });
    const p = Auth.profile || {};
    p.watchlist = watchlist;
    Auth.saveProfile(p);
  } catch (e) {
    console.warn('watchlist save failed:', e.message);
  }

  renderCalendar();
}

// ── Event modal ──
function openEventModal(ev) {
  const modal = $('eventModal');
  const content = $('eventModalContent');
  const ik = impactKey(ev.impact);
  const bm = (ev.beatMiss || '').toLowerCase();
  const key = eventKey(ev);
  const starred = watchlist.includes(key);
  const curFlag = flag(ev.currency);

  let actualCls = '';
  if (bm === 'beat') actualCls = 'beat';
  else if (bm === 'miss') actualCls = 'miss';

  const localTime = ev.timestamp ? formatTimeInMode(ev.timestamp) : (ev.time || '—');
  const countdown = ev.timestamp ? formatCountdown(ev.timestamp) : '';

  content.innerHTML = `
    <div class="detail-header">
      <span class="flag">${curFlag}</span>
      <span class="cur">${esc(ev.currency || '')}</span>
      <span class="detail-badge ${ik}">${ik}</span>
    </div>
    <div class="detail-title">${esc(ev.event || '')}</div>
    <div class="detail-time">${esc(ev.date || '')} · ${esc(localTime)}${countdown ? ` · ${esc(countdown)}` : ''}</div>

    <div class="detail-values">
      <div class="detail-value">
        <div class="lbl">Actual</div>
        <div class="val ${actualCls}">${esc(ev.actual || '—')}</div>
      </div>
      <div class="detail-value">
        <div class="lbl">Forecast</div>
        <div class="val forecast">${esc(ev.forecast || '—')}</div>
      </div>
      <div class="detail-value">
        <div class="lbl">Previous</div>
        <div class="val previous">${esc(ev.previous || '—')}</div>
      </div>
    </div>

    <div class="detail-actions">
      <button class="detail-btn" id="modalStar">${starred ? '⭐ Starred' : '☆ Add to watchlist'}</button>
      <button class="detail-btn primary" id="modalShare">📤 Share</button>
    </div>
  `;

  modal.classList.add('open');

  $('modalStar').addEventListener('click', async () => {
    await toggleWatchlist(ev);
    const stillStarred = watchlist.includes(key);
    $('modalStar').textContent = stillStarred ? '⭐ Starred' : '☆ Add to watchlist';
  });

  $('modalShare').addEventListener('click', () => shareEvent(ev));
}

function closeEventModal() {
  $('eventModal').classList.remove('open');
}

$('eventModalClose').addEventListener('click', closeEventModal);
$('eventModal').addEventListener('click', (e) => {
  if (e.target.id === 'eventModal') closeEventModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeEventModal();
});

// ── Share ──
async function shareEvent(ev) {
  const flagEmoji = flag(ev.currency);
  const time = ev.timestamp ? formatTimeInMode(ev.timestamp) : (ev.time || '');
  const parts = [
    `${flagEmoji} ${ev.currency} — ${ev.event}`,
    `${ev.date || ''} ${time}`.trim(),
  ];
  if (ev.actual) parts.push(`Actual: ${ev.actual}${ev.beatMiss ? ` (${ev.beatMiss})` : ''}`);
  if (ev.forecast) parts.push(`Forecast: ${ev.forecast}`);
  if (ev.previous) parts.push(`Previous: ${ev.previous}`);
  parts.push('via Will\'s AI');

  const text = parts.join('\n');
  const url = 'https://wills-ai-9mt4.onrender.com';

  if (navigator.share) {
    try {
      await navigator.share({ title: `${ev.currency} ${ev.event}`, text, url });
    } catch {}
  } else {
    try {
      await navigator.clipboard.writeText(text + '\n' + url);
      alert('Copied to clipboard!');
    } catch {
      prompt('Copy this:', text + '\n' + url);
    }
  }
}

// ── Timezone toggle ──
function updateTzButton() {
  const btn = $('tzToggle');
  if (!btn) return;
  btn.textContent = `🌍 ${getShortTimezoneLabel()}`;
}

$('tzToggle')?.addEventListener('click', () => {
  timezoneMode = timezoneMode === 'utc' ? 'local' : 'utc';
  localStorage.setItem('wills_timezone_mode', timezoneMode);
  updateTzButton();
  autoScrollDone = false;
  renderCalendar();
});

// ── Auth ──
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
    applyProfilePreferences();
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
    applyProfilePreferences();
    closeAuth();
  } catch (err) {
    errEl.textContent = err.message; errEl.classList.add('show');
  } finally {
    btn.disabled = false; btn.textContent = 'Log in';
  }
});

function applyProfilePreferences() {
  const p = Auth.profile;
  if (!p) return;
  const saved = p.currency_filter || 'all';
  if (saved !== currencyFilter) {
    currencyFilter = saved;
    document.querySelectorAll('[data-cur]').forEach(b => {
      b.classList.toggle('active', b.dataset.cur === saved);
    });
  }
  watchlist = Array.isArray(p.watchlist) ? p.watchlist : [];
  renderCalendar();
  renderStats();
}

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
  $('menuLogout').addEventListener('click', () => {
    Auth.logout();
    renderAuthArea();
    currencyFilter = 'all';
    watchlist = [];
    document.querySelectorAll('[data-cur]').forEach(b => {
      b.classList.toggle('active', b.dataset.cur === 'all');
    });
    renderCalendar();
    renderStats();
  });
}

// ── Preferences panel ──
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
      <label class="title">Currencies to alert on</label>
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
  if (Auth.isLoggedIn) await Auth.ensureFresh();
  updateTzButton();
  renderAuthArea();
  applyProfilePreferences();
  await refreshAll();
  setInterval(refreshAll, 60000);
  setInterval(() => Auth.ensureFresh(), 60000);
  setInterval(() => { if (dayFilter !== 'all') renderCalendar(); }, 30000);
  setInterval(updateLastUpdated, 30000);
})();
