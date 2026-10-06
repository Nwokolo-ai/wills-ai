const BiquoteModule = require('biquote');
const Biquote = BiquoteModule.Biquote || BiquoteModule.default || BiquoteModule;
const { admin } = require('./db');

const MODE = process.env.MODE || 'scrape';

let nextTimer = null;

function parseNumber(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/[^\d.\-]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function beatMiss(actual, forecast) {
  const a = parseNumber(actual);
  const f = parseNumber(forecast);
  if (a == null || f == null) return null;
  if (a > f) return 'BEAT';
  if (a < f) return 'MISS';
  return 'IN_LINE';
}

function normalizeImpact(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'high') return 'high';
  if (v === 'medium') return 'medium';
  if (v === 'low') return 'low';
  return 'none';
}

function toIsoDate(isoTime) {
  if (!isoTime) return null;
  const d = new Date(isoTime);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function toTimeString(isoTime) {
  if (!isoTime) return '';
  const d = new Date(isoTime);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' })
    .toLowerCase().replace(/\s+/g, '');
}

function makeKey(isoTime, currency, name) {
  const t = (isoTime || '').toLowerCase();
  const c = (currency || '').toLowerCase();
  const n = (name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${t}|${c}|${n}`;
}

async function fetchBiquote(weeksAhead = 2) {
  const bq = new Biquote();
  const now = new Date();
  const from = now.toISOString().slice(0, 10);
  const to = new Date(now.getTime() + weeksAhead * 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  console.log(`[ff] biquote fetch ${from} → ${to}`);
  const events = await bq.calendar({ from, to, limit: 500 });
  if (!Array.isArray(events)) throw new Error('biquote non-array');
  console.log(`[ff] biquote returned ${events.length} events`);
  return events;
}

function toDbRow(e) {
  const isoTime = e.time || null;
  const name = (e.name || '').trim();
  const currency = (e.currency || '').toUpperCase().trim();
  return {
    event_key: makeKey(isoTime, currency, name),
    event_date: toIsoDate(isoTime),
    event_time: toTimeString(isoTime),
    event_timestamp: isoTime,
    currency,
    impact: normalizeImpact(e.importance),
    title: name,
    actual: e.actual != null ? String(e.actual) : null,
    forecast: e.forecast != null ? String(e.forecast) : null,
    previous: e.previous != null ? String(e.previous) : null,
    beat_miss: beatMiss(e.actual, e.forecast),
    source: e.source || 'biquote',
    updated_at: new Date().toISOString(),
  };
}

async function pushToSupabase(rows) {
  if (!rows.length) return;
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await admin.from('calendar_events').upsert(batch, { onConflict: 'event_key' });
    if (error) throw new Error('Upsert failed: ' + error.message);
  }
}

async function scrape() {
  if (MODE === 'read') { console.log('[ff] MODE=read — skip'); return; }
  const t0 = Date.now();
  try {
    const events = await fetchBiquote(2);
    if (!events.length) return;

    const allRows = events.map(toDbRow);
    const rowMap = new Map();
    for (const row of allRows) {
      const existing = rowMap.get(row.event_key);
      if (!existing) rowMap.set(row.event_key, row);
      else if (row.actual && !existing.actual) rowMap.set(row.event_key, row);
    }
    const deduped = [...rowMap.values()];

    const validRows = deduped.filter(r => {
      if (!r.event_key || r.event_key.length < 8) return false;
      if (!r.event_date) return false;
      if (!r.currency || r.currency.length < 3) return false;
      if (!r.title || r.title.length < 2) return false;
      if (!/^[A-Z]{2,4}$/.test(r.currency) && r.currency !== 'ALL') return false;
      return true;
    });

    console.log(`[ff] ${validRows.length} valid rows (from ${allRows.length})`);
    await pushToSupabase(validRows);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`[ff] pushed ${validRows.length} events → Supabase — ${elapsed}s`);

    scheduleNextRefresh();
  } catch (err) {
    console.error('[ff] error:', err.message);
  }
}

// ── Auto-refresh timer: fire 1 second after the next event ──
async function scheduleNextRefresh() {
  if (nextTimer) clearTimeout(nextTimer);
  if (MODE === 'read') return;

  try {
    const nowIso = new Date().toISOString();
    const { data } = await admin.from('calendar_events')
      .select('event_timestamp, title, currency')
      .is('actual', null)
      .gt('event_timestamp', nowIso)
      .order('event_timestamp', { ascending: true })
      .limit(1);

    if (!data?.length) return;
    const next = data[0];
    const targetMs = new Date(next.event_timestamp).getTime() + 1000;
    const delay = targetMs - Date.now();

    if (delay < 0 || delay > 24 * 3600 * 1000) return;

    console.log(`[ff] next refresh for ${next.currency} ${next.title} in ${Math.round(delay / 60000)} min`);

    nextTimer = setTimeout(() => {
      console.log('[ff] timer fired — refreshing to grab actual');
      scrape();
    }, delay);
  } catch (err) {
    console.error('[ff] schedule error:', err.message);
  }
}

async function cleanup() {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await admin.from('calendar_events').delete().lt('event_date', cutoff);
  console.log(`[ff] cleanup: removed events before ${cutoff}`);
}

module.exports = { scrape, cleanup, scheduleNextRefresh };
