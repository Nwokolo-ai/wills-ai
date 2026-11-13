// ── TELEGRAM MINI APP DETECTION ──
if (window.Telegram && window.Telegram.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand(); 
  window.Telegram.WebApp.setHeaderColor('#0d1117');
  window.Telegram.WebApp.setBackgroundColor('#0d1117');
}

let allEvents = [];
let allNews = [];
let dayFilter = 'today';
let currencyFilter = 'all';
let calendarSearch = '';
let watchlistOnly = false;
let newsCat = 'all';
let newsSearch = '';
let timezoneMode = localStorage.getItem('wills_timezone_mode_v2') || 'local';
let watchlist = [];
let autoScrollDone = false;
let lastLoadedAt = null;
let tickerInterval = null;
let hasPlayedSound = new Set();
let resetToken = null;

const $ = id => document.getElementById(id);

const FLAGS = {
  USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', AUD: '🇦🇺', NZD: '🇳🇿', 
  CAD: '🇨🇦', CHF: '🇨🇭', CNY: '🇨🇳', KRW: '🇰🇷', MYR: '🇲🇾', 
  RON: '🇷🇴', TRY: '🇹🇷', HUF: '🇭🇺', PLN: '🇵🇱', HKD: '🇭🇰', 
  BGN: '🇧🇬', CZK: '🇨🇿', INR: '🇮🇳', BRL: '🇧🇷', KZT: '🇰🇿', 
  RUB: '🇷🇺', DIN: '🇷🇸', ZAR: '🇿🇦', ILS: '🇮🇱', ALL: '🌐',
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
  const secs = Math.floor((abs % 60000) / 1000);
  
  let text;
  if (days > 0) text = `${days}d ${hours}h`;
  else if (hours > 0) text = `${hours}h ${mins}m`;
  else if (mins > 0) text = `${mins}m ${secs}s`;
  else text = `${secs}s`;
  
  return past ? `${text} ago` : `in ${text}`;
}

function getDeviation(actual, forecast) {
  if (!actual || !forecast) return null;
  const a = parseFloat(String(actual).replace(/[^\d.-]/g, ''));
  const f = parseFloat(String(forecast).replace(/[^\d.-]/g, ''));
  if (isNaN(a) || isNaN(f) || f === 0) return null;
  const diff = ((a - f) / Math.abs(f)) * 100;
  if (Math.abs(diff) < 0.1) return null;
  const sign = diff > 0 ? '+' : '';
  const color = diff > 0 ? 'var(--beat)' : 'var(--miss)';
  return `<span style="color: ${color}; font-weight: 700; font-size: 10px; margin-left: 4px;">${sign}${diff.toFixed(1)}%</span>`;
}

function getTimezoneOffsetString() {
  if (timezoneMode === 'utc') return '+0';
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `${sign}${h}` : `${sign}${h}:${String(m).padStart(2,'0')}`;
}

function getTimezoneFullLabel() {
  if (timezoneMode === 'utc') return 'UTC';
  try {
    const parts = new Date().toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ');
    const abbr = parts[parts.length - 1];
    return `${abbr} ${getTimezoneOffsetString()}`;
  } catch { return `Local ${getTimezoneOffsetString()}`; }
}

function formatTimeInMode(isoTimestamp, fallback = '—') {
  if (!isoTimestamp) return fallback;
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) return fallback;
  if (timezoneMode === 'utc') {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' }).replace(/\s+/g, '').toLowerCase();
  }
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s+/g, '').toLowerCase();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('panel-' + btn.dataset.tab).classList.add('active');
  });
});

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
  localStorage.setItem('wills_theme', theme);
}
document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
});
applyTheme(localStorage.getItem('wills_theme') || 'dark');

function eventKey(e) { return `${e.date}|${e.time}|${e.currency}|${e.event}`; }

function filterEvents(events) {
  let filtered = events;
  if (dayFilter === 'today') filtered = filtered.filter(e => isToday(e.date));
  else if (dayFilter === 'tomorrow') filtered = filtered.filter(e => isTomorrow(e.date));
  else if (dayFilter === 'week') filtered = filtered.filter(e => isThisWeek(e.date));
  
  if (currencyFilter !== 'all') filtered = filtered.filter(e => (e.currency || '').toUpperCase() === currencyFilter);
  if (calendarSearch) {
    const s = calendarSearch.toLowerCase();
    filtered = filtered.filter(e => (e.event || '').toLowerCase().includes(s));
  }
  if (watchlistOnly) filtered = filtered.filter(e => watchlist.includes(eventKey(e)));
  return filtered;
}

function renderCalendar() {
  const tbody = $('tbody');
  const events = filterEvents(allEvents);

  if (!events.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty">No events found</td></tr>`;
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
      if (e.actual && e.actual !== '—') {
        const dev = getDeviation(e.actual, e.forecast);
        vals.push(`<span class="${actualCls}">A ${esc(e.actual)} ${dev || ''}</span>`);
      }
      if (e.forecast && e.forecast !== '—') vals.push(`<span class="val-forecast">F ${esc(e.forecast)}</span>`);
      if (e.previous && e.previous !== '—') vals.push(`<span class="val-previous">P ${esc(e.previous)}</span>`);
      
      const countdown = e.timestamp ? formatCountdown(e.timestamp) : '';
      if (countdown) vals.push(`<span class="countdown" data-ts="${e.timestamp}">${esc(countdown)}</span>`);

      const displayTime = e.timestamp ? formatTimeInMode(e.timestamp) : (e.time || '—');
      const tzBadge = timezoneMode === 'utc' ? 'UTC' : getTimezoneOffsetString();
      const starHTML = starred ? '<span class="star-icon">⭐</span>' : '';

      html += `<tr class="event-row impact-${ik}${starred ? ' starred' : ''}" data-key="${esc(key)}">
        <td class="col-time"><div>${esc(displayTime)}</div><div class="tz-badge">${esc(tzBadge)}</div></td>
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

  tbody.querySelectorAll('tr.event-row').forEach(row => {
    row.addEventListener('click', () => {
      const key = row.dataset.key;
      const ev = allEvents.find(e => eventKey(e) === key);
      if (ev) openEventModal(ev);
    });
  });
}

function startTicker() {
  if (tickerInterval) clearInterval(tickerInterval);
  tickerInterval = setInterval(() => {
    document.querySelectorAll('.countdown').forEach(el => {
      const ts = el.getAttribute('data-ts');
      if (!ts) return;
      const text = formatCountdown(ts);
      el.textContent = text;
      if (text === '0s' || text.startsWith('0s ago')) {
        if (!hasPlayedSound.has(ts)) { hasPlayedSound.add(ts); playSound(); }
      }
    });
  }, 1000);
}

function playSound() {
  try { const audio = $('alertSound'); if (audio) { audio.volume = 0.5; audio.play().catch(e => {}); } } catch (e) {}
}

function renderStats() {
  const filtered = filterEvents(allEvents);
  $('statTotal').textContent = filtered.length;
  $('statHigh').textContent = filtered.filter(e => impactKey(e.impact) === 'high').length;
  $('statMedium').textContent = filtered.filter(e => impactKey(e.impact) === 'medium').length;
}

function updateLastUpdated() {
  const el = $('lastUpdated');
  if (!el || !lastLoadedAt) return;
  const seconds = Math.floor((Date.now() - lastLoadedAt) / 1000);
  if (seconds < 60) el.textContent = `⚡ live`;
  else if (seconds < 3600) el.textContent = `${Math.floor(seconds/60)}m ago`;
  else el.textContent = `${Math.floor(seconds/3600)}h ago`;
}

function renderNews() {
  const grid = $('newsGrid');
  let items = allNews.slice();
  if (newsCat !== 'all') items = items.filter(n => n.category === newsCat);
  if (newsSearch) {
    const s = newsSearch.toLowerCase();
    items = items.filter(n => (n.title || '').toLowerCase().includes(s));
  }
  if (!items.length) { grid.innerHTML = '<div class="empty">No news match</div>'; return; }

  const counter = `<div class="news-counter">Showing ${items.length} of ${allNews.length} articles</div>`;
  const cards = [];
  items.forEach((n, i) => {
    const date = n.pubDate ? new Date(n.pubDate).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    cards.push(`<div class="news-card">
      <h3><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a></h3>
      ${n.snippet ? `<p>${esc(n.snippet)}</p>` : ''}
      <div class="news-meta">
        <span class="news-tag ${esc(n.category)}">${esc(n.category)}</span>
        <span>${esc(date)}</span>
      </div>
    </div>`);
  });
  grid.innerHTML = counter + cards.join('');
}

async function loadCalendar() {
  try {
    const res = await fetch('/api/calendar');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allEvents = data.events || [];
    renderStats(); renderCalendar(); startTicker();
    lastLoadedAt = Date.now(); updateLastUpdated();
  } catch (err) { $('tbody').innerHTML = `<tr><td colspan="4" class="empty">Failed: ${esc(err.message)}</td></tr>`; }
}

async function loadNews() {
  try {
    const res = await fetch('/api/news');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allNews = data.items || [];
    renderNews();
  } catch (err) { $('newsGrid').innerHTML = `<div class="empty">Failed: ${esc(err.message)}</div>`; }
}

async function refreshAll() { await Promise.all([loadCalendar(), loadNews()]); }

// Signal AI Logic
let currentContext = 'price';
document.querySelectorAll('.ctx-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ctx-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentContext = btn.dataset.ctx;
  });
});

const signalInput = $('signalInput');
const signalSendBtn = $('signalSendBtn');
const signalChatMessages = $('signalChatMessages');
const signalTyping = $('signalTyping');
const orbArea = $('orbArea');

async function handleSignalRequest(symbol, customText = null) {
  if (signalSendBtn.disabled) return;
  const tf = $('signalTF').value;
  let userText = customText || signalInput.value.trim();
  if (!userText && !symbol) return;
  if (symbol && !customText) userText = `Analyze ${symbol}`;

  const userMsg = document.createElement('div');
  userMsg.className = 'msg user'; userMsg.textContent = userText;
  signalChatMessages.appendChild(userMsg);
  signalInput.value = ''; signalChatMessages.scrollTop = signalChatMessages.scrollHeight;

  orbArea.classList.add('shrink');
  signalTyping.classList.add('show');
  signalChatMessages.scrollTop = signalChatMessages.scrollHeight;
  signalSendBtn.disabled = true;

  try {
    const res = await fetch('/api/signal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: symbol || "GENERAL", timeframe: tf, text: userText, contextMode: currentContext })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    signalTyping.classList.remove('show');

    const botMsg = document.createElement('div');
    botMsg.className = 'msg bot';
    let formatted = data.signal.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\b(BUY)\b/g, '<span class="signal-buy">BUY</span>').replace(/\b(SELL)\b/g, '<span class="signal-sell">SELL</span>');
    botMsg.innerHTML = formatted; signalChatMessages.appendChild(botMsg);
  } catch (err) {
    signalTyping.classList.remove('show');
    const errMsg = document.createElement('div');
    errMsg.className = 'msg bot'; errMsg.style.color = '#ff6b6b'; errMsg.textContent = `❌ Error: ${err.message}`;
    signalChatMessages.appendChild(errMsg);
  } finally {
    signalSendBtn.disabled = false; signalChatMessages.scrollTop = signalChatMessages.scrollHeight;
  }
}

document.querySelectorAll('.quick-symbols button').forEach(btn => { btn.addEventListener('click', () => handleSignalRequest(btn.dataset.sym)); });
signalSendBtn.addEventListener('click', () => handleSignalRequest(null));
signalInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSignalRequest(null); } });
$('signalBackBtn').addEventListener('click', () => { document.querySelector('.tab-btn[data-tab="calendar"]').click(); });

// Auth & Prefs (Simplified for space, using your existing logic)
// Make sure your full auth code is still below here...

(async function init() {
  if (Auth.isLoggedIn) await Auth.ensureFresh();
  $('tzToggle').textContent = `🌍 ${getTimezoneFullLabel()}`;
  renderAuthArea();
  await refreshAll();
  setInterval(refreshAll, 60000);
  setInterval(updateLastUpdated, 30000);
})();
