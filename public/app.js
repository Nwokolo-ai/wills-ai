if (window.Telegram && window.Telegram.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand(); 
  window.Telegram.WebApp.setHeaderColor('#0d1117');
}

let allEvents = [], allNews = [], dayFilter = 'today', currencyFilter = 'all';
let calendarSearch = '', watchlistOnly = false, newsCat = 'all', newsSearch = '';
let timezoneMode = localStorage.getItem('wills_timezone_mode_v2') || 'local';
let watchlist = [], autoScrollDone = false, lastLoadedAt = null, tickerInterval = null;
let hasPlayedSound = new Set(), resetToken = null, currentContext = 'price';

const $ = id => document.getElementById(id);
const FLAGS = {
  USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', AUD: '🇦🇺', NZD: '🇳🇿', 
  CAD: '🇨🇦', CHF: '🇨🇭', CNY: '🇨🇳', KRW: '🇰🇷', MYR: '🇲🇾', 
  RON: '🇷🇴', TRY: '🇹🇷', HUF: '🇭🇺', PLN: '🇵🇱', HKD: '🇭🇰', 
  BGN: '🇧🇬', CZK: '🇨🇿', INR: '🇮🇳', BRL: '🇧🇷', KZT: '🇰🇿', 
  RUB: '🇷🇺', DIN: '🇷🇸', ZAR: '🇿🇦', ILS: '🇮🇱', ALL: '🌐',
};
function flag(code) { return FLAGS[(code || '').toUpperCase()] || '🏳️'; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]); }
function impactKey(i) { const k = (i || '').toLowerCase(); return ['high','medium','low'].includes(k) ? k : 'none'; }

function parseEventDate(dateStr) {
  if (!dateStr) return null;
  const clean = String(dateStr).trim().replace(/\s+/g, ' ').replace(/^[A-Za-z]+,\s*/, '');
  const d = new Date(`${clean} ${new Date().getFullYear()}`);
  return isNaN(d.getTime()) ? new Date(clean) : d;
}
function dateKey(dateStr) {
  const d = parseEventDate(dateStr); if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function todayKey(offset = 0) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function isToday(s) { return dateKey(s) === todayKey(0); }
function isTomorrow(s) { return dateKey(s) === todayKey(1); }
function isThisWeek(s) {
  const d = parseEventDate(s); if (!d) return false;
  const start = new Date(); start.setDate(start.getDate() - start.getDay()); start.setHours(0,0,0,0);
  const end = new Date(start); end.setDate(start.getDate() + 7);
  return d >= start && d < end;
}
function formatCountdown(iso) {
  if (!iso) return ''; const d = new Date(iso); if (isNaN(d.getTime())) return '';
  const diff = d.getTime() - Date.now(), abs = Math.abs(diff), past = diff < 0;
  const tot = Math.floor(abs / 60000), days = Math.floor(tot / 1440), hrs = Math.floor((tot % 1440) / 60), mins = tot % 60, secs = Math.floor((abs % 60000) / 1000);
  let t = days > 0 ? `${days}d ${hrs}h` : hrs > 0 ? `${hrs}h ${mins}m` : mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  return past ? `${t} ago` : `in ${t}`;
}
function getDeviation(actual, forecast) {
  if (!actual || !forecast) return null;
  const a = parseFloat(String(actual).replace(/[^\d.-]/g, '')), f = parseFloat(String(forecast).replace(/[^\d.-]/g, ''));
  if (isNaN(a) || isNaN(f) || f === 0) return null;
  const diff = ((a - f) / Math.abs(f)) * 100;
  if (Math.abs(diff) < 0.1) return null;
  return `<span style="color: ${diff > 0 ? 'var(--beat)' : 'var(--miss)'}; font-weight: 700; font-size: 10px; margin-left: 4px;">${diff > 0 ? '+' : ''}${diff.toFixed(1)}%</span>`;
}
function getTimezoneOffsetString() {
  if (timezoneMode === 'utc') return '+0';
  const o = -new Date().getTimezoneOffset(), s = o >= 0 ? '+' : '-', abs = Math.abs(o);
  return Math.floor(abs/60) === 0 ? `${s}0` : (abs%60===0 ? `${s}${Math.floor(abs/60)}` : `${s}${Math.floor(abs/60)}:${String(abs%60).padStart(2,'0')}`);
}
function getTimezoneFullLabel() { return timezoneMode === 'utc' ? 'UTC' : `${new Date().toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop()} ${getTimezoneOffsetString()}`; }
function formatTimeInMode(iso, fb = '—') {
  if (!iso) return fb; const d = new Date(iso); if (isNaN(d.getTime())) return fb;
  return d.toLocaleTimeString(timezoneMode === 'utc' ? 'en-US' : undefined, { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezoneMode === 'utc' ? 'UTC' : undefined }).replace(/\s+/g, '').toLowerCase();
}

document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab-btn, .panel').forEach(el => el.classList.remove('active'));
  btn.classList.add('active'); $('panel-' + btn.dataset.tab).classList.add('active');
}));
function applyTheme(t) {
  document.body.dataset.theme = t;
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === t));
  localStorage.setItem('wills_theme', t);
}
document.querySelectorAll('.theme-btn').forEach(btn => btn.addEventListener('click', () => applyTheme(btn.dataset.theme)));
applyTheme(localStorage.getItem('wills_theme') || 'dark');

function eventKey(e) { return `${e.date}|${e.time}|${e.currency}|${e.event}`; }
function filterEvents(events) {
  let f = events;
  if (dayFilter === 'today') f = f.filter(e => isToday(e.date));
  else if (dayFilter === 'tomorrow') f = f.filter(e => isTomorrow(e.date));
  else if (dayFilter === 'week') f = f.filter(e => isThisWeek(e.date));
  if (currencyFilter !== 'all') f = f.filter(e => (e.currency || '').toUpperCase() === currencyFilter);
  if (calendarSearch) f = f.filter(e => (e.event || '').toLowerCase().includes(calendarSearch.toLowerCase()));
  if (watchlistOnly) f = f.filter(e => watchlist.includes(eventKey(e)));
  return f;
}

function autoScrollToLastPast() {
  if (autoScrollDone) return; const tbody = $('tbody'); if (!tbody) return;
  const now = Date.now(), rows = tbody.querySelectorAll('tr');
  let lastRow = null, lastTs = 0;
  for (const row of rows) {
    if (row.classList.contains('day')) continue;
    const tc = row.querySelector('.col-time'); if (!tc) continue;
    const tt = tc.querySelector('div')?.textContent.trim() || tc.textContent.trim();
    if (!/\d/.test(tt)) continue;
    let dl = '', p = row.previousElementSibling;
    while (p) { if (p.classList.contains('day')) { dl = p.textContent.replace('Today', '').trim(); break; } p = p.previousElementSibling; }
    if (!dl) continue; const parsed = parseEventDate(dl); if (!parsed) continue;
    const m = tt.match(/(\d+):(\d+)\s*(am|pm)/i); if (!m) continue;
    let h = parseInt(m[1]), min = parseInt(m[2]);
    if (m[3].toLowerCase() === 'pm' && h !== 12) h += 12; if (m[3].toLowerCase() === 'am' && h === 12) h = 0;
    parsed.setHours(h, min, 0, 0); const ts = parsed.getTime();
    if (ts <= now && ts > lastTs) { lastTs = ts; lastRow = row; }
  }
  if (lastRow) {
    setTimeout(() => {
      lastRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      lastRow.style.background = 'rgba(0, 245, 160, 0.14)';
      setTimeout(() => { lastRow.style.background = ''; }, 2400);
    }, 300); autoScrollDone = true;
  }
}

function renderCalendar() {
  const tbody = $('tbody'), events = filterEvents(allEvents);
  if (!events.length) { tbody.innerHTML = `<tr><td colspan="4" class="empty">No events found</td></tr>`; return; }
  const tSort = t => {
    const s = String(t || '').toLowerCase().trim();
    if (s.includes('all day')) return -1; if (s.includes('tentative')) return -0.5;
    const m = s.match(/(\d+):(\d+)\s*(am|pm)/); if (!m) return 9999;
    let h = parseInt(m[1]), min = parseInt(m[2]);
    if (m[3] === 'pm' && h !== 12) h += 12; if (m[3] === 'am' && h === 12) h = 0;
    return h * 60 + min;
  };
  const groups = [], seen = new Set();
  for (const e of events) { const k = e.date || '?'; if (!seen.has(k)) { seen.add(k); groups.push({ date: k, list: [] }); } groups[groups.length - 1].list.push(e); }
  groups.forEach(g => g.list.sort((a,b) => tSort(a.time) - tSort(b.time)));
  let html = '';
  for (const g of groups) {
    html += `<tr class="day"><td colspan="4">${esc(g.date)}${isToday(g.date) ? '<span class="today">Today</span>' : ''}</td></tr>`;
    for (const e of g.list) {
      const ik = impactKey(e.impact), bm = (e.beatMiss || '').toLowerCase(), key = eventKey(e), starred = watchlist.includes(key);
      let aCls = 'val-actual'; if (bm === 'beat') aCls += ' beat'; else if (bm === 'miss') aCls += ' miss';
      const vals = [];
      if (e.actual && e.actual !== '—') vals.push(`<span class="${aCls}">A ${esc(e.actual)} ${getDeviation(e.actual, e.forecast) || ''}</span>`);
      if (e.forecast && e.forecast !== '—') vals.push(`<span class="val-forecast">F ${esc(e.forecast)}</span>`);
      if (e.previous && e.previous !== '—') vals.push(`<span class="val-previous">P ${esc(e.previous)}</span>`);
      const cd = e.timestamp ? formatCountdown(e.timestamp) : '';
      if (cd) vals.push(`<span class="countdown" data-ts="${e.timestamp}">${esc(cd)}</span>`);
      html += `<tr class="event-row impact-${ik}${starred ? ' starred' : ''}" data-key="${esc(key)}">
        <td class="col-time"><div>${esc(e.timestamp ? formatTimeInMode(e.timestamp) : (e.time || '—'))}</div><div class="tz-badge">${timezoneMode === 'utc' ? 'UTC' : getTimezoneOffsetString()}</div></td>
        <td class="col-ccy"><span class="flag">${flag(e.currency)}</span>${esc(e.currency || '—')}</td>
        <td class="col-imp"><span class="impact-dot ${ik}"></span></td>
        <td class="col-event"><div class="ev-name">${starred ? '<span class="star-icon">⭐</span>' : ''}${esc(e.event || '')}</div>${vals.length ? `<div class="ev-vals">${vals.join('')}</div>` : ''}</td>
      </tr>`;
    }
  }
  tbody.innerHTML = html;
  tbody.querySelectorAll('tr.event-row').forEach(row => row.addEventListener('click', () => {
    const ev = allEvents.find(e => eventKey(e) === row.dataset.key); if (ev) openEventModal(ev);
  }));
  setTimeout(autoScrollToLastPast, 100);
}

function startTicker() {
  if (tickerInterval) clearInterval(tickerInterval);
  tickerInterval = setInterval(() => {
    document.querySelectorAll('.countdown').forEach(el => {
      const ts = el.getAttribute('data-ts'); if (!ts) return;
      const txt = formatCountdown(ts); el.textContent = txt;
      if ((txt === '0s' || txt.startsWith('0s ago')) && !hasPlayedSound.has(ts)) { hasPlayedSound.add(ts); playSound(); }
    });
  }, 1000);
}
function playSound() { try { const a = $('alertSound'); if (a) { a.volume = 0.5; a.play().catch(()=>{}); } } catch (e) {} }
function renderStats() {
  const f = filterEvents(allEvents);
  $('statTotal').textContent = f.length; $('statHigh').textContent = f.filter(e => impactKey(e.impact) === 'high').length; $('statMedium').textContent = f.filter(e => impactKey(e.impact) === 'medium').length;
}
function updateLastUpdated() {
  const el = $('lastUpdated'); if (!el || !lastLoadedAt) return;
  const s = Math.floor((Date.now() - lastLoadedAt) / 1000);
  el.textContent = s < 60 ? `⚡ live` : s < 3600 ? `${Math.floor(s/60)}m ago` : `${Math.floor(s/3600)}h ago`;
}
function renderNews() {
  const grid = $('newsGrid'); let items = allNews.slice();
  if (newsCat !== 'all') items = items.filter(n => n.category === newsCat);
  if (newsSearch) items = items.filter(n => (n.title || '').toLowerCase().includes(newsSearch.toLowerCase()));
  if (!items.length) { grid.innerHTML = '<div class="empty">No news match</div>'; return; }
  grid.innerHTML = `<div class="news-counter">Showing ${items.length} of ${allNews.length} articles</div>` + items.map(n => `
    <div class="news-card">
      <h3><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a></h3>
      ${n.snippet ? `<p>${esc(n.snippet)}</p>` : ''}
      <div class="news-meta"><span class="news-tag ${esc(n.category)}">${esc(n.category)}</span><span>${n.pubDate ? new Date(n.pubDate).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</span></div>
    </div>`).join('');
}

async function loadCalendar() {
  try {
    const res = await fetch('/api/calendar'); if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json(); allEvents = data.events || [];
    renderStats(); renderCalendar(); startTicker(); lastLoadedAt = Date.now(); updateLastUpdated();
  } catch (err) { $('tbody').innerHTML = `<tr><td colspan="4" class="empty">Failed: ${esc(err.message)}</td></tr>`; }
}
async function loadNews() {
  try {
    const res = await fetch('/api/news'); if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json(); allNews = data.items || []; renderNews();
  } catch (err) { $('newsGrid').innerHTML = `<div class="empty">Failed: ${esc(err.message)}</div>`; }
}
async function refreshAll() { await Promise.all([loadCalendar(), loadNews()]); }

document.querySelectorAll('[data-day]').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('[data-day]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active'); dayFilter = btn.dataset.day; watchlistOnly = false;
  $('watchlistBtn')?.classList.remove('active'); autoScrollDone = false; renderCalendar(); renderStats();
}));
$('watchlistBtn')?.addEventListener('click', () => { watchlistOnly = !watchlistOnly; $('watchlistBtn').classList.toggle('active', watchlistOnly); autoScrollDone = false; renderCalendar(); renderStats(); });
document.querySelectorAll('[data-cur]').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('[data-cur]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active'); currencyFilter = btn.dataset.cur; autoScrollDone = false; renderCalendar(); renderStats();
}));
$('calendarSearch').addEventListener('input', e => { calendarSearch = e.target.value.trim(); renderCalendar(); renderStats(); });
document.querySelectorAll('[data-cat]').forEach(btn => btn.addEventListener('click', () => { document.querySelectorAll('[data-cat]').forEach(b => b.classList.remove('active')); btn.classList.add('active'); newsCat = btn.dataset.cat; renderNews(); }));
$('newsSearch').addEventListener('input', e => { newsSearch = e.target.value.trim(); renderNews(); });

async function toggleWatchlist(ev) {
  if (!Auth.isLoggedIn) { alert('Log in to use watchlist'); return; }
  const key = eventKey(ev), idx = watchlist.indexOf(key);
  if (idx >= 0) watchlist.splice(idx, 1); else watchlist.push(key);
  try { await Auth.updateProfile({ watchlist }); } catch (e) {} renderCalendar();
}
function openEventModal(ev) {
  const ik = impactKey(ev.impact), bm = (ev.beatMiss || '').toLowerCase(), key = eventKey(ev), starred = watchlist.includes(key);
  $('eventModalContent').innerHTML = `
    <div class="detail-header"><span class="flag">${flag(ev.currency)}</span><span class="cur">${esc(ev.currency || '')}</span><span class="detail-badge ${ik}">${ik}</span></div>
    <div class="detail-title">${esc(ev.event || '')}</div>
    <div class="detail-time">${esc(ev.date || '')} · ${esc(ev.timestamp ? formatTimeInMode(ev.timestamp) : (ev.time || '—'))}</div>
    <div class="detail-values">
      <div class="detail-value"><div class="lbl">Actual</div><div class="val ${bm === 'beat' ? 'beat' : bm === 'miss' ? 'miss' : ''}">${esc(ev.actual || '—')}</div></div>
      <div class="detail-value"><div class="lbl">Forecast</div><div class="val forecast">${esc(ev.forecast || '—')}</div></div>
      <div class="detail-value"><div class="lbl">Previous</div><div class="val previous">${esc(ev.previous || '—')}</div></div>
    </div>
    <div class="detail-actions"><button class="detail-btn" id="modalStar">${starred ? '⭐ Starred' : '☆ Add to watchlist'}</button><button class="detail-btn primary" id="modalShare">📤 Share</button></div>`;
  $('eventModal').classList.add('open');
  $('modalStar').addEventListener('click', async () => { await toggleWatchlist(ev); $('modalStar').textContent = watchlist.includes(key) ? '⭐ Starred' : '☆ Add to watchlist'; });
  $('modalShare').addEventListener('click', () => shareEvent(ev));
}
function closeEventModal() { $('eventModal').classList.remove('open'); }
$('eventModalClose').addEventListener('click', closeEventModal);
$('eventModal').addEventListener('click', (e) => { if (e.target.id === 'eventModal') closeEventModal(); });
async function shareEvent(ev) {
  const parts = [`${flag(ev.currency)} ${ev.currency} — ${ev.event}`, `${ev.date || ''} ${ev.time}`];
  if (ev.actual) parts.push(`Actual: ${ev.actual}`); if (ev.forecast) parts.push(`Forecast: ${ev.forecast}`);
  parts.push('via Will\'s AI'); const text = parts.join('\n'), url = 'https://wills-ai-9mt4.onrender.com';
  if (navigator.share) { try { await navigator.share({ title: `${ev.currency} ${ev.event}`, text, url }); } catch {} } 
  else { try { await navigator.clipboard.writeText(text + '\n' + url); alert('Copied!'); } catch { prompt('Copy:', text + '\n' + url); } }
}
$('tzToggle')?.addEventListener('click', () => { timezoneMode = timezoneMode === 'utc' ? 'local' : 'utc'; localStorage.setItem('wills_timezone_mode_v2', timezoneMode); $('tzToggle').textContent = `🌍 ${getTimezoneFullLabel()}`; autoScrollDone = false; renderCalendar(); });

// AUTH
const authPanel = $('authPanel'), authOverlay = $('authOverlay'), authArea = $('authArea'), prefPanel = $('prefPanel');
function openAuth(v = 'login') { authPanel.classList.add('open'); authOverlay.classList.add('open'); showAuthView(v); }
function closeAuth() { authPanel.classList.remove('open'); authOverlay.classList.remove('open'); }
function showAuthView(v) { document.querySelectorAll('.auth-view').forEach(el => el.classList.remove('active')); $('view' + v.charAt(0).toUpperCase() + v.slice(1)).classList.add('active'); }
$('authClose').addEventListener('click', closeAuth); authOverlay.addEventListener('click', () => { closeAuth(); closePrefs(); });
$('toSignup').addEventListener('click', () => showAuthView('signup')); $('toLogin').addEventListener('click', () => showAuthView('login'));
$('toForgot').addEventListener('click', () => showAuthView('forgot')); $('backToLogin').addEventListener('click', () => showAuthView('login'));

function checkUrlForResetToken() {
  const hash = window.location.hash;
  if (hash && hash.includes('type=recovery')) {
    const params = new URLSearchParams(hash.substring(1)); resetToken = params.get('access_token');
    if (resetToken) { openAuth('reset'); window.history.replaceState(null, null, window.location.pathname); }
  }
}
$('formForgot').addEventListener('submit', async e => {
  e.preventDefault(); const err = $('forgotError'), suc = $('forgotSuccess'), btn = $('forgotSubmit');
  err.classList.remove('show'); suc.classList.remove('show'); btn.disabled = true; btn.textContent = 'Sending…';
  try { await Auth.forgotPin($('forgotUsername').value.trim()); suc.textContent = 'Reset link sent!'; suc.classList.add('show'); }
  catch (e) { err.textContent = e.message; err.classList.add('show'); } finally { btn.disabled = false; btn.textContent = 'Send Reset Link'; }
});
$('formReset').addEventListener('submit', async e => {
  e.preventDefault(); const err = $('resetError'), btn = $('resetSubmit'); err.classList.remove('show'); btn.disabled = true; btn.textContent = 'Saving…';
  try { if (!resetToken) throw new Error('Missing token.'); await Auth.resetPin(resetToken, $('resetPin').value.trim()); alert('PIN reset!'); closeAuth(); showAuthView('login'); }
  catch (e) { err.textContent = e.message; err.classList.add('show'); } finally { btn.disabled = false; btn.textContent = 'Save New PIN'; }
});
$('formSignup').addEventListener('submit', async e => {
  e.preventDefault(); const err = $('signupError'), btn = $('signupSubmit'); err.classList.remove('show'); btn.disabled = true; btn.textContent = 'Creating…';
  try { await Auth.signup($('signupUsername').value.trim(), $('signupPin').value.trim(), $('signupEmail').value.trim()); renderAuthArea(); closeAuth(); }
  catch (e) { err.textContent = e.message; err.classList.add('show'); } finally { btn.disabled = false; btn.textContent = 'Create account'; }
});
$('formLogin').addEventListener('submit', async e => {
  e.preventDefault(); const err = $('loginError'), btn = $('loginSubmit'); err.classList.remove('show'); btn.disabled = true; btn.textContent = 'Logging in…';
  try { await Auth.login($('loginUsername').value.trim(), $('loginPin').value.trim()); renderAuthArea(); closeAuth(); }
  catch (e) { err.textContent = e.message; err.classList.add('show'); } finally { btn.disabled = false; btn.textContent = 'Log in'; }
});

function renderAuthArea() {
  if (!Auth.isLoggedIn) { authArea.innerHTML = `<button class="btn-signin" id="btnSignin">Sign in</button>`; $('btnSignin').addEventListener('click', () => openAuth('login')); return; }
  const p = Auth.profile, initial = (p?.username || '?').charAt(0).toUpperCase();
  authArea.innerHTML = `
    <div style="position:relative">
      <div class="user-pill" id="userPill"><div class="user-avatar">${initial}</div><div class="user-name">${esc(p?.username || '')}</div></div>
      <div class="user-menu" id="userMenu"><div class="menu-header"><div class="name">${esc(p?.username || '')}</div></div><button id="menuPref" class="pref-btn">⚙️ Preferences</button><button id="menuLogout" class="danger">Log out</button></div>
    </div>`;
  $('userPill').addEventListener('click', () => $('userMenu').classList.toggle('open'));
  document.addEventListener('click', e => { const m = $('userMenu'), pi = $('userPill'); if (m && pi && !m.contains(e.target) && !pi.contains(e.target)) m.classList.remove('open'); });
  $('menuPref').addEventListener('click', () => { $('userMenu').classList.remove('open'); openPrefs(); });
  $('menuLogout').addEventListener('click', () => { Auth.logout(); renderAuthArea(); currencyFilter = 'all'; watchlist = []; document.querySelectorAll('[data-cur]').forEach(b => b.classList.toggle('active', b.dataset.cur === 'all')); renderCalendar(); renderStats(); });
}
function openPrefs() { if (!Auth.isLoggedIn) return; prefPanel.classList.add('open'); authOverlay.classList.add('open'); renderPrefs(); }
function closePrefs() { prefPanel.classList.remove('open'); authOverlay.classList.remove('open'); }
$('prefClose').addEventListener('click', closePrefs);

async function renderPrefs() {
  const content = $('prefContent'); content.innerHTML = '<div class="pref-loading">Loading…</div>';
  let profile; try { profile = await Auth.fetchProfile(); } catch (e) { content.innerHTML = `<div class="pref-loading">Failed: ${esc(e.message)}</div>`; return; }
  const p = profile || {}, c = new Set(p.currencies || ['USD','EUR','GBP']), ea = p.email_alerts !== false, am = p.alert_minutes || 15, ai = p.alert_impact || 'high_medium';
  content.innerHTML = `
    <div class="pref-section"><div class="pref-toggle"><span>📧 Email alerts</span><div class="switch ${ea ? 'on' : ''}" id="prefEmailToggle"></div></div></div>
    <div class="pref-section" style="text-align:center"><button class="pref-save" id="prefTestPush" style="background:var(--bg3);color:var(--text);border:1px solid var(--border)">🔔 Send Test Push</button><div id="pushTestResult" style="font-size:12px;margin-top:8px;color:var(--accent)"></div></div>
    <div class="pref-section"><label class="title">Alert minutes before</label><select class="pref-select" id="prefMinutes"><option value="5" ${am === 5 ? 'selected' : ''}>5 min</option><option value="15" ${am === 15 ? 'selected' : ''}>15 min</option><option value="30" ${am === 30 ? 'selected' : ''}>30 min</option><option value="60" ${am === 60 ? 'selected' : ''}>60 min</option></select></div>
    <div class="pref-section"><label class="title">Impact level</label><select class="pref-select" id="prefImpact"><option value="high_medium" ${ai === 'high_medium' ? 'selected' : ''}>High + Med</option><option value="high" ${ai === 'high' ? 'selected' : ''}>High only</option></select></div>
    <div class="pref-section"><label class="title">Currencies</label><div class="chip-grid" id="prefCurrencies">${['USD','EUR','GBP','JPY','AUD','NZD','CAD','CHF','CNY'].map(c => `<div class="chip ${c.has ? 'active' : ''}" data-val="${c}">${c}</div>`).join('')}</div></div>
    <button class="pref-save" id="prefSave">Save</button><div class="pref-saved" id="prefSaved"></div>`;
  let eOn = ea;
  $('prefEmailToggle').addEventListener('click', () => { eOn = !eOn; $('prefEmailToggle').classList.toggle('on', eOn); });
  document.querySelectorAll('#prefCurrencies .chip').forEach(c => c.addEventListener('click', () => c.classList.toggle('active')));
  $('prefTestPush').addEventListener('click', async () => {
    const r = $('pushTestResult'); r.textContent = 'Sending...';
    if (Notification.permission === 'default' && await Notification.requestPermission() !== 'granted') { r.textContent = '❌ Blocked'; return; }
    try { const res = await fetch('/api/push/test'); if (res.ok) { r.textContent = '✅ Sent!'; } else throw 0; } catch { r.textContent = '❌ Failed'; }
    setTimeout(() => r.textContent = '', 5000);
  });
  $('prefSave').addEventListener('click', async () => {
    const btn = $('prefSave'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await Auth.updateProfile({ email_alerts: eOn, alert_minutes: parseInt($('prefMinutes').value), alert_impact: $('prefImpact').value, currencies: [...document.querySelectorAll('#prefCurrencies .chip.active')].map(c => c.dataset.val) });
      $('prefSaved').textContent = '✅ Saved'; setTimeout(() => $('prefSaved').textContent = '', 3000);
    } catch (e) { $('prefSaved').textContent = '❌ ' + e.message; } finally { btn.disabled = false; btn.textContent = 'Save'; }
  });
}

// SIGNAL AI
document.querySelectorAll('.ctx-btn').forEach(btn => btn.addEventListener('click', () => { document.querySelectorAll('.ctx-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); currentContext = btn.dataset.ctx; }));
async function handleSignalRequest(symbol, customText = null) {
  if ($('signalSendBtn').disabled) return;
  const tf = $('signalTF').value; let text = customText || $('signalInput').value.trim();
  if (!text && !symbol) return; if (symbol && !customText) text = `Analyze ${symbol}`;
  $('signalChatMessages').insertAdjacentHTML('beforeend', `<div class="msg user">${esc(text)}</div>`);
  $('signalInput').value = ''; $('signalChatMessages').scrollTop = $('signalChatMessages').scrollHeight;
  $('orbArea').classList.add('shrink'); $('signalTyping').classList.add('show'); $('signalSendBtn').disabled = true;
  try {
    const res = await fetch('/api/signal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: symbol || "GENERAL", timeframe: tf, text, contextMode: currentContext }) });
    const data = await res.json(); if (!res.ok) throw new Error(data.error);
    $('signalTyping').classList.remove('show');
    $('signalChatMessages').insertAdjacentHTML('beforeend', `<div class="msg bot">${data.signal.replace(/\n/g,'<br>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\b(BUY)\b/g,'<span class="signal-buy">BUY</span>').replace(/\b(SELL)\b/g,'<span class="signal-sell">SELL</span>')}</div>`);
  } catch (e) {
    $('signalTyping').classList.remove('show');
    $('signalChatMessages').insertAdjacentHTML('beforeend', `<div class="msg bot" style="color:#ff6b6b">❌ ${esc(e.message)}</div>`);
  } finally { $('signalSendBtn').disabled = false; $('signalChatMessages').scrollTop = $('signalChatMessages').scrollHeight; }
}
document.querySelectorAll('.quick-symbols button').forEach(btn => btn.addEventListener('click', () => handleSignalRequest(btn.dataset.sym)));
$('signalSendBtn').addEventListener('click', () => handleSignalRequest(null));
$('signalInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSignalRequest(null); } });
$('signalBackBtn').addEventListener('click', () => document.querySelector('.tab-btn[data-tab="calendar"]').click());

// PWA
let deferredPrompt, swRegistration;
if ('serviceWorker' in navigator) window.addEventListener('load', async () => { try { swRegistration = await navigator.serviceWorker.register('/sw.js'); } catch (e) {} });
function canShowPwaBanner() { const d = localStorage.getItem('pwa_dismissed_at'); return !d || (Date.now() - parseInt(d)) > 3 * 24 * 3600 * 1000; }
function triggerPwaBanner() { if (!canShowPwaBanner() || window.navigator.standalone) return; setTimeout(() => { if (canShowPwaBanner() && !window.navigator.standalone) $('pwaBanner')?.classList.add('show'); }, 30000); }
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; triggerPwaBanner(); });
if (window.navigator.standalone !== true) { const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream; if (isIOS && canShowPwaBanner()) setTimeout(() => { const b = $('pwaBanner'); if (b) { b.querySelector('.pwa-install').textContent = 'How to install'; b.querySelector('.pwa-install').addEventListener('click', () => alert("1. Tap 'Share'\n2. 'Add to Home Screen'")); b.classList.add('show'); } }, 30000); }
$('pwaInstall')?.addEventListener('click', async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $('pwaBanner')?.classList.remove('show'); });
$('pwaDismiss')?.addEventListener('click', () => { localStorage.setItem('pwa_dismissed_at', String(Date.now())); $('pwaBanner')?.classList.remove('show'); });

(async function init() {
  checkUrlForResetToken(); if (Auth.isLoggedIn) await Auth.ensureFresh();
  $('tzToggle').textContent = `🌍 ${getTimezoneFullLabel()}`; renderAuthArea(); await refreshAll();
  setInterval(refreshAll, 60000); setInterval(updateLastUpdated, 30000);
})();
